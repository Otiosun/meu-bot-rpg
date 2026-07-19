'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { EconomyServiceError, useConsumable } = require('../helpers/clover/economyService');

module.exports = {
    nome: `${COMMAND_PREFIX}usar`,
    aliases: [],
    descricao: 'Registra o uso de consumível ou kit da Economia V1.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const itemId = Number(tokens[0]);
        if (!Number.isInteger(itemId)) {
            await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}usar <id do item> [contexto]*.` });
            return;
        }
        try {
            const messageId = m?.key?.id || `${Date.now()}`;
            const result = await useConsumable(db, idJogador, itemId, {
                contextType: tokens[1] || 'livre',
                contextId: tokens[2] || null,
                idempotencyKey: `consumable:${idChat}:${messageId}`,
                via: 'bot',
            });
            await sendReply({
                sock, idChat, m,
                text: result.result === 'overload'
                    ? 'O terceiro aprimoramento não ativou. Uso registrado: Cansado por Sobrecarga Alquímica; o narrador aplica a condição na cena.'
                    : 'Uso registrado. O narrador aplica o efeito conforme a cena e o cartão do item.',
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
