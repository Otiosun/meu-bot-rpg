'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    EconomyServiceError,
    confirmNpcSale,
    previewNpcSale,
} = require('../helpers/clover/economyService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}vender`,
    aliases: [],
    descricao: 'Mostra e confirma a oferta de revenda para NPC.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (String(tokens[0] || '').toLowerCase() === 'confirmar') {
                const result = await confirmNpcSale(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: `Venda concluída: +${money(result.sale.offerTotal)}.` });
                return;
            }
            const itemId = Number(tokens[0]);
            if (!Number.isInteger(itemId)) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}vender <id do item> [qtd]*.` });
                return;
            }
            const quantity = /^\d+$/.test(tokens[1] || '') ? Number(tokens[1]) : 1;
            const messageId = m?.key?.id || `${Date.now()}`;
            const result = await previewNpcSale(db, idJogador, itemId, quantity, {
                via: 'bot', idempotencyKey: `npc-sale-preview:${idChat}:${messageId}`,
            });
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐎𝐅𝐄𝐑𝐓𝐀 𝐃𝐄 𝐍𝐏𝐂 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*',
                    '',
                    `*Item:* ${result.item.item_name} x${result.sale.quantity}`,
                    `*Condição:* ${result.item.condition || 'comum'}`,
                    `*Taxa de revenda:* ${result.sale.offerPercent}%`,
                    `*Oferta:* ${money(result.sale.offerTotal)}`,
                    '',
                    `> Confirme em 2 minutos: ${COMMAND_PREFIX}vender confirmar ${result.sale.key}`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof EconomyServiceError || error?.name === 'InventoryServiceError') {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
