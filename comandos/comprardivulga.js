'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { runEconomyMutationExclusive } = require('../helpers/clover/economyMutationQueue');
const {
    PR_SHOP_CATALOG,
    PrShopServiceError,
    purchasePrShopItem,
} = require('../helpers/clover/prShopService');

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const ITEM_ALIASES = new Map();
PR_SHOP_CATALOG.forEach((item, index) => {
    for (const alias of [item.key, item.name, String(index + 1)]) ITEM_ALIASES.set(normalize(alias), item.key);
});
ITEM_ALIASES.set('yulls', 'yulls_2500');
ITEM_ALIASES.set('caixa simples', 'caixa_simples');
ITEM_ALIASES.set('ph', 'ph_5');
ITEM_ALIASES.set('caixa rara', 'caixa_rara');
ITEM_ALIASES.set('ticket', 'ticket_feitico');
ITEM_ALIASES.set('prioridade', 'cupom_prioridade_feitico');
ITEM_ALIASES.set('titulo', 'titulo_recrutador');
ITEM_ALIASES.set('dungeon', 'dungeon_exclusiva');

function parsePurchase(body) {
    const raw = String(body || '').trim();
    if (!raw) return null;
    const tokens = raw.split(/\s+/);
    let quantity = 1;
    if (/^\d+$/.test(tokens[tokens.length - 1]) && tokens.length > 1) quantity = Number(tokens.pop());
    const input = normalize(tokens.join(' '));
    const direct = ITEM_ALIASES.get(input);
    if (direct) return { itemKey: direct, quantity };
    const candidates = [...ITEM_ALIASES.entries()]
        .filter(([alias]) => alias && (alias.includes(input) || input.includes(alias)))
        .map(([, key]) => key);
    const unique = [...new Set(candidates)];
    return unique.length === 1 ? { itemKey: unique[0], quantity } : null;
}

function rewardText(purchase) {
    const reward = purchase.reward || {};
    if (reward.type === 'yulls') return `+${Number(reward.amount || 0).toLocaleString('pt-BR')}¥`;
    if (reward.type === 'ph') return `+${reward.amount} PH fora do teto`;
    if (reward.type === 'title') return reward.titleName || 'Título de Recrutador';
    if (reward.type === 'item') return `${reward.items?.[0]?.name || purchase.itemKey} x${reward.quantity || purchase.quantity}`;
    return purchase.itemKey;
}

function renderPurchase(purchase) {
    return [
        '*♧┃𝐂𝐎𝐌𝐏𝐑𝐀 𝐃𝐄 𝐏𝐑 𝐂𝐎𝐍𝐂𝐋𝐔Í𝐃𝐀*',
        '',
        `*Recompensa:* ${rewardText(purchase)}`,
        `*Quantidade:* ${purchase.quantity}`,
        `*Custo:* ${purchase.totalPrCost} PR`,
        `*Saldo restante:* ${purchase.balanceAfter ?? purchase.dashboard?.balance ?? '-'} PR`,
        '',
        '> A compra foi registrada. Repetir a mesma mensagem não duplica a entrega.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}comprardivulga`,
    aliases: [
        `${COMMAND_PREFIX}comprarpr`,
        `${COMMAND_PREFIX}comprar pr`,
        `${COMMAND_PREFIX}comprarrecrutamento`,
    ],
    descricao: 'Compra uma recompensa da Loja Semanal de PR.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const parsed = parsePurchase(body);
        if (!parsed) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `Use *${COMMAND_PREFIX}comprardivulga <número ou nome> [quantidade]*. Consulte *${COMMAND_PREFIX}lojadivulga*.`,
            });
            return;
        }
        try {
            const messageId = m?.key?.id || `${Date.now()}`;
            const purchase = await runEconomyMutationExclusive(
                () => purchasePrShopItem(db, idJogador, parsed.itemKey, parsed.quantity, {
                    idempotencyKey: `prshop:${idChat}:${messageId}`,
                    createdBy: idJogador,
                    via: 'bot',
                }),
                { operation: `bot:pr-shop-purchase:${parsed.itemKey}` }
            );
            await sendReply({ sock, idChat, m, text: renderPurchase(purchase) });
        } catch (error) {
            if (error instanceof PrShopServiceError || ['PrServiceError', 'InventoryServiceError', 'YullsServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
    parsePurchase,
    renderPurchase,
};
