const { sendReply } = require('../../../helpers/chatReply');
const { DEVO_PREFIX } = require('./constants/devoConstants');
const { getMigrationStatus } = require('./migrations/migrationRunner');
const { createDevoServices } = require('./services');
const { renderHelp, renderStatus, renderUnknownCommand } = require('./views/devoViews');

function normalizeCommand(value) {
    return String(value || '').trim().toLowerCase();
}

function isDevoMessage(text) {
    const trimmed = String(text || '').trim();
    const normalizedPrefix = DEVO_PREFIX.toLowerCase();
    const normalizedText = trimmed.toLowerCase();

    return normalizedText === normalizedPrefix
        || normalizedText.startsWith(`${normalizedPrefix} `)
        || normalizedText.startsWith(`${normalizedPrefix}\n`);
}

function parseDevoMessage(text) {
    const trimmed = String(text || '').trim();
    const body = trimmed.slice(DEVO_PREFIX.length).trim();
    const parts = body ? body.split(/\s+/).filter(Boolean) : [];
    const commandName = normalizeCommand(parts[0] || 'help');

    return {
        body,
        commandName,
        args: parts.slice(1),
    };
}

async function reply({ sock, idChat, m }, text) {
    return sendReply({ sock, idChat, m, text });
}

async function handleDevoMessage(context) {
    const parsed = parseDevoMessage(context.texto);
    const services = createDevoServices({ db: context.db });

    if (parsed.commandName === 'ping') {
        await services.audit.record({ type: 'devo.ping' });
        return reply(context, '*pong*');
    }

    if (parsed.commandName === 'status') {
        await services.audit.record({ type: 'devo.status' });
        const migrationStatus = context.db
            ? await getMigrationStatus(context.db)
            : null;

        return reply(context, renderStatus({
            services,
            isGroup: context.isGroup,
            groupEnabled: context.groupEnabled,
            legacyBcEnabled: context.legacyBcEnabled,
            migrationStatus,
        }));
    }

    if (parsed.commandName === 'help') {
        await services.audit.record({ type: 'devo.help' });
        return reply(context, renderHelp());
    }

    await services.audit.record({
        type: 'devo.unknown_command',
        commandName: parsed.commandName,
    });

    return reply(context, renderUnknownCommand(parsed.commandName));
}

module.exports = {
    handleDevoMessage,
    isDevoMessage,
    parseDevoMessage,
};
