'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { MarketServiceError, placeAuctionBid } = require('../helpers/clover/marketService');

module.exports = {
    nome: `${COMMAND_PREFIX}lance`,
    aliases: [],
    descricao: 'Registra lance reservado em um leilão.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const [listingKey, amount] = String(body || '').trim().split(/\s+/);
        try {
            const result = await placeAuctionBid(db, idJogador, listingKey, Number(amount), {
                idempotencyKey: `auction-bid:${idChat}:${m?.key?.id || Date.now()}`,
                via: 'bot',
            });
            await sendReply({
                sock, idChat, m,
                text: `Lance registrado: ${Number(result.bid.amount).toLocaleString('pt-BR')}¥.${result.extended ? ' Anti-sniping aplicado: +5 minutos.' : ''} Próximo mínimo: ${Number(result.minimumNext).toLocaleString('pt-BR')}¥.`,
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
