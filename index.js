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
const { COMMAND_PREFIX, ENABLE_LEGACY_BC } = require('./config/bot');
const { resolveCommand } = require('./helpers/commandRegistry');
const { sendReply } = require('./helpers/chatReply');
const { logCurrentActivationCode } = require('./helpers/activationCode');
const { isGroupEnabled, isSameUser, normalizeJid } = require('./helpers/groupAccess');
const { handleDevoMessage, isDevoMessage } = require('./src/modules/devo');
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
    getAvailableMagicsForRoll,
    getBestRollForMagicPrompt,
    getMagicAvailability,
    getPendingMagicConfirmation,
    getRollsMatchingMagic,
    renderMagicCancelledMessage,
    renderMagicChoicePrompt,
    renderMagicChosenMessage,
    renderMagicConfirmationMessage,
    renderMagicRollChoiceMessage,
    renderMagicUnavailableMessage,
    savePendingMagicConfirmation,
    setSelectedRollForMagic,
} = require('./helpers/magicManager');
const { normalizeText } = require('./helpers/textUtils');
const { getPlayerRollByNumber, listPlayerRolls } = require('./helpers/rollManager');

const comandos = new Map();
const pastaComandos = path.join(__dirname, 'comandos');

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
    WAMessageStubType.GROUP_PARTICIPANT_ACCEPT,
    WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN,
    WAMessageStubType.GROUP_PARTICIPANT_JOINED_GROUP_AND_PARENT_GROUP,
    WAMessageStubType.SUB_GROUP_PARTICIPANT_ADD_RICH,
    WAMessageStubType.COMMUNITY_PARTICIPANT_ADD_RICH,
]);

const LEAVE_STUB_TYPES = new Set([
    WAMessageStubType.GROUP_PARTICIPANT_LEAVE,
    WAMessageStubType.GROUP_PARTICIPANT_REMOVE,
]);

function parseStubParticipant(value) {
    if (value && typeof value === 'object') {
        const lid = normalizeJid(value.lid || value.userJid || '');
        if (lid) {
            return lid.includes('@') ? lid : `${lid}@lid`;
        }

        const phone = normalizeJid(value.phoneNumber || value.pn || value.jid || '');
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
            || parsed?.pn
            || parsed?.jid
            || parsed?.userJid
            || parsed?.phoneNumber
            || '';
        return normalizeJid(candidate);
    } catch {
        return normalizeJid(raw);
    }
}

function extractStubParticipants(message) {
    const participants = (message?.messageStubParameters || [])
        .map(parseStubParticipant)
        .filter((jid) => jid.includes('@'));

    if (!participants.length && JOIN_STUB_TYPES.has(message?.messageStubType)) {
        const actor = parseStubParticipant(message?.key?.participant);
        if (actor) participants.push(actor);
    }

    return [...new Set(participants)];
}

async function sendWelcomeIfNeeded({ sock, db, groupId, playerId, displayName, quotedMessage }) {
    if (!groupId?.endsWith('@g.us')) return false;
    if (!playerId || isSameUser(playerId, sock.user?.id)) return false;
    if (!await isGroupEnabled(db, groupId)) return false;

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

function parseRollNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function isCancelText(value) {
    return ['cancelar', 'cancela', 'nao', 'não'].includes(normalizeText(value));
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

    await setSelectedRollForMagic(db, idJogador, roll.roll_number);
    await savePendingMagicConfirmation(db, idJogador, choice.label, roll.roll_number);
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
        text: renderMagicConfirmationMessage(availability, roll),
    });
    return true;
}

async function tryHandleMagicPlainText({ sock, db, m, idChat, idJogador, texto }) {
    const cleanText = String(texto || '').trim();
    if (!cleanText || cleanText.startsWith(COMMAND_PREFIX)) return false;

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
                            '*⚠️ Essa reserva nao esta mais disponivel.*',
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

        const pending = await getPendingMagicConfirmation(db, idJogador);
        if (pending) {
            const availability = await getMagicAvailability(db, pending.magic_label, idJogador);
            const pendingRoll = pending.roll_number
                ? await getPlayerRollByNumber(db, idJogador, pending.roll_number)
                : selectedRoll;
            if (availability) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderMagicConfirmationMessage(availability, pendingRoll),
                });
            }
            return true;
        }
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
    const choice = findMagicOption(options, cleanText);
    if (!choice) return false;

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
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const logger = P({ level: 'silent' });
    const db = await criarBanco();

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['Windows', 'Chrome', '130.0.0.0'],
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const errorCode = lastDisconnect?.error?.output?.statusCode;
            if (errorCode === DisconnectReason.loggedOut) {
                console.log('Sessao encerrada. Apague a pasta "auth_info" e inicie novamente.');
            } else {
                setTimeout(() => iniciarBot(), 5000);
            }
        } else if (connection === 'open') {
            console.log('Bot online.');
            logCurrentActivationCode();
        }
    });

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (!ENABLE_LEGACY_BC) return;

        const groupEnabled = await isGroupEnabled(db, id);

        for (const participant of participants || []) {
            const participantJid = parseStubParticipant(participant);
            if (!participantJid || isSameUser(participantJid, sock.user?.id)) continue;

            try {
                if (action === 'remove') {
                    await clearGroupMemberState(db, id, participantJid);
                    continue;
                }

                if (!groupEnabled) continue;
                if (action !== 'add') continue;

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

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m || (!m.message && !m.messageStubType) || m.key.fromMe) return;

        const idChat = m.key.remoteJid;
        const isGroup = idChat.endsWith('@g.us');
        const idJogador = isGroup ? m.key.participant : idChat;
        const stubType = m.messageStubType;
        const texto =
            m.message?.conversation
            || m.message?.extendedTextMessage?.text
            || m.message?.imageMessage?.caption
            || '';

        if (ENABLE_LEGACY_BC && isGroup && await isGroupEnabled(db, idChat)) {
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

        if (isDevoMessage(texto)) {
            const groupEnabled = isGroup ? await isGroupEnabled(db, idChat) : true;
            if (isGroup && !groupEnabled) return;

            try {
                await handleDevoMessage({
                    sock,
                    m,
                    idChat,
                    idJogador,
                    texto,
                    db,
                    isGroup,
                    groupEnabled,
                    legacyBcEnabled: ENABLE_LEGACY_BC,
                });
            } catch (err) {
                console.log('Erro no dispatcher Devo:', err);
                await sock.sendMessage(idChat, { text: 'Erro ao executar comando Devo.' });
            }
            return;
        }

        if (ENABLE_LEGACY_BC && await tryHandleMagicPlainText({ sock, db, m, idChat, idJogador, texto })) {
            return;
        }

        if (!texto.startsWith(COMMAND_PREFIX)) return;

        const resolvedCommand = resolveCommand(texto, comandos);
        if (!resolvedCommand) return;

        const groupEnabled = isGroup ? await isGroupEnabled(db, idChat) : true;
        const bypassGroupGate = isGroup && resolvedCommand.command.groupBypass;
        if (isGroup && !groupEnabled && !bypassGroupGate) return;

        console.log(`Comando recebido de [${m.pushName}]:\n${texto}`);

        const nomeUsuario = m.pushName || 'Cacador';

        try {
            await resolvedCommand.command.executar({
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
        } catch (err) {
            console.log(`Erro no comando ${resolvedCommand.matchedName}:`, err);
            await sock.sendMessage(idChat, { text: 'Erro ao executar o comando.' });
        }
    });
}

iniciarBot();
