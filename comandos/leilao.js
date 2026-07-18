'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { MarketServiceError, cancelMarketListing, createMarketListing, listMarket } = require('../helpers/clover/marketService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}leilao`,
    aliases: [`${COMMAND_PREFIX}leilão`],
    descricao: 'Consulta e cria leilões de 24, 48 ou 72 horas.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (action === 'criar') {
                const result = await createMarketListing(db, idJogador, {
                    type: 'auction', inventoryItemId: Number(tokens[1]), quantity: Number(tokens[2] || 1),
                    startingBid: Number(tokens[3]), durationHours: Number(tokens[4] || 24),
                }, { via: 'bot' });
                await sendReply({ sock, idChat, m, text: `Leilão *${result.listing.key}* criado. Taxa: ${money(result.publicationFee)}. Encerra em ${result.listing.endsAt}.` });
                return;
            }
            if (action === 'cancelar') {
                await cancelMarketListing(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: 'Leilão sem lances cancelado. A taxa de publicação não é devolvida.' });
                return;
            }
            const listings = await listMarket(db, idJogador, { type: 'auction', limit: 20 });
            const active = listings.filter((item) => item.status === 'active');
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐋𝐄𝐈𝐋𝐎̃𝐄𝐒 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*', '',
                    ...(active.length ? active.map((item) => `*${item.key}* · ${item.itemName} · ${money(item.currentBid ?? item.startingBid)} · encerra ${item.endsAt}`) : ['> Nenhum leilão ativo.']),
                    '', `Criar: *${COMMAND_PREFIX}leilao criar <item_id> <qtd> <lance_inicial> <24|48|72>*`,
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
