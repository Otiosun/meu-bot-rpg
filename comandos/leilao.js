'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { MarketServiceError, cancelMarketListing, createMarketListing, listMarket, quoteMarketListing } = require('../helpers/clover/marketService');

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
                const input = {
                    type: 'auction', inventoryItemId: Number(tokens[1]), quantity: Number(tokens[2] || 1),
                    startingBid: Number(tokens[3]), durationHours: Number(tokens[4] || 24),
                };
                if (String(tokens[5] || '').toLowerCase() !== 'confirmar') {
                    const quote = await quoteMarketListing(db, idJogador, input);
                    await sendReply({
                        sock, idChat, m,
                        text: [
                            '*♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐋𝐄𝐈𝐋𝐀̃𝐎*', '',
                            `*Item:* ${quote.item.item_name} x${quote.quantity}`,
                            `*Lance inicial:* ${money(quote.price)}`,
                            `*Duração:* ${quote.durationHours} horas`,
                            `*Taxa cobrada agora:* ${money(quote.publicationFee)} — não reembolsável`, '',
                            `Confirmar: *${COMMAND_PREFIX}leilao criar ${tokens[1]} ${tokens[2] || 1} ${tokens[3]} ${tokens[4] || 24} confirmar*`,
                        ].join('\n'),
                    });
                    return;
                }
                const result = await createMarketListing(db, idJogador, input, {
                    via: 'bot', idempotencyKey: `market-auction:${idChat}:${m?.key?.id || Date.now()}`,
                });
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
                    ...(active.length ? active.map((item) => `*${item.key}* · ${item.itemName} x${item.availableQuantity} · ${item.quality || 'comum'}${item.condition ? `/${item.condition}` : ''} · ${money(item.currentBid ?? item.startingBid)} · encerra ${item.endsAt}`) : ['> Nenhum leilão ativo.']),
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
