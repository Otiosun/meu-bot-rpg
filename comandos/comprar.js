'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    EconomyServiceError,
    cancelPurchase,
    confirmPurchase,
    previewPurchase,
} = require('../helpers/clover/economyService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}comprar`,
    aliases: [],
    descricao: 'Simula e confirma compras nas lojas NPC.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (action === 'confirmar') {
                const result = await confirmPurchase(db, idJogador, tokens[1]);
                await sendReply({
                    sock, idChat, m,
                    text: result.purchase.status === 'in_transport'
                        ? `Compra confirmada. Total: ${money(result.purchase.total)}. Entrega prevista: ${result.purchase.deliverAt}.`
                        : `Compra concluída. Total: ${money(result.purchase.total)}. Item entregue ao inventário.`,
                });
                return;
            }
            if (action === 'cancelar' || action === 'devolver') {
                const result = await cancelPurchase(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: result.refunded ? `Devolução concluída: ${money(result.refunded)} estornados.` : 'Compra pendente cancelada sem cobrança.' });
                return;
            }
            if (!tokens[0]) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}comprar <código> [qtd] [expresso] [vale]*.` });
                return;
            }
            const quantity = /^\d+$/.test(tokens[1] || '') ? Number(tokens[1]) : 1;
            const flags = new Set(tokens.map((token) => token.toLowerCase()));
            const messageId = m?.key?.id || `${Date.now()}`;
            const result = await previewPurchase(db, idJogador, tokens[0], quantity, {
                express: flags.has('expresso'),
                useVoucher: flags.has('vale'),
                via: 'bot',
                idempotencyKey: `purchase-preview:${idChat}:${messageId}`,
            });
            const purchase = result.purchase;
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐂𝐎𝐌𝐏𝐑𝐀 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*',
                    '',
                    `*Item:* ${result.listing?.itemName || purchase.listingKey} x${purchase.quantity}`,
                    `*Produtos:* ${money(purchase.subtotal)}`,
                    purchase.regionalFee ? `*Taxa regional:* ${money(purchase.regionalFee)}` : null,
                    purchase.expressFee ? `*Expresso:* ${money(purchase.expressFee)}` : null,
                    purchase.discount ? `*Vale:* -${money(purchase.discount)}` : null,
                    `*Total:* ${money(purchase.total)}`,
                    `*Prazo:* ${result.listing?.availability === 'regional' ? (purchase.express ? '1 hora' : '4 horas') : 'imediato'}`,
                    '',
                    `> Confirme em 2 minutos: ${COMMAND_PREFIX}comprar confirmar ${purchase.key}`,
                ].filter(Boolean).join('\n'),
            });
        } catch (error) {
            if (error instanceof EconomyServiceError || error?.name === 'YullsServiceError') {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
