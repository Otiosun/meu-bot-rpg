function isNoisySignalLog(args) {
    const message = String(args[0] || '');
    return message === 'Closing session:'
        || message.includes('Bad MAC')
        || message.includes('Decrypted message with closed session')
        || message.includes('Closing open session in favor of incoming prekey bundle')
        || message.includes('Failed to decrypt message with any known session');
}

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
    if (isNoisySignalLog(args)) return;
    originalConsoleError(...args);
};

const originalConsoleInfo = console.info.bind(console);
console.info = (...args) => {
    if (isNoisySignalLog(args)) return;
    originalConsoleInfo(...args);
};

const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args) => {
    if (isNoisySignalLog(args)) return;
    originalConsoleWarn(...args);
};

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    WAMessageStubType,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const { criarBanco } = require('./database');
const {
    closeDatabaseOnce,
    registerDatabase,
    retireDatabase,
    withDatabaseLease,
} = require('./helpers/clover/databaseLifecycleGuard');
const { ensureDeliverySchema, enqueueApprovalSweep } = require('./helpers/clover/deliveryService');
const { COMMAND_PREFIX } = require('./config/bot');
const { resolveCommand } = require('./helpers/commandRegistry');
const {
    checkCommandCooldown,
    getCriticalLockKey,
    renderCooldownMessage,
    renderLockedMessage,
    runWithCommandLock,
} = require('./helpers/commandGuards');
const { handlePrivateSendUpdate, sendReaction, sendReply } = require('./helpers/chatReply');
const { runPrivateDeliveryWorkerOnce } = require('./helpers/clover/privateDeliveryRuntimeHook');
const { logCurrentActivationCode } = require('./helpers/activationCode');
const { isGroupEnabled, isGroupReceptionEnabled, isOwner, isSameUser, normalizeJid, setGroupEnabled } = require('./helpers/groupAccess');
const { findImagePath, renderWelcomeMessage } = require('./helpers/onboardingFlow');
const {
    clearGroupMemberState,
    ensureOnboardingState,
    ensurePlayerRecord,
    getExistingOnboardingState,
    getGroupWelcomeState,
    markGroupWelcomeSent,
    markWelcomeSent,
    registerGroupJoin,
    touchGroupMember,
    updateOnboardingStep,
} = require('./helpers/playerRegistry');
const {
    clearPendingMagicConfirmation,
    confirmPendingMagicChoice,
    findMagicOption,
    findMagicOptions,
    getAllMagics,
    getAvailableMagicsForRoll,
    getBestRollForMagicPrompt,
    getMagicAvailability,
    getPendingMagicConfirmation,
    getRollsMatchingMagic,
    renderMagicCancelledMessage,
    renderMagicAmbiguousMessage,
    renderMagicChoicePrompt,
    renderMagicChosenMessage,
    renderMagicConfirmationMessage,
    renderMagicNotFoundMessage,
    renderMagicRarityBlockedMessage,
    renderMagicRollChoiceMessage,
    renderMagicUnavailableMessage,
    savePendingMagicConfirmation,
    setSelectedRollForMagic,
} = require('./helpers/magicManager');
const { getMessageText, isMagicReplyMessage } = require('./helpers/messageContext');
const { normalizeText } = require('./helpers/textUtils');
const { getPlayerRollByNumber, listPlayerRolls } = require('./helpers/rollManager');
const { clearWelcomeDebounce, shouldSendWelcome } = require('./helpers/welcomeDebounce');
const {
    analyzeProfileSubmission,
    looksLikeProfileSubmission,
    renderConfirmationSummary,
    renderValidationErrors,
    savePendingConfirmation,
} = require('./helpers/profileForms');
const {
    markProfileAppearancePending,
    saveAppearanceImageFromMessage,
    tryAttachAppearanceImage,
    tryHandleAppearanceReaction,
    tryHandleAppearanceReviewReply,
} = require('./helpers/clover/appearanceManager');
const {
    advanceSpellReviewQueueAfterRemoval,
    approvePendingOffGroupRequests,
    approvePendingSpellReviewRequests,
    getCloverGroup,
    getOffGroupWelcomeImagePath,
    isConfiguredCloverGroup,
    renderOffGroupWelcomeMessage,
    tryApproveOffGroupJoinRequests,
    tryApproveSpellReviewJoinRequests,
} = require('./helpers/clover/groupManager');
const {
    cancelPendingExitForReturn,
    createOrRefreshExitConfirmation,
    handleExitConfirmationReply,
    processExpiredExitConfirmations,
} = require('./helpers/clover/communityExitManager');
const {
    handleAntiGhostPrivateReply,
    markCommunityStatus,
    recordCommandActivity,
    recordMessageActivity,
    runAntiGhostSweep,
} = require('./helpers/clover/antiGhostService');
const { runWeeklyChecklistResetDispatch } = require('./helpers/clover/checklistService');
const {
    canUseCommandInPhase,
    getPlayerPhase,
    isPostFichaReceptionCommand,
    renderGameBlockedMessage,
} = require('./helpers/clover/playerPhase');
const {
    renderPostFichaReceptionBlockedMessage,
    renderUnknownCommandMessage,
} = require('./helpers/clover/playerMenuMessages');
const { syncArchiveCardForPlayer } = require('./helpers/clover/archiveManager');
const {
    looksLikeQuickEvaluation,
    tryHandleQuickEvaluation,
} = require('./helpers/clover/quickEvaluationService');
const { syncSquadGroupDescription } = require('./helpers/clover/squadService');
const { startSiteApiServer, stopSiteApiServer } = require('./helpers/clover/siteApiServer');
const { processDueEconomyOperations, processDueSalaries } = require('./helpers/clover/economyService');
const { processDueMarketOperations } = require('./helpers/clover/marketService');
const { runEconomyMutationExclusive } = require('./helpers/clover/economyMutationQueue');

const ECONOMY_COMMAND_SUFFIXES = new Set([
    'abrircaixa', 'anunciar', 'atualizar', 'caixas', 'comprar', 'divulga', 'extrato', 'itemadm',
    'lance', 'leilao', 'lojas', 'mercado', 'pedidos', 'pr', 'raid', 'reparar',
    'resgatar', 'saldo', 'salario', 'titulo', 'transferir', 'trocar', 'usar', 'vender',
]);

function isEconomyCommand(commandName) {
    const normalized = String(commandName || '').trim().toLowerCase();
    for (const suffix of ECONOMY_COMMAND_SUFFIXES) {
        if (normalized.endsWith(suffix)) return true;
    }
    return false;
}

const comandos = new Map();
const pastaComandos = path.join(__dirname, 'comandos');
const AUTH_INFO_DIR = path.join(__dirname, 'auth_info');
const runtimeClover = global.runtimeClover || {
    geracao: 0,
    iniciando: false,
    encerrando: false,
    reconnectTimer: null,
    exitSweepTimer: null,
    antiGhostSweepTimer: null,
    weeklyChecklistTimer: null,
    economySweepTimer: null,
    dbAtivo: null,
    sockAtivo: null,
    siteApiServer: null,
    pvReachoutLock: null,
};
global.runtimeClover = runtimeClover;

function limparTimerReconexao() {
    if (!runtimeClover.reconnectTimer) return;
    clearTimeout(runtimeClover.reconnectTimer);
    runtimeClover.reconnectTimer = null;
}

async function fecharDbSeguro(db) {
    if (!db || typeof db.close !== 'function') return;
    try {
        await closeDatabaseOnce(db);
    } catch (error) {
        console.log('[boot] Nao consegui fechar DB antigo:', error?.message || error);
    }
}

async function aposentarDbSeguro(db, contexto = 'substituido', timeoutMs = 30000) {
    if (!db || typeof db.close !== 'function') return;
    try {
        const result = await retireDatabase(db, { timeoutMs });
        if (result?.forced) {
            console.log('[boot] DB ' + contexto + ' fechado por timeout com operacoes pendentes.');
        }
    } catch (error) {
        console.log('[boot] Nao consegui aposentar DB ' + contexto + ':', error?.message || error);
    }
}

function limparTimerChecklistSemanal() {
    if (!runtimeClover.weeklyChecklistTimer) return;
    clearInterval(runtimeClover.weeklyChecklistTimer);
    runtimeClover.weeklyChecklistTimer = null;
}

function limparTimerEconomia() {
    if (!runtimeClover.economySweepTimer) return;
    clearInterval(runtimeClover.economySweepTimer);
    runtimeClover.economySweepTimer = null;
}

async function varrerEconomiaSeguro(db, contexto = 'agendado') {
    const medirEtapa = async (etapa, executar) => {
        const inicio = Date.now();
        try {
            return await executar();
        } finally {
            const duracaoMs = Date.now() - inicio;
            console.log(`[economia] etapa=${etapa}; contexto=${contexto}; duracaoMs=${duracaoMs}`);
        }
    };

    try {
        const { market, payroll } = await runEconomyMutationExclusive(async () => {
            await medirEtapa('operacoes', () => processDueEconomyOperations(db));
            const marketResult = await medirEtapa('mercado', () => processDueMarketOperations(db));
            const payrollResult = await medirEtapa('salarios', () => processDueSalaries(db));
            return { market: marketResult, payroll: payrollResult };
        });

        if (payroll.paid) {
            console.log(`[economia] ${contexto}: salarios pagos=${payroll.paid}; semana=${payroll.weekKey}`);
        }

        return { ok: true, payroll, market };
    } catch (error) {
        console.log(`[economia] falha na varredura (${contexto}):`, error?.message || error);
        return { ok: false, error: error?.message || String(error) };
    }
}

async function dispararChecklistSemanalSeguro(db, contexto = 'agendado') {
    if (process.env.CLOVER_WEEKLY_CHECKLIST_AUTO_PV !== '1') {
        if (contexto === 'abertura') {
            console.log('[checklist] PV semanal automatico desativado. Use CLOVER_WEEKLY_CHECKLIST_AUTO_PV=1 para reativar.');
        }
        return { ok: true, skipped: true, reason: 'auto_pv_disabled', queued: 0, targets: 0 };
    }
    try {
        const result = await runWeeklyChecklistResetDispatch(db, { now: new Date() });
        if (result.ok && (result.queued || result.failed)) {
            console.log(`[checklist] ${contexto}: semana=${result.weekKey}; alvos=${result.targets}; enfileirados=${result.queued}; existentes=${result.already || 0}; falhas=${result.failed || 0}`);
        }
        return result;
    } catch (error) {
        console.log(`[checklist] falha no disparo semanal (${contexto}):`, error?.message || error);
        return { ok: false, error: error?.message || String(error) };
    }
}

function fecharDbComAtraso(db, delayMs = 30000) {
    if (!db || typeof db.close !== 'function') return;
    setTimeout(() => {
        if (runtimeClover.dbAtivo === db) return;
        aposentarDbSeguro(db, 'reconexao', 30000);
    }, delayMs).unref?.();
}

function fecharSocketSeguro(sock, signal) {
    if (!sock || typeof sock.end !== 'function') return;

    try {
        sock.end(new Error(`Bot encerrado por ${signal}`));
    } catch (error) {
        console.log('[boot] Nao consegui fechar socket antigo:', error?.message || error);
    }
}

function jidPrivadoParaEnvio(jid) {
    const clean = String(jid || '').toLowerCase();
    return Boolean(clean)
        && clean.includes('@')
        && !clean.endsWith('@g.us')
        && !clean.endsWith('@newsletter')
        && clean !== 'status@broadcast';
}

function travaPvAtiva() {
    const lock = runtimeClover.pvReachoutLock;
    if (!lock?.isActive) return null;

    const rawEnd = lock.timeEnforcementEnds;
    if (!rawEnd) return lock;

    const end = rawEnd instanceof Date ? rawEnd : new Date(rawEnd);
    if (Number.isNaN(end.getTime())) return lock;
    if (end.getTime() <= Date.now()) return null;

    return { ...lock, timeEnforcementEnds: end };
}

function protegerEnvioPrivadoDuranteTrava(sock) {
    if (!sock?.sendMessage || sock._cloverPrivateSendGuarded) return;
    const sendMessageOriginal = sock.sendMessage.bind(sock);

    sock.sendMessage = async (jid, content, options = {}) => {
        const {
            forcePrivateDuringReachoutLock = false,
            ...sendOptions
        } = options || {};
        const lock = jidPrivadoParaEnvio(jid) ? travaPvAtiva() : null;
        if (lock && !forcePrivateDuringReachoutLock) {
            console.log('[pv-reachout] envio privado bloqueado antes de chamar WhatsApp:', {
                jid,
                tipo: lock.enforcementType || null,
                fim: lock.timeEnforcementEnds || null,
            });
            return {
                skipped: true,
                reason: 'pv_reachout_locked',
                key: { remoteJid: jid, fromMe: true, id: null },
            };
        }

        return sendMessageOriginal(jid, content, sendOptions);
    };
    sock._cloverPrivateSendGuarded = true;
}

async function encerrarRuntime(signal) {
    if (runtimeClover.encerrando) return;
    runtimeClover.encerrando = true;

    console.log(`[boot] Encerrando por ${signal}.`);
    const forceExitTimer = setTimeout(() => process.exit(0), 8000);
    forceExitTimer.unref?.();
    limparTimerReconexao();
    limparTimerChecklistSemanal();
    limparTimerEconomia();
    fecharSocketSeguro(runtimeClover.sockAtivo, signal);
    runtimeClover.sockAtivo = null;
    if (runtimeClover.siteApiServer) {
        await stopSiteApiServer();
        runtimeClover.siteApiServer = null;
    }

    const db = runtimeClover.dbAtivo;
    runtimeClover.dbAtivo = null;
    await aposentarDbSeguro(db, 'encerramento', 6500);

    clearTimeout(forceExitTimer);
    process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        encerrarRuntime(signal).catch((error) => {
            console.log('[boot] Falha ao encerrar runtime:', error?.message || error);
            process.exit(1);
        });
    });
}

function agendarReconexao(delayMs = 5000) {
    if (runtimeClover.reconnectTimer) return;

    runtimeClover.reconnectTimer = setTimeout(() => {
        runtimeClover.reconnectTimer = null;
        iniciarBot().catch((error) => {
            runtimeClover.iniciando = false;
            console.log('[boot] Falha ao reiniciar bot:', error?.message || error);
            agendarReconexao(delayMs);
        });
    }, delayMs);
}

if (!fs.existsSync(pastaComandos)) {
    fs.mkdirSync(pastaComandos);
}

const arquivosComando = fs.readdirSync(pastaComandos).filter((file) => file.endsWith('.js'));
for (const file of arquivosComando) {
    const comando = require(path.join(pastaComandos, file));
    comandos.set(comando.nome, comando);
}

console.log(`Carregados ${comandos.size} comandos.`);

const JOIN_STUB_TYPES = new Set([
    WAMessageStubType.GROUP_PARTICIPANT_ADD,
    WAMessageStubType.GROUP_PARTICIPANT_INVITE,
    WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN,
    WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST,
    WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
    WAMessageStubType.GROUP_PARTICIPANT_ACCEPT,
    WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN,
    WAMessageStubType.GROUP_PARTICIPANT_JOINED_GROUP_AND_PARENT_GROUP,
    WAMessageStubType.SUB_GROUP_PARTICIPANT_ADD_RICH,
    WAMessageStubType.COMMUNITY_PARTICIPANT_ADD_RICH,
]);

const JOIN_REQUEST_STUB_TYPES = new Set([
    WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN,
    WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST,
    WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD,
]);

const LEAVE_STUB_TYPES = new Set([
    WAMessageStubType.GROUP_PARTICIPANT_LEAVE,
    WAMessageStubType.GROUP_PARTICIPANT_REMOVE,
]);

function parseStubParticipant(value) {
    if (value && typeof value === 'object') {
        const lid = normalizeJid(value.lid || value.lidJid || value.lid_jid || value.userJid || value.user_jid || '');
        if (lid) {
            return lid.includes('@') ? lid : `${lid}@lid`;
        }

        const phone = normalizeJid(
            value.phoneNumber
            || value.phone_number
            || value.participantPn
            || value.participant_pn
            || value.pnJid
            || value.pn_jid
            || value.pn
            || value.participant
            || value.participantJid
            || value.participant_jid
            || value.jid
            || ''
        );
        if (phone) {
            return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        }

        return '';
    }

    const raw = String(value || '').trim();
    if (!raw) return '';

    try {
        const parsed = JSON.parse(raw);
        const candidate = parsed?.lid
            || parsed?.lidJid
            || parsed?.lid_jid
            || parsed?.pn
            || parsed?.pnJid
            || parsed?.pn_jid
            || parsed?.jid
            || parsed?.participant
            || parsed?.participantJid
            || parsed?.participant_jid
            || parsed?.participantPn
            || parsed?.participant_pn
            || parsed?.userJid
            || parsed?.user_jid
            || parsed?.phoneNumber
            || parsed?.phone_number
            || '';
        return normalizeJid(candidate);
    } catch {
        return normalizeJid(raw);
    }
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function readMappedPhoneDigits(lidDigits) {
    const digits = extractDigits(lidDigits);
    if (!digits) return '';

    const mappingPath = path.join(AUTH_INFO_DIR, `lid-mapping-${digits}_reverse.json`);
    try {
        if (!fs.existsSync(mappingPath)) return '';
        const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') {
            return extractDigits(parsed);
        }
        if (parsed && typeof parsed === 'object') {
            return extractDigits(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user);
        }
    } catch {
        return '';
    }

    return '';
}

function readMappedLidDigits(phoneDigits) {
    const digits = extractDigits(phoneDigits);
    if (!digits) return '';

    const mappingPath = path.join(AUTH_INFO_DIR, `lid-mapping-${digits}.json`);
    try {
        if (!fs.existsSync(mappingPath)) return '';
        const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') {
            return extractDigits(parsed);
        }
        if (parsed && typeof parsed === 'object') {
            return extractDigits(parsed.lid || parsed.id || parsed.user || parsed.jid);
        }
    } catch {
        return '';
    }

    return '';
}

function normalizePlayerStateStatus(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function hasFilledPlayerField(value) {
    const normalized = String(value || '').trim();
    return Boolean(normalized) && normalized !== '-';
}

function scorePlayerState(player) {
    if (!player) return -1;

    let score = 0;
    const gameStatus = normalizePlayerStateStatus(player.jogo_status);
    const profileStatus = normalizePlayerStateStatus(player.ficha_status);
    const storyStatus = normalizePlayerStateStatus(player.historia_status);
    const appearanceStatus = normalizePlayerStateStatus(player.personagem_aparencia_status);
    const distributionStatus = normalizePlayerStateStatus(player.distribution_status);

    if (gameStatus === 'liberado') score += 1000;
    if (['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profileStatus)) score += 500;
    if (['aprovada', 'aprovado'].includes(storyStatus)) score += 100;
    if (['approved', 'aprovada', 'aprovado'].includes(appearanceStatus)) score += 100;
    if (distributionStatus === 'confirmed') score += 50;

    for (const field of ['personagem_nome', 'nome', 'raca', 'classe', 'grimorio', 'magia']) {
        if (hasFilledPlayerField(player[field])) score += 10;
    }

    return score;
}

async function resolvePlayerStateId(db, playerId) {
    const normalized = normalizeJid(playerId);
    if (!normalized) return playerId;

    const [userPart, domain] = normalized.split('@');
    const candidates = new Set([normalized]);

    if (domain === 'lid') {
        const mappedPhone = readMappedPhoneDigits(userPart);
        if (mappedPhone) candidates.add(`${mappedPhone}@s.whatsapp.net`);
    } else {
        const mappedLid = readMappedLidDigits(userPart);
        if (mappedLid) candidates.add(`${mappedLid}@lid`);
    }

    if (candidates.size === 1) return normalized;

    const ids = [...candidates];
    const placeholders = ids.map(() => '?').join(', ');
    const players = await db.all(
        `SELECT *
         FROM jogadores
         WHERE id IN (${placeholders})`,
        ids
    ).catch(() => []);

    if (!players.length) return normalized;

    const bestPlayer = players
        .sort((left, right) => scorePlayerState(right) - scorePlayerState(left))[0];

    return bestPlayer?.id || normalized;
}

function extractStubParticipants(message) {
    const participants = (message?.messageStubParameters || [])
        .map(parseStubParticipant)
        .filter((jid) => jid.includes('@'));

    if (!participants.length && (JOIN_STUB_TYPES.has(message?.messageStubType) || LEAVE_STUB_TYPES.has(message?.messageStubType))) {
        const actor = parseStubParticipant(message?.key?.participant);
        if (actor) participants.push(actor);
    }

    return [...new Set(participants)];
}

async function sendWelcomeIfNeeded({ sock, db, groupId, playerId, displayName, quotedMessage }) {
    if (!groupId?.endsWith('@g.us')) return false;
    if (!playerId || isSameUser(playerId, sock.user?.id)) return false;
    if (!await isGroupReceptionEnabled(db, groupId, 'reception')) return false;
    if (!shouldSendWelcome(groupId, playerId)) return false;

    const existingWelcome = await getGroupWelcomeState(db, groupId, playerId);
    if (existingWelcome?.welcome_sent_at) {
        await touchGroupMember(db, groupId, playerId);
        return false;
    }

    await registerGroupJoin(db, groupId, playerId);
    await ensurePlayerRecord(db, playerId, displayName);
    await ensureOnboardingState(db, playerId, 'recepcao');

    await sendReply({
        sock,
        idChat: groupId,
        m: quotedMessage,
        mentions: [playerId],
        imagePath: findImagePath('recepcao'),
        text: renderWelcomeMessage(playerId),
    });

    await markWelcomeSent(db, playerId);
    await markGroupWelcomeSent(db, groupId, playerId);
    return true;
}

async function sendOffWelcomeIfNeeded({ sock, db, groupId, playerId, displayName, quotedMessage }) {
    if (!groupId?.endsWith('@g.us')) return false;
    if (!playerId || isSameUser(playerId, sock.user?.id)) return false;
    if (!await isConfiguredCloverGroup(db, 'off', groupId)) return false;
    if (!await isGroupReceptionEnabled(db, groupId, 'off')) return false;
    if (!shouldSendWelcome(groupId, playerId)) return false;

    const existingWelcome = await getGroupWelcomeState(db, groupId, playerId);
    if (existingWelcome?.welcome_sent_at) {
        await touchGroupMember(db, groupId, playerId);
        return false;
    }

    await registerGroupJoin(db, groupId, playerId);
    await ensurePlayerRecord(db, playerId, displayName);

    await sendReply({
        sock,
        idChat: groupId,
        m: quotedMessage,
        mentions: [playerId],
        imagePath: getOffGroupWelcomeImagePath(),
        text: renderOffGroupWelcomeMessage(playerId),
    });

    await markGroupWelcomeSent(db, groupId, playerId);
    return true;
}

async function handleCommunityParticipantAdd({ sock, db, groupId, participantId }) {
    if (!await isConfiguredCloverGroup(db, 'community', groupId)) return false;
    return cancelPendingExitForReturn({ sock, db, participantId }).then(async (result) => {
        if (result?.player?.id) {
            await markCommunityStatus(db, result.player.id, true).catch(() => null);
        }
        return result;
    }).catch((error) => {
        console.log('[community-exit] falha ao cancelar saida por retorno:', error?.message || error);
        return { ok: false, error };
    });
}

async function handleCommunityParticipantRemove({ sock, db, groupId, participantId }) {
    if (!await isConfiguredCloverGroup(db, 'community', groupId)) return false;
    return createOrRefreshExitConfirmation({ sock, db, groupId, participantId }).then(async (result) => {
        if (result?.player?.id) {
            await markCommunityStatus(db, result.player.id, false).catch(() => null);
        }
        return result;
    }).catch((error) => {
        console.log('[community-exit] falha ao criar confirmacao de saida:', error?.message || error);
        return { ok: false, error };
    });
}

function parseRollNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function isCancelText(value) {
    return ['cancelar', 'cancela', 'nao', 'nÃ£o'].includes(normalizeText(value));
}

async function syncArchiveCardSafely(sock, db, playerId, context = 'index') {
    try {
        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log(`[arquivo:${context}] Nao consegui sincronizar ${playerId}:`, error?.message || error);
    }
}

async function syncRegisteredSquadDescriptionsSafely(sock, db) {
    let squads = [];
    try {
        squads = await db.all(
            `SELECT squad_key, name
             FROM clover_squads
             WHERE group_id IS NOT NULL
               AND group_id <> ''
               AND COALESCE(description_sync_status, '') <> 'ok'
             ORDER BY name`
        );
    } catch (error) {
        console.log('[esquadrao] nao consegui listar grupos registrados:', error?.message || error);
        return;
    }

    for (const [index, squad] of squads.entries()) {
        try {
            const result = await syncSquadGroupDescription({ sock, db, squadKey: squad.squad_key });
            if (result.ok) {
                console.log(`[esquadrao] descricao sincronizada: ${squad.name}`);
            } else {
                console.log(`[esquadrao] descricao pendente (${squad.name}): ${result.reason || 'falha'}`);
            }
        } catch (error) {
            console.log(`[esquadrao] falha ao sincronizar ${squad.name}:`, error?.message || error);
        }
        if (index < squads.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

async function restorePreviousRollSelection(db, playerId, onboarding) {
    const previousRollNumber = onboarding.step_payload?.previous_roll_number || null;
    await setSelectedRollForMagic(db, playerId, previousRollNumber);
}

async function startMagicConfirmation({ sock, db, m, idChat, idJogador, player, roll, choice }) {
    const availability = await getMagicAvailability(db, choice.label, idJogador);
    if (!availability) return false;

    if (!availability.available) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicUnavailableMessage(),
        });
        return true;
    }

    const reservation = await savePendingMagicConfirmation(db, idJogador, choice.label, roll.roll_number);
    if (!reservation?.ok) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicUnavailableMessage(),
        });
        return true;
    }

    await updateOnboardingStep(db, idJogador, 'confirmar_magia', {
        last_message: 'magia_pendente_confirmacao',
        magia: choice.label,
        roll_number: roll.roll_number,
        previous_roll_number: player.numero_roll_escolhido || null,
    });

    await sendReply({
        sock,
        idChat,
        m,
        text: [
            renderMagicConfirmationMessage(availability, roll),
            '',
            `â†³ Proximo passo: confirme a escolha e depois use *${COMMAND_PREFIX}continuar*.`,
        ].join('\n'),
    });
    return true;
}

async function tryHandleProfilePlainText({ sock, db, m, idChat, idJogador, texto, downloadMediaMessage, loggerFactory }) {
    if (!looksLikeProfileSubmission(texto)) return false;

    const player = await ensurePlayerRecord(db, idJogador, m.pushName || 'Cacador');
    const analysis = await analyzeProfileSubmission(db, idJogador, texto);
    if (!analysis.ok) {
        await updateOnboardingStep(db, idJogador, 'corrigir_ficha', {
            last_message: 'ficha_com_erro',
            errors: analysis.errors,
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: [
                renderValidationErrors(analysis.errors),
                '',
                `â†³ Depois de corrigir, envie a ficha novamente ou use *${COMMAND_PREFIX}continuar*.`,
            ].join('\n'),
        });
        return true;
    }

    const imageInfo = await saveAppearanceImageFromMessage({
        sock,
        message: m,
        playerId: idJogador,
        downloadMediaMessage,
        loggerFactory,
    });

    await savePendingConfirmation(db, idJogador, analysis.payload);
    await markProfileAppearancePending(db, idJogador, analysis.payload, imageInfo);
    await updateOnboardingStep(db, idJogador, 'ficha_pendente_confirmacao', {
        last_message: 'ficha_validada',
        roll_number: analysis.payload.numeroRoll,
    });

    await sendReply({
        sock,
        idChat,
        m,
        text: [
            renderConfirmationSummary(analysis.payload, player),
            '',
            `â†³ Proximo passo: *${COMMAND_PREFIX}continuar* ou *${COMMAND_PREFIX}confirmarFicha*.`,
        ].join('\n'),
    });
    return true;
}

async function tryHandleMagicPlainText({ sock, db, m, idChat, idJogador, texto }) {
    const cleanText = String(texto || '').trim();
    if (!cleanText || cleanText.startsWith(COMMAND_PREFIX)) return false;
    if (!isMagicReplyMessage(m)) return false;

    const onboarding = await getExistingOnboardingState(db, idJogador);
    if (!onboarding) return false;
    if (!['escolha_magia', 'escolha_roll_magia', 'confirmar_magia'].includes(onboarding.current_step)) {
        return false;
    }

    const player = await ensurePlayerRecord(db, idJogador, m.pushName || 'Cacador');
    const rolls = await listPlayerRolls(db, idJogador);
    if (!rolls.length) return false;

    const selectedRoll = player.numero_roll_escolhido
        ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
        : null;
    const lockedSelectedRoll = selectedRoll && ['confirmada', 'aprovada'].includes(player.ficha_status)
        ? selectedRoll
        : null;
    const promptRoll = getBestRollForMagicPrompt(rolls, lockedSelectedRoll?.roll_number);
    if (!promptRoll) return false;

    const normalized = normalizeText(cleanText);

    if (onboarding.current_step === 'confirmar_magia') {
        if (['confirmar', 'confirmo', 'sim'].includes(normalized)) {
            const confirmed = await confirmPendingMagicChoice(db, idJogador);
            if (!confirmed.ok) {
                await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                    last_message: 'magia_confirmacao_expirada',
                });
                await sendReply({
                        sock,
                        idChat,
                        m,
                        text: [
                            '*âš ï¸ Essa escolha nao esta mais disponivel.*',
                            '',
                            await renderMagicChoicePrompt(db, promptRoll),
                        ].join('\n'),
                    });
                    return true;
                }

            const confirmedRoll = confirmed.selectedRollNumber
                ? await getPlayerRollByNumber(db, idJogador, confirmed.selectedRollNumber)
                : selectedRoll;
            await updateOnboardingStep(db, idJogador, confirmed.profileComplete ? 'cadastro_aprovado' : 'aguardando_ficha_envio', {
                last_message: 'magia_escolhida',
                magia: confirmed.availability.option.label,
                roll_number: confirmed.selectedRollNumber,
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicChosenMessage(confirmed.availability, {
                    roll: confirmedRoll,
                    profileComplete: confirmed.profileComplete,
                }),
            });
            await syncArchiveCardSafely(sock, db, idJogador, 'magia_texto');
            return true;
        }

        if (isCancelText(cleanText)) {
            await clearPendingMagicConfirmation(db, idJogador);
            await restorePreviousRollSelection(db, idJogador, onboarding);
            await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                last_message: 'magia_cancelada',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicCancelledMessage(),
            });
            return true;
        }

        await clearPendingMagicConfirmation(db, idJogador);
        await restorePreviousRollSelection(db, idJogador, onboarding);
        await updateOnboardingStep(db, idJogador, 'escolha_magia', {
            last_message: 'magia_pendente_trocada',
        });
    }

    if (onboarding.current_step === 'escolha_roll_magia') {
        const payload = onboarding.step_payload || {};
        const candidateRolls = rolls.filter((roll) => (payload.candidate_roll_numbers || [])
            .map(Number)
            .includes(Number(roll.roll_number)));
        const matchingRolls = getRollsMatchingMagic(candidateRolls.length ? candidateRolls : rolls, payload.magia);
        const choice = matchingRolls.length
            ? findMagicOption(getAvailableMagicsForRoll(matchingRolls[0]), payload.magia)
            : null;

        if (!choice || !matchingRolls.length) {
            await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                last_message: 'magia_roll_pendente_perdido',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: await renderMagicChoicePrompt(db, promptRoll),
            });
            return true;
        }

        if (isCancelText(cleanText)) {
            await clearPendingMagicConfirmation(db, idJogador);
            await updateOnboardingStep(db, idJogador, 'escolha_magia', {
                last_message: 'magia_cancelada',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicCancelledMessage(),
            });
            return true;
        }

        const rollNumber = parseRollNumber(cleanText);
        const roll = matchingRolls.find((item) => Number(item.roll_number) === Number(rollNumber));
        if (!roll) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicRollChoiceMessage(choice, matchingRolls),
            });
            return true;
        }

        return startMagicConfirmation({ sock, db, m, idChat, idJogador, player, roll, choice });
    }

    const options = getAvailableMagicsForRoll(promptRoll);
    const allMatches = findMagicOptions(getAllMagics(), cleanText);
    if (allMatches.length > 1) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicAmbiguousMessage(cleanText, allMatches),
        });
        return true;
    }

    const allChoice = allMatches[0] || null;
    const choice = allChoice ? findMagicOption(options, cleanText) : null;
    if (allChoice && !choice) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicRarityBlockedMessage(allChoice, promptRoll),
        });
        return true;
    }

    if (!choice) {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicNotFoundMessage(cleanText, promptRoll),
        });
        return true;
    }

    const matchingRolls = lockedSelectedRoll
        ? getRollsMatchingMagic([lockedSelectedRoll], choice.label)
        : getRollsMatchingMagic(rolls, choice.label);

    if (!matchingRolls.length) {
        await sendReply({
            sock,
            idChat,
            m,
            text: await renderMagicChoicePrompt(db, promptRoll, options),
        });
        return true;
    }

    if (!lockedSelectedRoll && matchingRolls.length > 1) {
        await updateOnboardingStep(db, idJogador, 'escolha_roll_magia', {
            last_message: 'escolher_roll_para_magia',
            magia: choice.label,
            candidate_roll_numbers: matchingRolls.map((roll) => roll.roll_number),
            previous_roll_number: player.numero_roll_escolhido || null,
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMagicRollChoiceMessage(choice, matchingRolls),
        });
        return true;
    }

    return startMagicConfirmation({ sock, db, m, idChat, idJogador, player, roll: matchingRolls[0], choice });
}

async function iniciarBot() {
    if (runtimeClover.iniciando) {
        console.log('[boot] Inicio ignorado: ja existe boot em andamento.');
        return;
    }

    runtimeClover.iniciando = true;
    limparTimerReconexao();
    const geracao = runtimeClover.geracao + 1;
    runtimeClover.geracao = geracao;
    const sockAnterior = runtimeClover.sockAtivo;
    if (sockAnterior) {
        runtimeClover.sockAtivo = null;
        fecharSocketSeguro(sockAnterior, 'reconexao');
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const logger = P({ level: 'silent' });
    const db = registerDatabase(await criarBanco());
    global.__cloverDeliveryDb = db;
    runtimeClover.db = db;
    try {
        await ensureDeliverySchema(db);
    } catch (error) {
        console.log('[delivery] nao consegui garantir fila auxiliar:', error?.message || error);
    }
    try {
        const spellReviewGroupId = await getCloverGroup(db, 'spell_review');
        if (spellReviewGroupId) {
            await setGroupEnabled(db, spellReviewGroupId, true);
        }
    } catch (error) {
        console.log('[grupo-avaliacao-feiticos] nao consegui ativar comandos no grupo salvo:', error?.message || error);
    }
    const dbAnterior = runtimeClover.dbAtivo;
    runtimeClover.dbAtivo = db;
    if (dbAnterior && dbAnterior !== db) {
        aposentarDbSeguro(dbAnterior, 'substituido', 30000);
    }
    try {
        if (!runtimeClover.siteApiServer) {
            runtimeClover.siteApiServer = startSiteApiServer({
                getDb: () => runtimeClover.dbAtivo,
            });
        }
    } catch (error) {
        console.log('[site-api] nao consegui iniciar:', error?.message || error);
    }

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['Windows', 'Chrome', '130.0.0.0'],
        printQRInTerminal: false,
    });
    sock._cloverAuthState = state;
    protegerEnvioPrivadoDuranteTrava(sock);
    runtimeClover.sockAtivo = sock;
    let onlineAnunciado = false;
    const isCurrentRuntime = () => (
        geracao === runtimeClover.geracao
        && runtimeClover.sockAtivo === sock
        && runtimeClover.dbAtivo === db
    );

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const conexaoAtual = geracao === runtimeClover.geracao && runtimeClover.sockAtivo === sock;

        if (qr) qrcode.generate(qr, { small: true });
        if (update.reachoutTimeLock) {
            runtimeClover.pvReachoutLock = update.reachoutTimeLock;
            console.log('[pv-reachout] estado informado pelo WhatsApp:', {
                ativo: Boolean(update.reachoutTimeLock.isActive),
                tipo: update.reachoutTimeLock.enforcementType || null,
                fim: update.reachoutTimeLock.timeEnforcementEnds || null,
            });
        }

        if (connection === 'close') {
            if (runtimeClover.sockAtivo === sock) {
                runtimeClover.sockAtivo = null;
            }
            if (runtimeClover.exitSweepTimer) {
                clearInterval(runtimeClover.exitSweepTimer);
                runtimeClover.exitSweepTimer = null;
            }
            if (runtimeClover.antiGhostSweepTimer) {
                clearInterval(runtimeClover.antiGhostSweepTimer);
                runtimeClover.antiGhostSweepTimer = null;
            }
            limparTimerChecklistSemanal();
            limparTimerEconomia();
            // Keep the DB available for the site API while WhatsApp reconnects.
            // The next boot replaces it and closes this handle with delay.
            fecharDbComAtraso(db);

            if (!conexaoAtual) {
                return;
            }
            runtimeClover.iniciando = false;

            const errorCode = lastDisconnect?.error?.output?.statusCode;
            if (errorCode === DisconnectReason.loggedOut) {
                console.log('Sessao encerrada pelo WhatsApp. Mantendo auth_info intacto e tentando reconectar sem reset.');
                agendarReconexao(60000);
            } else {
                agendarReconexao();
            }
        } else if (connection === 'open') {
            if (!isCurrentRuntime()) {
                return;
            }
            runtimeClover.iniciando = false;
            if (onlineAnunciado) {
                return;
            }
            onlineAnunciado = true;

            console.log('Bot online.');
            logCurrentActivationCode();
            if (process.env.CLOVER_SAFE_BOOT === '1') {
                console.log('[safe-boot] rotinas pos-abertura desativadas.');
                return;
            }
            if (typeof sock.fetchAccountReachoutTimelock === 'function') {
                sock.fetchAccountReachoutTimelock()
                    .then((reachout) => {
                        runtimeClover.pvReachoutLock = reachout || null;
                        console.log('[pv-reachout] consulta inicial:', {
                            ativo: Boolean(reachout?.isActive),
                            tipo: reachout?.enforcementType || null,
                            fim: reachout?.timeEnforcementEnds || null,
                        });
                    })
                    .catch((error) => {
                        console.log('[pv-reachout] nao consegui consultar:', error?.message || error);
                    });
            }
            try {
                const privateDeliveryResult = await runPrivateDeliveryWorkerOnce({
                    sock,
                    db,
                    env: process.env,
                    context: 'connection_open',
                });
                if (
                    !privateDeliveryResult?.skipped
                    || !['worker_disabled', 'run_on_open_disabled'].includes(privateDeliveryResult?.reason)
                ) {
                    console.log('[pv-delivery] execucao controlada:', {
                        ok: privateDeliveryResult?.ok ?? null,
                        skipped: privateDeliveryResult?.skipped ?? false,
                        reason: privateDeliveryResult?.reason || null,
                        jobId: privateDeliveryResult?.jobId || null,
                        status: privateDeliveryResult?.status || null,
                        sent: privateDeliveryResult?.sent === true,
                    });
                }
            } catch (error) {
                console.log('[pv-delivery] falha na execucao controlada:', error?.message || error);
            }

            try {
                const offApproval = await approvePendingOffGroupRequests(sock, db);
                if (offApproval.ok && offApproval.pending.length) {
                    console.log(`[grupo-off] pedidos pendentes=${offApproval.pending.length}; aprovados=${offApproval.approved.length}; nao reconhecidos=${offApproval.skipped.length}; falhas=${offApproval.rejected.length}`);
                }
            } catch (error) {
                console.log('[grupo-off] nao consegui varrer pedidos pendentes:', error?.message || error);
            }

            try {
                const spellApproval = await approvePendingSpellReviewRequests(sock, db);
                if (spellApproval.ok && spellApproval.pending.length) {
                    console.log(`[grupo-avaliacao-feiticos] pedidos pendentes=${spellApproval.pending.length}; aprovados=${spellApproval.approved.length}; ignorados=${spellApproval.skipped.length}; falhas=${spellApproval.rejected.length}`);
                }
            } catch (error) {
                console.log('[grupo-avaliacao-feiticos] nao consegui varrer pedidos pendentes:', error?.message || error);
            }

            try {
                const expiredExits = await processExpiredExitConfirmations({ sock, db });
                if (expiredExits.length) {
                    console.log(`[community-exit] saidas expiradas processadas=${expiredExits.length}`);
                }
            } catch (error) {
                console.log('[community-exit] nao consegui varrer saidas expiradas:', error?.message || error);
            }

            await syncRegisteredSquadDescriptionsSafely(sock, db);

            await dispararChecklistSemanalSeguro(db, 'abertura');
            limparTimerChecklistSemanal();
            runtimeClover.weeklyChecklistTimer = setInterval(async () => {
                if (runtimeClover.sockAtivo !== sock || runtimeClover.dbAtivo !== db) return;
                await dispararChecklistSemanalSeguro(db, 'timer');
            }, 30 * 60 * 1000);
            runtimeClover.weeklyChecklistTimer.unref?.();

            await varrerEconomiaSeguro(db, 'abertura');
            limparTimerEconomia();
            runtimeClover.economySweepTimer = setInterval(async () => {
                if (runtimeClover.sockAtivo !== sock || runtimeClover.dbAtivo !== db) return;
                await varrerEconomiaSeguro(db, 'timer');
            }, 10 * 60 * 1000);
            runtimeClover.economySweepTimer.unref?.();

            if (runtimeClover.exitSweepTimer) {
                clearInterval(runtimeClover.exitSweepTimer);
            }
            runtimeClover.exitSweepTimer = setInterval(async () => {
                if (runtimeClover.sockAtivo !== sock || runtimeClover.dbAtivo !== db) return;
                try {
                    const expiredExits = await processExpiredExitConfirmations({ sock, db });
                    if (expiredExits.length) {
                        console.log(`[community-exit] saidas expiradas processadas=${expiredExits.length}`);
                    }
                } catch (error) {
                    console.log('[community-exit] falha na varredura agendada:', error?.message || error);
                }
            }, 15 * 60 * 1000);
            runtimeClover.exitSweepTimer.unref?.();

            if (runtimeClover.antiGhostSweepTimer) {
                clearInterval(runtimeClover.antiGhostSweepTimer);
            }
            runtimeClover.antiGhostSweepTimer = setInterval(async () => {
                if (runtimeClover.sockAtivo !== sock || runtimeClover.dbAtivo !== db) return;
                try {
                    const sweep = await runAntiGhostSweep({ sock, db });
                    if (sweep.ok && (sweep.sent || sweep.candidates?.length || sweep.bonuses)) {
                        console.log(`[anti-ghost] varredura: enviados=${sweep.sent}; candidatos=${sweep.candidates?.length || 0}; bonus=${sweep.bonuses || 0}`);
                    }
                } catch (error) {
                    console.log('[anti-ghost] falha na varredura agendada:', error?.message || error);
                }
            }, 6 * 60 * 60 * 1000);
            runtimeClover.antiGhostSweepTimer.unref?.();
        }
    });

    sock.ev.on('messages.update', (updates) => {
        for (const item of updates || []) {
            const jid = item?.key?.remoteJid || '';
            if (!item?.key?.fromMe || !jid || jid.endsWith('@g.us')) continue;
            const update = item.update || {};
            console.log('[pv-message-update]', {
                idChat: jid,
                messageId: item.key?.id || null,
                status: update.status ?? null,
                updateKeys: Object.keys(update),
                stubParameters: update.messageStubParameters || null,
                stubType: update.messageStubType || null,
                error: update.error?.message || update.error || null,
            });
            handlePrivateSendUpdate({ sock, item }).catch((error) => {
                console.log('[sendReply] falha ao tratar update de PV:', error?.message || error);
            });
        }
    });

    sock.ev.on('message-receipt.update', (updates) => {
        for (const item of updates || []) {
            const jid = item?.key?.remoteJid || '';
            if (!item?.key?.fromMe || !jid || jid.endsWith('@g.us')) continue;
            console.log('[pv-receipt-update]', {
                idChat: jid,
                messageId: item.key?.id || null,
                receipt: item.receipt || null,
            });
        }
    });

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (!isCurrentRuntime()) return;
        try {
            await withDatabaseLease(db, 'group-participants.update', async () => {

        const groupReceptionEnabled = await isGroupReceptionEnabled(db, id, 'reception');
        const isOffGroup = await isConfiguredCloverGroup(db, 'off', id);
        const isSpellReviewGroup = await isConfiguredCloverGroup(db, 'spell_review', id);
        const isAddAction = ['add', 'join'].includes(action);
        const isRemoveAction = ['remove', 'leave'].includes(action);

        for (const participant of participants || []) {
            const participantJid = parseStubParticipant(participant);
            if (!participantJid || isSameUser(participantJid, sock.user?.id)) continue;

            try {
                if (isRemoveAction) {
                    if (isSpellReviewGroup) {
                        const spellExit = await advanceSpellReviewQueueAfterRemoval({
                            sock,
                            db,
                            participantId: participantJid,
                            closedBy: 'group_removal',
                        });
                        if (spellExit.handled) {
                            const nextEntry = spellExit.next?.entry || null;
                            const mentions = [spellExit.entry.player_id, nextEntry?.player_id].filter(Boolean);
                            await sock.sendMessage(id, {
                                mentions,
                                text: [
                                    'â™§â”ƒFILA DE FEITIÃ‡OS ð–¥” CLOVER MULTICOLOR',
                                    '',
                                    `*Removido:* @${String(spellExit.entry.player_id || '').split('@')[0]}`,
                                    spellExit.link
                                        ? '*Link do grupo:* link atual mantido.'
                                        : '*Link do grupo:* nÃ£o consegui buscar agora.',
                                    '',
                                    !spellExit.autoFlow
                                        ? `Fluxo automÃ¡tico desligado. Use *${COMMAND_PREFIX}proximo* para chamar manualmente.`
                                        : nextEntry
                                        ? `*PrÃ³ximo:* @${String(nextEntry.player_id || '').split('@')[0]} foi chamado automaticamente.`
                                        : 'A fila ficou vazia.',
                                    spellExit.autoFlow && nextEntry && spellExit.invite?.ok
                                        ? '*PV:* link enviado para o prÃ³ximo.'
                                        : spellExit.autoFlow && nextEntry
                                            ? '*PV:* nÃ£o consegui enviar o link para o prÃ³ximo.'
                                            : null,
                                ].filter(Boolean).join('\n'),
                            }).catch((error) => {
                                console.log('[grupo-avaliacao-feiticos] nao consegui avisar remocao:', error?.message || error);
                            });
                        }
                    }

                    await handleCommunityParticipantRemove({
                        sock,
                        db,
                        groupId: id,
                        participantId: participantJid,
                    });
                    await clearGroupMemberState(db, id, participantJid);
                    clearWelcomeDebounce(id, participantJid);
                    continue;
                }

                if (isSpellReviewGroup && !isAddAction) {
                    const spellApproval = await tryApproveSpellReviewJoinRequests({
                        sock,
                        db,
                        groupId: id,
                        participants: [participant],
                    });
                    if (spellApproval.handled) {
                        if (!spellApproval.approved.length) {
                            try {
                                const sweep = await approvePendingSpellReviewRequests(sock, db);
                                if (sweep.approved?.length) {
                                    console.log(`[grupo-avaliacao-feiticos] aprovados apos varredura=${sweep.approved.length}; ignorados=${sweep.skipped.length}; falhas=${sweep.rejected.length}`);
                                }
                        } catch (error) {
                            console.log('[grupo-avaliacao-feiticos] falha na varredura apos update de participantes:', error?.message || error);
                        }
                        await enqueueApprovalSweep(db, {
                            groupType: 'spell_review',
                            source: 'clover_group_participants_update',
                        }).catch((error) => {
                            console.log('[delivery] nao consegui enfileirar aprovacao do grupo de avaliacao:', error?.message || error);
                        });
                    }
                    continue;
                }
                }

                if (isOffGroup && !isAddAction) {
                    const offApproval = await tryApproveOffGroupJoinRequests({
                        sock,
                        db,
                        groupId: id,
                        participants: [participant],
                    });
                    if (offApproval.handled) {
                        if (!offApproval.approved?.length) {
                            await enqueueApprovalSweep(db, {
                                groupType: 'off',
                                source: 'clover_group_participants_update',
                            }).catch((error) => {
                                console.log('[delivery] nao consegui enfileirar aprovacao do OFF:', error?.message || error);
                            });
                        }
                        continue;
                    }
                }

                if (isAddAction) {
                    await handleCommunityParticipantAdd({
                        sock,
                        db,
                        groupId: id,
                        participantId: participantJid,
                    });

                    const offWelcomeSent = await sendOffWelcomeIfNeeded({
                        sock,
                        db,
                        groupId: id,
                        playerId: participantJid,
                        quotedMessage: null,
                    });
                    if (offWelcomeSent || isOffGroup) {
                        continue;
                    }
                    if (isSpellReviewGroup) {
                        continue;
                    }
                }

                if (!groupReceptionEnabled) continue;
                if (!isAddAction) continue;

                await sendWelcomeIfNeeded({
                    sock,
                    db,
                    groupId: id,
                    playerId: participantJid,
                    quotedMessage: null,
                });
            } catch (err) {
                console.log('Erro ao processar entrada/saida do grupo:', err);
            }
        }
            });
        } catch (error) {
            if (error?.code !== 'database_retired') {
                console.log('[boot] Falha no evento de participantes:', error?.message || error);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!isCurrentRuntime()) return;
        try {
            await withDatabaseLease(db, 'messages.upsert', async () => {

        const m = messages[0];
        if (!m || (!m.message && !m.messageStubType)) return;

        const idChat = m.key.remoteJid;
        const isGroup = idChat.endsWith('@g.us');
        const incomingText = getMessageText(m);
        const incomingTrimmedText = String(incomingText || '').trim();
        const incomingHasCommandPrefix = incomingTrimmedText.startsWith(COMMAND_PREFIX);
        if (!isGroup && incomingTrimmedText) {
            console.log('[pv-upsert]', {
                idChat,
                fromMe: Boolean(m.key.fromMe),
                messageId: m.key?.id || null,
                key: {
                    remoteJid: m.key?.remoteJid || null,
                    remoteJidAlt: m.key?.remoteJidAlt || null,
                    participant: m.key?.participant || null,
                    participantAlt: m.key?.participantAlt || null,
                    addressingMode: m.key?.addressingMode || null,
                },
                hasCommandPrefix: incomingHasCommandPrefix,
                length: incomingTrimmedText.length,
                text: incomingHasCommandPrefix ? incomingTrimmedText.slice(0, 80) : undefined,
            });
        }
        if (m.key.fromMe) return;

        const rawIdJogador = isGroup ? m.key.participant : idChat;
        const idJogador = await resolvePlayerStateId(db, rawIdJogador);
        const stubType = m.messageStubType;
        const texto = incomingText;

        if (!isGroup && texto) {
            const exitReply = await handleExitConfirmationReply({
                sock,
                db,
                playerId: rawIdJogador,
                text: texto,
            });
            if (exitReply.handled) {
                return;
            }

            const antiGhostReply = await handleAntiGhostPrivateReply({
                sock,
                db,
                playerId: rawIdJogador,
                text: texto,
            });
            if (antiGhostReply.handled) {
                return;
            }
        }

        if (m.message?.reactionMessage) {
            if (await tryHandleAppearanceReaction({
                sock,
                db,
                m,
                idChat,
                reviewerId: idJogador,
            })) {
                return;
            }
        }

        if (isGroup && JOIN_REQUEST_STUB_TYPES.has(stubType)) {
            const participants = extractStubParticipants(m);
            const spellApproval = await tryApproveSpellReviewJoinRequests({
                sock,
                db,
                groupId: idChat,
                participants,
            });
            if (spellApproval.handled) {
                if (!spellApproval.approved.length) {
                    try {
                        const sweep = await approvePendingSpellReviewRequests(sock, db);
                        if (sweep.approved?.length) {
                            console.log(`[grupo-avaliacao-feiticos] aprovados apos varredura=${sweep.approved.length}; ignorados=${sweep.skipped.length}; falhas=${sweep.rejected.length}`);
                        }
                    } catch (error) {
                        console.log('[grupo-avaliacao-feiticos] falha na varredura apos pedido de entrada:', error?.message || error);
                    }
                    await enqueueApprovalSweep(db, {
                        groupType: 'spell_review',
                        source: 'clover_join_request_stub',
                    }).catch((error) => {
                        console.log('[delivery] nao consegui enfileirar aprovacao do grupo de avaliacao:', error?.message || error);
                    });
                }
                return;
            }

            const offApproval = await tryApproveOffGroupJoinRequests({
                sock,
                db,
                groupId: idChat,
                participants,
            });
            if (offApproval.handled) {
                if (!offApproval.approved?.length) {
                    await enqueueApprovalSweep(db, {
                        groupType: 'off',
                        source: 'clover_join_request_stub',
                    }).catch((error) => {
                        console.log('[delivery] nao consegui enfileirar aprovacao do OFF:', error?.message || error);
                    });
                }
                return;
            }
        }

        if (isGroup && await isConfiguredCloverGroup(db, 'spell_review', idChat) && JOIN_STUB_TYPES.has(stubType)) {
            return;
        }

        if (isGroup && await isConfiguredCloverGroup(db, 'spell_review', idChat) && LEAVE_STUB_TYPES.has(stubType)) {
            const participants = extractStubParticipants(m);
            for (const participant of participants) {
                const spellExit = await advanceSpellReviewQueueAfterRemoval({
                    sock,
                    db,
                    participantId: participant,
                    closedBy: 'group_removal',
                });
                if (spellExit.handled) {
                    const nextEntry = spellExit.next?.entry || null;
                    await sock.sendMessage(idChat, {
                        mentions: [spellExit.entry.player_id, nextEntry?.player_id].filter(Boolean),
                        text: [
                            'â™§â”ƒFILA DE FEITIÃ‡OS ð–¥” CLOVER MULTICOLOR',
                            '',
                            `*Removido:* @${String(spellExit.entry.player_id || '').split('@')[0]}`,
                            spellExit.link
                                ? '*Link do grupo:* link atual mantido.'
                                : '*Link do grupo:* nÃ£o consegui buscar agora.',
                        '',
                        !spellExit.autoFlow
                            ? `Fluxo automÃ¡tico desligado. Use *${COMMAND_PREFIX}proximo* para chamar manualmente.`
                            : nextEntry
                            ? `*PrÃ³ximo:* @${String(nextEntry.player_id || '').split('@')[0]} foi chamado automaticamente.`
                            : 'A fila ficou vazia.',
                        spellExit.autoFlow && nextEntry && spellExit.invite?.ok
                            ? '*PV:* link enviado para o prÃ³ximo.'
                            : spellExit.autoFlow && nextEntry
                                ? '*PV:* nÃ£o consegui enviar o link para o prÃ³ximo.'
                                : null,
                    ].filter(Boolean).join('\n'),
                    }).catch((error) => {
                        console.log('[grupo-avaliacao-feiticos] nao consegui avisar remocao via stub:', error?.message || error);
                    });
                }
            }
            return;
        }

        if (isGroup && await isConfiguredCloverGroup(db, 'off', idChat) && JOIN_STUB_TYPES.has(stubType)) {
            const participants = extractStubParticipants(m);
            for (const participant of participants) {
                try {
                    await sendOffWelcomeIfNeeded({
                        sock,
                        db,
                        groupId: idChat,
                        playerId: participant,
                        quotedMessage: null,
                    });
                } catch (err) {
                    console.log('Erro ao recepcionar entrada no OFF via stub:', err);
                }
            }
            return;
        }

        if (isGroup && await isConfiguredCloverGroup(db, 'community', idChat)) {
            if (JOIN_STUB_TYPES.has(stubType)) {
                const participants = extractStubParticipants(m);
                for (const participant of participants) {
                    await handleCommunityParticipantAdd({
                        sock,
                        db,
                        groupId: idChat,
                        participantId: participant,
                    });
                }
            } else if (LEAVE_STUB_TYPES.has(stubType)) {
                const participants = extractStubParticipants(m);
                let exitNoticeCreated = false;
                for (const participant of participants) {
                    const result = await handleCommunityParticipantRemove({
                        sock,
                        db,
                        groupId: idChat,
                        participantId: participant,
                    });
                    if (result?.ok) exitNoticeCreated = true;
                    if (!result?.ok) {
                        console.log(`[community-exit] saida ignorada em ${idChat}: ${participant} (${result?.reason || 'sem motivo'})`);
                    }
                }
                if (exitNoticeCreated) {
                    await sendReaction({
                        sock,
                        idChat,
                        m,
                        emoji: 'âœ…',
                    }).catch(() => null);
                }
            }
        }

        if (isGroup && await isGroupReceptionEnabled(db, idChat, 'reception')) {
            if (JOIN_STUB_TYPES.has(stubType)) {
                const participants = extractStubParticipants(m);
                console.log(`Entrada detectada via stub ${stubType} em ${idChat}: ${participants.join(', ') || '(sem participantes)'}`);

                for (const participant of participants) {
                    try {
                        await sendWelcomeIfNeeded({
                            sock,
                            db,
                            groupId: idChat,
                            playerId: participant,
                            quotedMessage: null,
                        });
                    } catch (err) {
                        console.log('Erro ao recepcionar entrada via stub:', err);
                    }
                }
            } else if (LEAVE_STUB_TYPES.has(stubType)) {
                const participants = extractStubParticipants(m);
                for (const participant of participants) {
                    try {
                        await clearGroupMemberState(db, idChat, participant);
                        clearWelcomeDebounce(idChat, participant);
                    } catch (err) {
                        console.log('Erro ao limpar estado de membro via stub:', err);
                    }
                }
            }

            if (idJogador && !stubType && !isSameUser(idJogador, sock.user?.id)) {
                try {
                    const groupWelcome = await getGroupWelcomeState(db, idChat, idJogador);

                    if (groupWelcome?.welcome_sent_at) {
                        await touchGroupMember(db, idChat, idJogador);
                    } else if (groupWelcome) {
                        await sendWelcomeIfNeeded({
                            sock,
                            db,
                            groupId: idChat,
                            playerId: idJogador,
                            displayName: m.pushName || 'Cacador',
                            quotedMessage: m,
                        });
                    }
                } catch (err) {
                    console.log('Erro no fallback de recepcao por mensagem:', err);
                }
            }
        }

        if (await tryHandleAppearanceReviewReply({
            sock,
            db,
            m,
            idChat,
            reviewerId: idJogador,
            text: texto,
        })) {
            return;
        }

        if (looksLikeQuickEvaluation(texto)) {
            const evaluationResult = await runWithCommandLock(
                `${idChat}:plain:avaliacao:${m.key?.id || Date.now()}`,
                () => runEconomyMutationExclusive(() => tryHandleQuickEvaluation({
                    sock,
                    db,
                    m,
                    idChat,
                    evaluatorId: idJogador,
                    text: texto,
                }))
            );

            if (evaluationResult.locked) {
                await sendReply({ sock, idChat, m, text: renderLockedMessage() });
                return;
            }

            if (evaluationResult.result) return;
        }

        if (looksLikeProfileSubmission(texto)) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (phaseInfo.canPlay) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderPostFichaReceptionBlockedMessage(),
                });
                return;
            }

            const profileResult = await runWithCommandLock(
                `${idJogador}:plain:ficha`,
                () => tryHandleProfilePlainText({
                    sock,
                    db,
                    m,
                    idChat,
                    idJogador,
                    texto,
                    downloadMediaMessage,
                    loggerFactory: P,
                })
            );

            if (profileResult.locked) {
                await sendReply({ sock, idChat, m, text: renderLockedMessage() });
                return;
            }

            if (profileResult.result) return;
        }

        const cleanText = String(texto || '').trim();
        if (m.message?.imageMessage && !cleanText.startsWith(COMMAND_PREFIX) && (!cleanText || !isMagicReplyMessage(m))) {
            if (await tryAttachAppearanceImage({
                sock,
                db,
                m,
                idChat,
                playerId: idJogador,
                downloadMediaMessage,
                loggerFactory: P,
            })) {
                return;
            }
        }

        if (cleanText && !cleanText.startsWith(COMMAND_PREFIX) && isMagicReplyMessage(m)) {
            const magicResult = await runWithCommandLock(
                `${idJogador}:plain:magias`,
                () => tryHandleMagicPlainText({ sock, db, m, idChat, idJogador, texto })
            );

            if (magicResult.locked) {
                await sendReply({ sock, idChat, m, text: renderLockedMessage() });
                return;
            }

            if (magicResult.result) return;
        }

        if (!stubType && isGroup && !cleanText.startsWith(COMMAND_PREFIX)) {
            let antiGhostGroupType = null;
            if (await isConfiguredCloverGroup(db, 'on', idChat)) antiGhostGroupType = 'on';
            else if (await isConfiguredCloverGroup(db, 'off', idChat)) antiGhostGroupType = 'off';
            else if (await isConfiguredCloverGroup(db, 'community', idChat)) antiGhostGroupType = 'community';

            if (antiGhostGroupType) {
                await recordMessageActivity({
                    db,
                    idChat,
                    playerId: idJogador,
                    m,
                    groupType: antiGhostGroupType,
                    text: texto,
                }).catch((error) => {
                    console.log('[anti-ghost] falha ao registrar mensagem:', error?.message || error);
                });
            }
        }

        if (!texto.startsWith(COMMAND_PREFIX)) return;

        const resolvedCommand = resolveCommand(texto, comandos);
        if (!resolvedCommand) {
            const groupEnabled = isGroup ? await isGroupEnabled(db, idChat) : true;
            if (isGroup && !groupEnabled) return;

            await sendReply({
                sock,
                idChat,
                m,
                text: renderUnknownCommandMessage(),
            });
            return;
        }

        const groupEnabled = isGroup ? await isGroupEnabled(db, idChat) : true;
        const bypassGroupGate = isGroup && resolvedCommand.command.groupBypass;
        if (isGroup && !groupEnabled && !bypassGroupGate) return;

        const ownerCommand = isOwner(idJogador);
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!ownerCommand && phaseInfo.canPlay && (
            isPostFichaReceptionCommand(resolvedCommand.matchedName)
            || isPostFichaReceptionCommand(resolvedCommand.command.nome)
        )) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderPostFichaReceptionBlockedMessage(),
            });
            return;
        }

        if (!ownerCommand && !canUseCommandInPhase(resolvedCommand.command.nome, phaseInfo.phase, {
            isGameCommand: resolvedCommand.command.gameCommand,
        })) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderGameBlockedMessage(),
            });
            return;
        }

        console.log(`Comando recebido de [${m.pushName}]:\n${texto}`);

        const nomeUsuario = m.pushName || 'Cacador';

        try {
            const lockKey = getCriticalLockKey(idJogador, resolvedCommand.command.nome, resolvedCommand.body);
            const guardedExecution = await runWithCommandLock(lockKey, async () => {
                const cooldown = checkCommandCooldown(idJogador, resolvedCommand.command.nome, resolvedCommand.body);
                if (!cooldown.ok) {
                    await sendReply({
                        sock,
                        idChat,
                        m,
                        text: renderCooldownMessage(cooldown.retryMs),
                    });
                    return;
                }

                const executeCommand = () => resolvedCommand.command.executar({
                    sock,
                    m,
                    idChat,
                    idJogador,
                    texto,
                    body: resolvedCommand.body,
                    args: resolvedCommand.args,
                    matchedCommand: resolvedCommand.matchedName,
                    nomeUsuario,
                    db,
                    P,
                    comandos,
                    downloadMediaMessage,
                });
                if (isEconomyCommand(resolvedCommand.command.nome)) {
                    await runEconomyMutationExclusive(executeCommand);
                } else {
                    await executeCommand();
                }
                await recordCommandActivity({
                    db,
                    playerId: idJogador,
                    commandName: resolvedCommand.matchedName || resolvedCommand.command.nome,
                    idChat,
                }).catch((error) => {
                    console.log('[anti-ghost] falha ao registrar comando:', error?.message || error);
                });
            });

            if (guardedExecution.locked) {
                await sendReply({ sock, idChat, m, text: renderLockedMessage() });
            }
        } catch (err) {
            console.log(`Erro no comando ${resolvedCommand.matchedName}:`, err);
            await sock.sendMessage(idChat, { text: 'Erro ao executar o comando.' }).catch((sendError) => {
                console.log('[comando] Nao consegui enviar aviso de erro:', sendError?.message || sendError);
            });
        }
            });
        } catch (error) {
            if (error?.code !== 'database_retired') {
                console.log('[boot] Falha no processamento de mensagem:', error?.message || error);
            }
        }
    });
}

iniciarBot().catch((error) => {
    runtimeClover.iniciando = false;
    console.log('[boot] Falha ao iniciar bot:', error?.message || error);
    agendarReconexao();
});
