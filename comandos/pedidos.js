'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { MarketServiceError, fulfillWeeklyNpcRequest, listWeeklyNpcRequests } = require('../helpers/clover/marketService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}pedidos`,
    aliases: [`${COMMAND_PREFIX}pedidosemanais`],
    descricao: 'Consulta e atende pedidos semanais de NPCs.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (String(tokens[0] || '').toLowerCase() === 'entregar') {
                const result = await fulfillWeeklyNpcRequest(db, idJogador, tokens[1], Number(tokens[2]), Number(tokens[3] || 1), {
                    idempotencyKey: `weekly-request:${idChat}:${m?.key?.id || Date.now()}`,
                    via: 'bot',
                });
                await sendReply({ sock, idChat, m, text: `Entrega concluída. Você recebeu ${money(result.delivery.total)}.` });
                return;
            }
            const requests = await listWeeklyNpcRequests(db, idJogador);
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐏𝐄𝐃𝐈𝐃𝐎𝐒 𝐒𝐄𝐌𝐀𝐍𝐀𝐈𝐒 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*', '',
                    ...requests.map((item) => `*${item.key}* · ${item.itemName} · ${money(item.unitPrice)} · global ${item.deliveredQuantity}/${item.globalQuantity} · seu ${item.playerDelivered}/${item.personalLimit}`),
                    '', `Entregar: *${COMMAND_PREFIX}pedidos entregar <código> <item_id> [qtd]*`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof MarketServiceError || ['YullsServiceError', 'InventoryServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
