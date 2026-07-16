'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { getPlayerTechnicalCapacity } = require('../helpers/clover/capacityService');
const { getCharacterBonusSummary } = require('../helpers/clover/characterBonusService');
const { getCavalierSummary } = require('../helpers/clover/cavalierService');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const {
    renderProfileCompact,
    renderProfileFull,
} = require('../helpers/clover/playerOverviewPresentation');
const {
    ACCESS_PERMISSIONS,
    authorizeCharacterCommandAccess,
} = require('../helpers/clover/accessIntegrationService');
const {
    getPlayerById,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');

function normalizeAction(value) {
    return normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
}

function resolveViewMode(body) {
    const action = normalizeAction(body);
    if (!action || ['resumo', 'compacto', 'rapido'].includes(action)) return 'compact';
    if (['completo', 'full', 'detalhado', 'detalhes', 'tecnico'].includes(action)) return 'full';
    return null;
}

async function resolveProfileRequest({ db, body, m, idJogador }) {
    const parsed = resolveTargetAndRest(body, m);
    const bodyMode = resolveViewMode(body);
    if (parsed.source === 'none' || (parsed.source === 'body' && bodyMode)) {
        const player = await getPlayerById(db, idJogador);
        return {
            ok: true,
            player: player || { id: idJogador },
            modeText: String(body || '').trim(),
            explicit: false,
        };
    }

    const resolved = await resolveTargetPlayer(db, parsed.targetId, parsed.targetText, {
        rejectEmptyCharacter: false,
    });
    if (!resolved.ok) return resolved;
    return {
        ok: true,
        player: resolved.player,
        modeText: parsed.rest,
        explicit: true,
    };
}

function renderUsage() {
    return [
        '*♧┃𝐏𝐄𝐑𝐅𝐈𝐋 𝐃𝐎 𝐌𝐀𝐆𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `> ${COMMAND_PREFIX}perfil`,
        `> ${COMMAND_PREFIX}perfil completo`,
        `> ${COMMAND_PREFIX}perfil @player`,
        `> ${COMMAND_PREFIX}perfil @player completo`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}perfil`,
    descricao: 'Mostra o resumo ou a visão completa do personagem conforme o cargo.',
    gameCommand: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const request = await resolveProfileRequest({ db, body, m, idJogador });
        if (!request.ok) {
            await sendReply({ sock, idChat, m, text: request.error || 'Não encontrei esse personagem.' });
            return;
        }

        const mode = resolveViewMode(request.modeText);
        if (!mode) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const targetId = request.player.id;
        const ownView = isSameUser(targetId, idJogador);
        const access = await authorizeCharacterCommandAccess({
            db,
            sock,
            idChat,
            actorId: idJogador,
            targetPlayer: request.player,
            permission: ACCESS_PERMISSIONS.PROFILE_READ,
            allowSelf: true,
            allowLegacyAdmin: true,
        });
        if (!access.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Você não possui acesso ao perfil desse personagem.',
            });
            return;
        }

        if (ownView) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (!phaseInfo.canPlay) {
                await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
                return;
            }
        }

        const capacity = await getPlayerTechnicalCapacity(db, targetId);
        if (!capacity.ok) {
            await sendReply({ sock, idChat, m, text: 'Não encontrei esse personagem no banco.' });
            return;
        }

        const [bonusSummary, cavalierSummary] = await Promise.all([
            getCharacterBonusSummary(db, targetId),
            getCavalierSummary(db, targetId),
        ]);
        const text = mode === 'full'
            ? renderProfileFull(capacity, bonusSummary, cavalierSummary, { prefix: COMMAND_PREFIX })
            : renderProfileCompact(capacity, bonusSummary, cavalierSummary, { prefix: COMMAND_PREFIX });
        await sendReply({
            sock,
            idChat,
            m,
            mentions: request.explicit ? [targetId] : [],
            text,
        });
    },
    renderUsage,
    resolveProfileRequest,
    resolveViewMode,
};
