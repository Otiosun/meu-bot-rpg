'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { assertTransitionLaunchEnabled } = require('../helpers/clover/preResetTransitionService');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('../helpers/clover/preResetCampaignStateService');

async function getAssignedReturnState(db, playerId) {
    const id = String(playerId || '').trim();
    if (!id) return Object.freeze({ kind: 'unassigned', reason: 'missing_player_id' });

    const roster = await db.get(
        `SELECT campaign_key, status, revision, finalized_at
         FROM clover_prereset_launch_rosters
         WHERE campaign_key = ?`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY]
    );

    if (!roster || roster.status !== 'finalized') {
        return Object.freeze({ kind: 'unavailable', roster: roster || null });
    }

    const assignment = await db.get(
        `SELECT campaign_key, player_id, roster_revision, outcome, status
         FROM clover_prereset_launch_players
         WHERE campaign_key = ? AND player_id = ?`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY, id]
    );

    if (assignment) {
        if (assignment.outcome === 'keep') {
            return Object.freeze({ kind: 'keep', roster, assignment });
        }
        if (assignment.outcome === 'reset') {
            return Object.freeze({ kind: 'reset', roster, assignment });
        }
        return Object.freeze({ kind: 'unassigned', roster, assignment, reason: 'invalid_roster_outcome' });
    }

    const player = await db.get(
        `SELECT id, ficha_status, personagem_nome
         FROM jogadores
         WHERE id = ?`,
        [id]
    );

    const approvedLegacy = String(player?.ficha_status || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase() === 'aprovada';

    if (!player || !approvedLegacy) {
        return Object.freeze({ kind: 'new_player', roster, player: player || null });
    }

    // Fail closed: an approved legacy character must have a frozen roster assignment.
    return Object.freeze({ kind: 'unassigned', roster, player, reason: 'approved_player_missing_from_finalized_roster' });
}

function renderAssignedReturnState(state) {
    if (state.kind === 'keep') {
        return [
            '♧┃𝐑𝐄𝐓𝐎𝐑𝐍𝐎 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫',
            '',
            '*Situação: MANTER*',
            '',
            'Seu personagem está na lista administrativa de preservação.',
            'Ele será mantido automaticamente como base da nova fase.',
            '',
            '*Você não precisa escolher nem confirmar nada.*',
            'O jogo normal permanece congelado durante o PRE_RESET.',
        ].join('\n');
    }

    if (state.kind === 'reset') {
        return [
            '♧┃𝐑𝐄𝐓𝐎𝐑𝐍𝐎 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫',
            '',
            '*Situação: RESET AUTOMÁTICO*',
            '',
            'Seu personagem não está na lista administrativa de preservação.',
            'Ele será resetado automaticamente no lançamento da nova fase.',
            '',
            '*Você não precisa escolher nem confirmar nada.*',
            'O reset destrutivo ainda não foi executado.',
        ].join('\n');
    }

    if (state.kind === 'new_player') {
        return [
            '♧┃𝐍𝐎𝐕𝐀 𝐆𝐄𝐑𝐀𝐂̧𝐀̃𝐎',
            '',
            'Você não possui personagem antigo aprovado dentro do roster de lançamento.',
            'Seu fluxo não depende de MANTER ou RESETAR.',
        ].join('\n');
    }

    if (state.kind === 'unavailable') {
        return [
            '♧┃𝐑𝐄𝐓𝐎𝐑𝐍𝐎 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫',
            '',
            'O roster administrativo de lançamento ainda não está disponível.',
            'Nenhuma escolha foi solicitada e nada foi resetado.',
        ].join('\n');
    }

    return [
        '♧┃𝐑𝐄𝐓𝐎𝐑𝐍𝐎 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫',
        '',
        'Sua situação não pôde ser ligada com segurança ao roster finalizado.',
        'Nenhuma escolha foi solicitada e nada foi resetado.',
        '',
        'A administração precisa revisar este vínculo.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}retorno`,
    aliases: [`${COMMAND_PREFIX}return`],
    descricao: 'Consulta o resultado administrativo do PRE_RESET: MANTER ou RESET automático.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        assertTransitionLaunchEnabled(process.env);
        const state = await getAssignedReturnState(db, idJogador);
        await sendReply({ sock, idChat, m, text: renderAssignedReturnState(state) });
    },
    getAssignedReturnState,
    renderAssignedReturnState,
};
