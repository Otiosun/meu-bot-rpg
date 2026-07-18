'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { MarketServiceError, cancelMarketListing, createMarketListing } = require('../helpers/clover/marketService');

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
            const result = await createMarketListing(db, idJogador, {
                type: 'fixed', inventoryItemId: Number(tokens[0]), quantity: Number(tokens[1]), unitPrice: Number(tokens[2]),
            }, { via: 'bot' });
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
