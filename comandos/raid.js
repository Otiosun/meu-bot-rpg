'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    RaidServiceError,
    getRaidDashboard,
    joinRaid,
    leaveRaid,
    listActorRaids,
} = require('../helpers/clover/raidService');
const { getPublicSiteUrl } = require('../helpers/clover/sitePublicUrl');

function raidLink(raidKey) {
    try {
        const url = new URL(getPublicSiteUrl());
        url.searchParams.set('raid', raidKey);
        return url.toString();
    } catch {
        return getPublicSiteUrl();
    }
}

function statusLabel(status) {
    return ({
        lobby: 'Lobby aberto',
        in_progress: 'Em andamento',
        finalization: 'Finalização',
        completed: 'Concluída',
        cancelled: 'Cancelada',
    })[status] || status;
}

function renderRaidList(raids) {
    if (!raids.length) {
        return [
            '*♧┃𝐑𝐀𝐈𝐃𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Você ainda não participa nem controla uma raid.',
        ].join('\n');
    }
    return [
        '*♧┃𝐑𝐀𝐈𝐃𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        ...raids.map((raid) => `*${raid.name}* · ${statusLabel(raid.status)}\n> ${raid.key}`),
        '',
        `> Use ${COMMAND_PREFIX}raid <código> para abrir o resumo.`,
    ].join('\n');
}

function renderRaidDashboard(dashboard) {
    const raid = dashboard.raid;
    return [
        '*♧┃𝐋𝐎𝐁𝐁𝐘 𝐃𝐄 𝐑𝐀𝐈𝐃 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Nome:* ${raid.name}`,
        `*Categoria:* ${raid.category}`,
        `*Estado:* ${statusLabel(raid.status)}`,
        `*Local:* ${raid.location}`,
        `*Participantes:* ${dashboard.participants.length}/${raid.maxPlayers}`,
        `*Código:* ${raid.key}`,
        '',
        '*Link:*',
        raidLink(raid.key),
        '',
        raid.status === 'lobby'
            ? `> Entrar: ${COMMAND_PREFIX}raid entrar ${raid.key}`
            : '> A entrada foi encerrada quando a raid começou.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}raid`,
    aliases: [`${COMMAND_PREFIX}raids`],
    descricao: 'Consulta raids e permite entrar ou sair de uma missão.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (['listar', 'lista', 'minhas', 'meus'].includes(action)) {
                await sendReply({ sock, idChat, m, text: renderRaidList(await listActorRaids(db, idJogador)) });
                return;
            }
            if (action === 'status') {
                if (!tokens[1]) throw new RaidServiceError('raid_key_required', 'Informe o código da raid.');
                const dashboard = await getRaidDashboard(db, tokens[1], idJogador);
                await sendReply({ sock, idChat, m, text: renderRaidDashboard(dashboard) });
                return;
            }
            if (action === 'entrar') {
                if (!tokens[1]) throw new RaidServiceError('raid_key_required', 'Informe o código da raid.');
                const result = await joinRaid(db, tokens[1], idJogador, { via: 'bot' });
                const dashboard = await getRaidDashboard(db, result.raid.key, idJogador);
                await sendReply({ sock, idChat, m, text: renderRaidDashboard(dashboard) });
                return;
            }
            if (action === 'sair') {
                if (!tokens[1]) throw new RaidServiceError('raid_key_required', 'Informe o código da raid.');
                await leaveRaid(db, tokens[1], idJogador);
                await sendReply({ sock, idChat, m, text: 'Sua saída foi registrada. Os itens ainda reservados foram liberados e você não receberá a premiação final.' });
                return;
            }
            if (tokens[0]) {
                const dashboard = await getRaidDashboard(db, tokens[0], idJogador);
                await sendReply({ sock, idChat, m, text: renderRaidDashboard(dashboard) });
                return;
            }
            await sendReply({ sock, idChat, m, text: renderRaidList(await listActorRaids(db, idJogador)) });
        } catch (error) {
            if (error instanceof RaidServiceError) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
    raidLink,
    renderRaidDashboard,
    renderRaidList,
};
