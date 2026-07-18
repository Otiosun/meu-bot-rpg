'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { MarketServiceError, cancelMarketListing, createMarketListing, quoteMarketListing } = require('../helpers/clover/marketService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}anunciar`,
    aliases: [],
    descricao: 'Publica item no Mercado de Jogadores.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (String(tokens[0] || '').toLowerCase() === 'cancelar') {
                const result = await cancelMarketListing(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: `Anúncio cancelado. A taxa de ${money(result.listing.publicationFee)} não é devolvida.` });
                return;
            }
            if (tokens.length < 3) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}anunciar <item_id> <qtd> <preço_unitário>*.` });
                return;
            }
            const input = {
                type: 'fixed', inventoryItemId: Number(tokens[0]), quantity: Number(tokens[1]), unitPrice: Number(tokens[2]),
            };
            if (String(tokens[3] || '').toLowerCase() !== 'confirmar') {
                const quote = await quoteMarketListing(db, idJogador, input);
                await sendReply({
                    sock, idChat, m,
                    text: [
                        '*♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐀𝐍𝐔́𝐍𝐂𝐈𝐎*', '',
                        `*Item:* ${quote.item.item_name} x${quote.quantity}`,
                        `*Preço unitário:* ${money(quote.price)}`,
                        `*Total anunciado:* ${money(quote.announcedTotal)}`,
                        `*Taxa cobrada agora:* ${money(quote.publicationFee)} — não reembolsável`, '',
                        `Confirmar: *${COMMAND_PREFIX}anunciar ${tokens[0]} ${tokens[1]} ${tokens[2]} confirmar*`,
                    ].join('\n'),
                });
                return;
            }
            const result = await createMarketListing(db, idJogador, {
                ...input,
            }, { via: 'bot', idempotencyKey: `market-listing:${idChat}:${m?.key?.id || Date.now()}` });
            await sendReply({
                sock, idChat, m,
                text: `Anúncio *${result.listing.key}* publicado. Taxa: ${money(result.publicationFee)}. O item ficou reservado até venda, cancelamento ou vencimento.`,
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
