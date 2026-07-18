'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    MarketServiceError,
    cancelMarketPurchase,
    confirmMarketPurchase,
    listMarket,
    previewMarketPurchase,
} = require('../helpers/clover/marketService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}mercado`,
    aliases: [],
    descricao: 'Consulta e compra anúncios de preço fixo.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (action === 'confirmar') {
                const result = await confirmMarketPurchase(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: `Compra concluída por ${money(result.intent.total)}. O item entrou no inventário.` });
                return;
            }
            if (action === 'cancelar') {
                await cancelMarketPurchase(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: 'Compra cancelada e saldo liberado.' });
                return;
            }
            if (action === 'comprar') {
                const result = await previewMarketPurchase(db, idJogador, tokens[1], Number(tokens[2] || 1), {
                    idempotencyKey: `market-buy:${idChat}:${m?.key?.id || Date.now()}`,
                    via: 'bot',
                });
                await sendReply({
                    sock, idChat, m,
                    text: [
                        '*♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐌𝐄𝐑𝐂𝐀𝐃𝐎 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*',
                        '',
                        `*Item:* ${result.listing.itemName} x${result.intent.quantity}`,
                        `*Total:* ${money(result.intent.total)}`,
                        '',
                        `> Confirme em 2 minutos: ${COMMAND_PREFIX}mercado confirmar ${result.intent.intent_key}`,
                    ].join('\n'),
                });
                return;
            }
            const listings = await listMarket(db, idJogador, { type: 'fixed', limit: 20 });
            const active = listings.filter((item) => item.status === 'active' && item.availableQuantity > 0);
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐌𝐄𝐑𝐂𝐀𝐃𝐎 𝐃𝐄 𝐉𝐎𝐆𝐀𝐃𝐎𝐑𝐄𝐒 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*',
                    '',
                    ...(active.length ? active.map((item) => `*${item.key}* · ${item.itemName} · x${item.availableQuantity} · ${money(item.unitPrice)} cada`) : ['> Nenhum anúncio disponível.']),
                    '',
                    `Use *${COMMAND_PREFIX}mercado comprar <código> [qtd]*.`,
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
