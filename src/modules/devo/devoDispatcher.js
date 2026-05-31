const { sendReply } = require('../../../helpers/chatReply');
const { DEVO_PREFIX } = require('./constants/devoConstants');
const { getMigrationStatus } = require('./migrations/migrationRunner');
const { createDevoServices } = require('./services');
const {
    renderHelp,
    renderStatus,
    renderUnknownCommand,
    renderRecordUsage,
    renderRecordCreated,
    renderRecordView,
    renderRecordList,
} = require('./views/devoViews');
const { isOwner, isSameUser } = require('../../../helpers/groupAccess');

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

    if (parsed.commandName === 'record') {
        const sub = normalizeCommand(parsed.args[0] || '');

        async function isManagerOrOwner(actorId) {
            if (isOwner(actorId)) return true;
            const mgr = await services.manager.getByUserId(actorId);
            return Boolean(mgr && Number(mgr.permission_level) >= 1 && mgr.active);
        }

        // record criar <target> | <name>
        if (sub === 'criar') {
            const m = parsed.body.match(/^record\s+criar\s+(.+)$/i);
            if (!m) {
                await services.audit.record({ type: 'devo.record.create_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderRecordUsage());
            }

            const rest = m[1].trim();
            const parts = rest.split('|').map((s) => String(s || '').trim()).filter(Boolean);
            if (parts.length < 2) {
                await services.audit.record({ type: 'devo.record.create_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderRecordUsage());
            }

            const targetRaw = parts[0];
            const name = parts.slice(1).join(' | ');
            if (!targetRaw || !name) {
                await services.audit.record({ type: 'devo.record.create_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderRecordUsage());
            }

            // resolve numeric targets (manager number or player roll number) BEFORE self-check
            let targetUserId = targetRaw;
            if (/^\d+$/.test(targetRaw) && context.db) {
                try {
                    const row = await context.db.get('SELECT user_id FROM manager_profiles WHERE number = ?', [Number(targetRaw)]);
                    if (row?.user_id) targetUserId = row.user_id;
                    else {
                        const p = await context.db.get('SELECT id FROM jogadores WHERE numero_roll_escolhido = ?', [Number(targetRaw)]);
                        if (p?.id) targetUserId = p.id;
                    }
                } catch (e) {
                    // ignore resolution errors
                }
            }

            // prevent self-registration: compare against resolved targetUserId
            if (context.idJogador && isSameUser(context.idJogador, targetUserId)) {
                await services.audit.record({ type: 'devo.record.create_denied', actorUserId: context.idJogador, payload: { target: targetUserId, reason: 'self_create' } });
                return reply(context, 'Auto-cadastro de Record não permitido.');
            }

            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.record.create_denied', actorUserId: context.idJogador, payload: { target: targetUserId, reason: 'permission' } });
                return reply(context, 'Permissão negada. Apenas Owner/Gerente podem criar Records.');
            }

            try {
                const record = await services.record.createRecord(targetUserId, name);
                const managerObj = await services.manager.getByUserId(context.idJogador);
                await services.audit.record({
                    type: 'devo.record.create',
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                    entityType: 'record',
                    entityId: record.id,
                    payload: { targetUserId, name },
                });

                return reply(context, renderRecordCreated(record));
            } catch (err) {
                await services.audit.record({ type: 'devo.record.create_failed', actorUserId: context.idJogador, error: err.message, payload: { target: targetRaw, name } });
                return reply(context, `Erro ao criar Record: ${err.message}`);
            }
        }

        // record ver [id|user|number]
        if (sub === 'ver') {
            const m = parsed.body.match(/^record\s+ver\s*(.*)$/i);
            const rest = m ? m[1].trim() : '';

            if (!rest) {
                const record = await services.record.getLatestByUserId(context.idJogador);
                if (!record) return reply(context, 'Nenhum Record encontrado para você.');
                return reply(context, renderRecordView(record));
            }

            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.record.view_denied', actorUserId: context.idJogador, payload: { target: rest, reason: 'permission' } });
                return reply(context, 'Permissão negada para ver este Record.');
            }

            let record = null;
            if (rest.startsWith('rec_')) {
                record = await services.record.getById(rest);
                if (!record) return reply(context, 'Record não encontrado.');
            } else {
                let targetUserId = rest;
                if (/^\d+$/.test(rest) && context.db) {
                    const row = await context.db.get('SELECT user_id FROM manager_profiles WHERE number = ?', [Number(rest)]) || {};
                    if (row.user_id) targetUserId = row.user_id;
                    else {
                        const p = await context.db.get('SELECT id FROM jogadores WHERE numero_roll_escolhido = ?', [Number(rest)]) || {};
                        if (p.id) targetUserId = p.id;
                    }
                }

                record = await services.record.getLatestByUserId(targetUserId);
                if (!record) return reply(context, 'Record não encontrado.');
            }

            return reply(context, renderRecordView(record));
        }

        // record listar [limit]
        if (sub === 'listar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.record.list_denied', actorUserId: context.idJogador });
                return reply(context, 'Permissão negada. Apenas Owner/Gerente podem listar Records.');
            }

            const limitArg = parseInt(parsed.args[1] || '', 10);
            const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 50;

            const rows = await services.record.listRecords(limit);
            return reply(context, renderRecordList(rows));
        }

        return reply(context, renderRecordUsage());
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
