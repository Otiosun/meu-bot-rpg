const {
    ACTIVE_DEVO_COMMANDS,
    DEVO_BASE_VERSION,
    DEVO_MODULE_NAME,
    DEVO_PREFIX,
} = require('../constants/devoConstants');

function renderHelp() {
    return [
        `*${DEVO_MODULE_NAME}*`,
        '',
        'Comandos ativos nesta base seca:',
        `- *${DEVO_PREFIX} ping*`,
        `- *${DEVO_PREFIX} status*`,
        `- *${DEVO_PREFIX} help*`,
        '',
        'Sistemas de jogo ainda nao foram implementados nesta etapa.',
    ].join('\n');
}

function renderStatus({
    services = {},
    isGroup = false,
    groupEnabled = true,
    legacyBcEnabled = false,
    migrationStatus = null,
} = {}) {
    const serviceNames = Object.keys(services);
    const migrationLine = migrationStatus
        ? `Migrations Devo: ${migrationStatus.applied}/${migrationStatus.total} aplicadas`
        : 'Migrations Devo: indisponivel';
    const pendingLine = migrationStatus?.pending?.length
        ? `Pendentes: ${migrationStatus.pending.map((item) => item.id).join(', ')}`
        : 'Pendentes: nenhuma';

    return [
        `*${DEVO_MODULE_NAME}*`,
        '',
        `Status: online`,
        `Versao: ${DEVO_BASE_VERSION}`,
        `Prefixo: ${DEVO_PREFIX}`,
        `Comandos ativos: ${ACTIVE_DEVO_COMMANDS.join(', ')}`,
        `Contexto: ${isGroup ? 'grupo' : 'privado'}`,
        `Grupo habilitado: ${isGroup ? (groupEnabled ? 'sim' : 'nao') : 'n/a'}`,
        `Legado BC ativo: ${legacyBcEnabled ? 'sim' : 'nao'}`,
        migrationLine,
        pendingLine,
        `Servicos secos carregados: ${serviceNames.length ? serviceNames.join(', ') : 'nenhum'}`,
    ].join('\n');
}

function renderUnknownCommand(commandName) {
    return [
        `Subcomando Devo nao reconhecido: *${commandName || '-'}*`,
        '',
        `Use *${DEVO_PREFIX} help* para ver o que esta ativo agora.`,
    ].join('\n');
}

module.exports = {
    renderHelp,
    renderStatus,
    renderUnknownCommand,
};
