const { DEVO_PREFIX } = require('../../../../config/bot');

const DEVO_MODULE_NAME = 'Devo / Deadly Vote';
const DEVO_BASE_VERSION = '0.1.0-base';
const ACTIVE_DEVO_COMMANDS = ['ping', 'status', 'help', 'record', 'tempo', 'life', 'dv', 'convocacoes', 'entrar', 'recusar'];

module.exports = {
    ACTIVE_DEVO_COMMANDS,
    DEVO_BASE_VERSION,
    DEVO_MODULE_NAME,
    DEVO_PREFIX,
};
