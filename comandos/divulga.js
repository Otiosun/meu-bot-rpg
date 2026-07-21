'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getRecruitmentDashboard } = require('../helpers/clover/recruitmentService');
const { getGroupPromotionDashboard } = require('../helpers/clover/recruitmentGroupService');
const { getPublicSiteUrl } = require('../helpers/clover/sitePublicUrl');

function formatPr(value) {
    const amount = Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
    return amount.toLocaleString('pt-BR', {
        minimumFractionDigits: Number.isInteger(amount) ? 0 : 1,
        maximumFractionDigits: 1,
    });
}

function recruitmentLink(code) {
    try {
        const url = new URL('personagem/divulgacao', getPublicSiteUrl());
        url.searchParams.set('codigo', code);
        return url.toString();
    } catch {
        return getPublicSiteUrl();
    }
}

function renderDashboard(dashboard) {
    const event = dashboard.event;
    const groups = dashboard.groupPromotion;
    const status = dashboard.active
        ? 'Ativo'
        : event.status === 'draft'
            ? 'Em preparação'
            : event.status === 'paused'
                ? 'Pausado'
                : 'Encerrado';
    return [
        '*♧┃𝐄𝐕𝐄𝐍𝐓𝐎 𝐃𝐄 𝐃𝐈𝐕𝐔𝐋𝐆𝐀𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Status:* ${status}`,
        `*Seu código:* ${dashboard.code}`,
        `*Seu saldo:* ${formatPr(dashboard.pr.balance)} PR`,
        `*Grupos informados nesta semana:* ${groups.groupsReported}`,
        `*Grupos remunerados:* ${groups.groupsCredited}/${groups.groupLimit}`,
        `*Excedente preservado:* ${groups.groupsExcess}`,
        `*PR por grupos:* ${formatPr(groups.prEarned)}/${formatPr(groups.prLimit)} PR`,
        `*Recrutamentos validados:* ${dashboard.recruiting.validated}`,
        '',
        '*Link de convite:*',
        recruitmentLink(dashboard.code),
        '',
        '*Texto para compartilhar:*',
        `> Venha conhecer o Clover Multicolor! Ao entrar, faça login no site e informe o código *${dashboard.code}*.`,
        '',
        `Cada recrutamento validado concede *${formatPr(event.recruiterPrReward)} PR* ao recrutador.`,
        'A indicação só é validada pelo primeiro UP aprovado do novo player.',
        event.shop.enabled
            ? `Use *${COMMAND_PREFIX}pr* para consultar sua pontuação.`
            : '*Loja de PR:* temporariamente indisponível; seus pontos não expiram.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}divulga`,
    aliases: [
        `${COMMAND_PREFIX}divulgação`,
        `${COMMAND_PREFIX}divulgacao`,
        `${COMMAND_PREFIX}recrutamento`,
        `${COMMAND_PREFIX}indicacoes`,
        `${COMMAND_PREFIX}indicações`,
    ],
    descricao: 'Mostra o código e o painel do Evento de Divulgação.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const dashboard = await getRecruitmentDashboard(db, idJogador);
        dashboard.groupPromotion = await getGroupPromotionDashboard(db, idJogador, {
            eventKey: dashboard.event.key,
        });
        await sendReply({ sock, idChat, m, text: renderDashboard(dashboard) });
    },
    recruitmentLink,
    renderDashboard,
};
