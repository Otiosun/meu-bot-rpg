'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { renderPrototypeTemplate } = require('../helpers/clover/prototypeUniversalEvaluationService');

module.exports = {
    nome: `${COMMAND_PREFIX}fichaprototipo`,
    aliases: [
        `${COMMAND_PREFIX}fichaprotótipo`,
        `${COMMAND_PREFIX}ficha prototipo`,
        `${COMMAND_PREFIX}ficha protótipo`,
    ],
    descricao: 'Mostra a ficha de proposta de Protótipo Humano.',
    gameCommand: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderPrototypeTemplate(),
        });
    },
};
