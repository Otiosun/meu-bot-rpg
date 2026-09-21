'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { runEconomyMutationExclusive } = require('../helpers/clover/economyMutationQueue');
const { getPrShopDashboard } = require('../helpers/clover/prShopService');

function limitText(item) {
    if (item.limits.oneTime) return item.available ? 'compra única disponível' : 'já adquirido';
    if (item.limits.eventGlobal) return `${item.limits.globalPurchased}/${item.limits.eventGlobal} globais`;
    if (item.limits.weekly) return `${item.limits.weeklyPurchased}/${item.limits.weekly} nesta semana`;
    return 'sem limite informado';
}

function renderShop(dashboard) {
    if (!dashboard.event?.active || !dashboard.event?.shopEnabled) {
        return [
            '*♧┃𝐋𝐎𝐉𝐀 𝐃𝐄 𝐏𝐑*',
            '',
            '*Status:* Pausada',
            `*Saldo preservado:* ${dashboard.balance} PR`,
            '',
            '> A antiga Loja de Divulgação está em dormência. Nenhum PR é perdido.',
        ].join('\n');
    }
    const lines = [
        '*♧┃𝐋𝐎𝐉𝐀 𝐒𝐄𝐌𝐀𝐍𝐀𝐋 𝐃𝐄 𝐏𝐑*',
        '     ── estoque vivo do evento ──',
        '',
        `*Saldo:* ${dashboard.balance} PR`,
        `*Semana:* ${dashboard.weekKey}`,
        '',
    ];
    dashboard.items.forEach((item, index) => {
        const state = item.available ? 'disponível' : 'esgotado';
        lines.push(`*${index + 1}. ${item.cost} PR* ─ ${item.name}`);
        lines.push(`> ${limitText(item)} · ${state}`);
    });
    lines.push(
        '',
        `*Comprar:* ${COMMAND_PREFIX}comprardivulga <número ou nome> [quantidade]`,
        `> Ex.: ${COMMAND_PREFIX}comprardivulga 2 3`,
        '',
        '> Estoques semanais viram na segunda-feira. Título, Dungeon e relíquias seguem seus próprios limites.'
    );
    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}lojadivulga`,
    aliases: [
        `${COMMAND_PREFIX}lojapr`,
        `${COMMAND_PREFIX}loja pr`,
        `${COMMAND_PREFIX}lojaderecrutamento`,
        `${COMMAND_PREFIX}loja recrutamento`,
    ],
    descricao: 'Mostra a Loja Semanal de PR e seus estoques reais.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const dashboard = await runEconomyMutationExclusive(
            () => getPrShopDashboard(db, idJogador),
            { operation: 'bot:pr-shop-dashboard' }
        );
        await sendReply({ sock, idChat, m, text: renderShop(dashboard) });
    },
    renderShop,
};
