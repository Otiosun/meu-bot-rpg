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
const { sendReply } = require('../helpers/chatReply');
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

function renderUsage() {
    return [
        '*♧┃𝐏𝐄𝐑𝐅𝐈𝐋 𝐃𝐎 𝐌𝐀𝐆𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `> ${COMMAND_PREFIX}perfil`,
        `> ${COMMAND_PREFIX}perfil completo`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}perfil`,
    descricao: 'Mostra o resumo ou a visão completa do personagem.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        const mode = resolveViewMode(body);
        if (!mode) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        const capacity = await getPlayerTechnicalCapacity(db, idJogador);
        if (!capacity.ok) {
            await sendReply({ sock, idChat, m, text: 'Não encontrei seu personagem no banco.' });
            return;
        }

        const [bonusSummary, cavalierSummary] = await Promise.all([
            getCharacterBonusSummary(db, idJogador),
            getCavalierSummary(db, idJogador),
        ]);
        const text = mode === 'full'
            ? renderProfileFull(capacity, bonusSummary, cavalierSummary, { prefix: COMMAND_PREFIX })
            : renderProfileCompact(capacity, bonusSummary, cavalierSummary, { prefix: COMMAND_PREFIX });
        await sendReply({ sock, idChat, m, text });
    },
    renderUsage,
    resolveViewMode,
};
