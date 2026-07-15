'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { executePaCommand } = require('../helpers/clover/paCommandService');

module.exports = {
    nome: `${COMMAND_PREFIX}pa`,
    aliases: [
        `${COMMAND_PREFIX}servico`,
        `${COMMAND_PREFIX}serviço`,
        `${COMMAND_PREFIX}salarioadm`,
        `${COMMAND_PREFIX}salárioadm`,
        `${COMMAND_PREFIX}servicoadm`,
        `${COMMAND_PREFIX}serviçoadm`,
    ],
    descricao: 'Mostra a carteira, a loja semanal e o histórico de PA dos avaliadores.',
    groupBypass: true,
    executar: executePaCommand,
};