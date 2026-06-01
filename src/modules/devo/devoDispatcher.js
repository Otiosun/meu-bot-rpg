const { sendReply } = require('../../../helpers/chatReply');
const { DEVO_PREFIX } = require('./constants/devoConstants');
const { getMigrationStatus } = require('./migrations/migrationRunner');
const { createDevoServices } = require('./services');
const {
    renderHelp,
    renderStatus,
    renderUnknownCommand,
    renderLifeUsage,
    renderLifeSummary,
    renderLifeChanged,
    renderRecordUsage,
    renderRecordCreated,
    renderRecordView,
    renderRecordList,
    renderDeadlyVoteUsage,
    renderDeadlyVoteCreated,
    renderDeadlyVoteView,
    renderDeadlyVoteList,
    renderInvitationUsage,
    renderInvitationCreatedSummary,
    renderConvocationsList,
    renderInvitationAccepted,
    renderInvitationRefused,
    renderInvitationNoSlots,
    renderInvitationResponseUsage,
    renderParticipantUsage,
    renderParticipantsList,
    renderParticipantRemoved,
    renderResolutionUsage,
    renderParticipantResolved,
    renderDeadlyVoteCycleUsage,
    renderDeadlyVoteStarted,
    renderDeadlyVoteEnded,
    renderDeadlyVoteCanceled,
} = require('./views/devoViews');
const { parseLifeDuration } = require('./rules/lifeDuration');
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

function splitCommandAndReason(rest) {
    const pipeIndex = String(rest || '').indexOf('|');
    if (pipeIndex < 0) return null;

    const commandPart = rest.slice(0, pipeIndex).trim();
    const reason = rest.slice(pipeIndex + 1).trim();
    if (!commandPart || !reason) return null;

    return { commandPart, reason };
}

async function reply({ sock, idChat, m }, text) {
    return sendReply({ sock, idChat, m, text });
}

async function handleDevoMessage(context) {
    const parsed = parseDevoMessage(context.texto);
    const services = createDevoServices({ db: context.db });

    async function isManagerOrOwner(actorId) {
        if (isOwner(actorId)) return true;
        const mgr = await services.manager.getByUserId(actorId);
        return Boolean(mgr && Number(mgr.permission_level) >= 1 && mgr.active);
    }

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

    if (parsed.commandName === 'tempo') {
        const target = String(parsed.args[0] || '').trim();
        const authorized = await isManagerOrOwner(context.idJogador);

        if (target && !authorized) {
            await services.audit.record({ type: 'devo.life.summary.denied', actorUserId: context.idJogador, payload: { target } });
            return reply(context, 'Permissao negada para ver tempo de outro Record.');
        }

        const record = target
            ? await services.record.resolveRecordTarget(target)
            : await services.record.resolveRecordTarget(context.idJogador);
        if (!record) return reply(context, 'Record nao encontrado.');

        const summary = await services.life.getLifeSummary(record.id, 5);
        await services.audit.record({
            type: 'devo.life.summary',
            actorUserId: context.idJogador,
            entityType: 'record',
            entityId: record.id,
            payload: { target: target || null, self: !target },
        });

        return reply(context, renderLifeSummary({ record, summary }));
    }

    if (parsed.commandName === 'life') {
        const authorized = await isManagerOrOwner(context.idJogador);
        if (!authorized) {
            await services.audit.record({ type: 'devo.life.change.denied', actorUserId: context.idJogador });
            return reply(context, 'Permissao negada. Apenas Owner/Gerente podem alterar tempo de vida.');
        }

        const parsedLife = parsed.body.match(/^life\s+(dar|tirar)\s+(.+)$/i);
        const commandParts = parsedLife ? splitCommandAndReason(parsedLife[2]) : null;
        if (!parsedLife || !commandParts) {
            await services.audit.record({ type: 'devo.life.change_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
            return reply(context, renderLifeUsage());
        }

        const action = normalizeCommand(parsedLife[1]);
        const leftParts = commandParts.commandPart.split(/\s+/).filter(Boolean);
        if (leftParts.length !== 2) {
            await services.audit.record({ type: 'devo.life.change_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
            return reply(context, renderLifeUsage());
        }

        const [target, durationInput] = leftParts;
        try {
            const amountSeconds = parseLifeDuration(durationInput);
            const record = await services.record.resolveRecordTarget(target);
            if (!record) throw new Error('Record nao encontrado.');

            const managerObj = await services.manager.getByUserId(context.idJogador);
            const serviceContext = {
                managerId: managerObj?.id || null,
                actorUserId: context.idJogador,
                type: action === 'dar' ? 'recompensa' : 'penalidade',
                actionReason: `life ${action}`,
            };
            const result = action === 'dar'
                ? await services.life.addLife(record.id, amountSeconds, commandParts.reason, serviceContext)
                : await services.life.subtractLife(record.id, amountSeconds, commandParts.reason, serviceContext);

            return reply(context, renderLifeChanged({
                action,
                amountSeconds,
                reason: commandParts.reason,
                record,
                result,
            }));
        } catch (err) {
            await services.audit.record({ type: 'devo.life.change_failed', actorUserId: context.idJogador, error: err.message, payload: { action, target, durationInput, reason: err.message } });
            return reply(context, `Erro ao alterar tempo: ${err.message}`);
        }
    }

    if (parsed.commandName === 'record') {
        const sub = normalizeCommand(parsed.args[0] || '');

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

    if (parsed.commandName === 'dv') {
        const sub = normalizeCommand(parsed.args[0] || '');

        if (sub === 'convocar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.invite.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem convocar Records.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            const targets = parsed.args.slice(2).map((arg) => String(arg || '').trim()).filter(Boolean);
            if (!voteTarget || !targets.length) {
                await services.audit.record({ type: 'devo.dv.invite_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderInvitationUsage());
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const result = await services.invitation.createPendingInvitations({
                    voteIdOrCode: voteTarget,
                    targets,
                    invitedByManagerId: managerObj?.id || null,
                    actorUserId: context.idJogador,
                });

                return reply(context, renderInvitationCreatedSummary(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.invite_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget, targets } });
                return reply(context, `Erro ao convocar Records: ${err.message}`);
            }
        }

        if (sub === 'participantes') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.participants.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem listar participantes.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            if (!voteTarget) {
                return reply(context, renderParticipantUsage());
            }

            try {
                const result = await services.participant.listParticipants({ voteIdOrCode: voteTarget });
                return reply(context, renderParticipantsList(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.participants_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget } });
                return reply(context, `Erro ao listar participantes: ${err.message}`);
            }
        }

        if (sub === 'remover') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.participant_remove.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem remover participantes.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            const target = String(parsed.args[2] || '').trim();
            if (!voteTarget || !target) {
                await services.audit.record({ type: 'devo.dv.participant_remove_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderParticipantUsage());
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const result = await services.participant.removeParticipant({
                    voteIdOrCode: voteTarget,
                    target,
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                });

                return reply(context, renderParticipantRemoved(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.participant_remove_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget, target, reason: err.message } });
                return reply(context, `Erro ao remover participante: ${err.message}`);
            }
        }

        if (sub === 'recompensar' || sub === 'penalizar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: `devo.dv.life_${sub}.denied`, actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem alterar tempo por Deadly Vote.');
            }

            const parsedLife = parsed.body.match(/^dv\s+(recompensar|penalizar)\s+(.+)$/i);
            const commandParts = parsedLife ? splitCommandAndReason(parsedLife[2]) : null;
            if (!parsedLife || !commandParts) {
                await services.audit.record({ type: `devo.dv.life_${sub}_failed`, actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderLifeUsage());
            }

            const leftParts = commandParts.commandPart.split(/\s+/).filter(Boolean);
            if (leftParts.length !== 3) {
                await services.audit.record({ type: `devo.dv.life_${sub}_failed`, actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderLifeUsage());
            }

            const [voteTarget, target, durationInput] = leftParts;
            try {
                const amountSeconds = parseLifeDuration(durationInput);
                const vote = await services.deadlyVote.getByIdOrCode(voteTarget);
                if (!vote) throw new Error('Deadly Vote nao encontrado.');

                const record = await services.record.resolveRecordTarget(target);
                if (!record) throw new Error('Record nao encontrado.');

                const participant = await services.participant.getByVoteAndRecord(vote.id, record.id);
                if (!participant) throw new Error('Record nao participou deste Deadly Vote.');

                const managerObj = await services.manager.getByUserId(context.idJogador);
                const serviceContext = {
                    managerId: managerObj?.id || null,
                    actorUserId: context.idJogador,
                    deadlyVoteId: vote.id,
                    type: sub === 'recompensar' ? 'recompensa' : 'penalidade',
                    actionReason: `dv ${sub}`,
                };
                const result = sub === 'recompensar'
                    ? await services.life.addLife(record.id, amountSeconds, commandParts.reason, serviceContext)
                    : await services.life.subtractLife(record.id, amountSeconds, commandParts.reason, serviceContext);

                return reply(context, renderLifeChanged({
                    action: sub,
                    amountSeconds,
                    reason: commandParts.reason,
                    record,
                    result,
                    vote,
                    participant,
                }));
            } catch (err) {
                await services.audit.record({ type: `devo.dv.life_${sub}_failed`, actorUserId: context.idJogador, error: err.message, payload: { voteTarget, target, durationInput, reason: err.message } });
                return reply(context, `Erro ao alterar tempo por Deadly Vote: ${err.message}`);
            }
        }

        if (sub === 'resolver') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.participant_resolve.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem resolver participantes.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            const resolution = String(parsed.args[2] || '').trim();
            const target = String(parsed.args[3] || '').trim();
            if (!voteTarget || !resolution || !target) {
                await services.audit.record({ type: 'devo.dv.participant_resolve_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderResolutionUsage());
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const result = await services.participant.resolveParticipant({
                    voteIdOrCode: voteTarget,
                    resolution,
                    target,
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                });

                return reply(context, renderParticipantResolved(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.participant_resolve_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget, resolution, target, reason: err.message } });
                return reply(context, `Erro ao resolver participante: ${err.message}`);
            }
        }

        if (sub === 'iniciar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.start.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem iniciar Deadly Votes.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            if (!voteTarget) {
                await services.audit.record({ type: 'devo.dv.start_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderDeadlyVoteCycleUsage());
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const result = await services.deadlyVote.startVote({
                    voteIdOrCode: voteTarget,
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                });

                return reply(context, renderDeadlyVoteStarted(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.start_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget, reason: err.message } });
                return reply(context, `Erro ao iniciar Deadly Vote: ${err.message}`);
            }
        }

        if (sub === 'encerrar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.end.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem encerrar Deadly Votes.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            if (!voteTarget) {
                await services.audit.record({ type: 'devo.dv.end_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderDeadlyVoteCycleUsage());
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const result = await services.deadlyVote.endVote({
                    voteIdOrCode: voteTarget,
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                });

                return reply(context, renderDeadlyVoteEnded(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.end_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget, reason: err.message } });
                return reply(context, `Erro ao encerrar Deadly Vote: ${err.message}`);
            }
        }

        if (sub === 'cancelar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.cancel.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem cancelar Deadly Votes.');
            }

            const voteTarget = String(parsed.args[1] || '').trim();
            if (!voteTarget) {
                await services.audit.record({ type: 'devo.dv.cancel_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderDeadlyVoteCycleUsage());
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const result = await services.deadlyVote.cancelVote({
                    voteIdOrCode: voteTarget,
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                });

                return reply(context, renderDeadlyVoteCanceled(result));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.cancel_failed', actorUserId: context.idJogador, error: err.message, payload: { voteTarget, reason: err.message } });
                return reply(context, `Erro ao cancelar Deadly Vote: ${err.message}`);
            }
        }

        if (sub === 'criar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.create.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem criar Deadly Votes.');
            }

            const m = parsed.body.match(/^dv\s+criar\s+(.+)$/i);
            if (!m) {
                await services.audit.record({ type: 'devo.dv.create_failed', actorUserId: context.idJogador, payload: { reason: 'bad_syntax' } });
                return reply(context, renderDeadlyVoteUsage());
            }

            const segments = m[1].split('|').map((s) => String(s || '').trim()).filter(Boolean);
            const title = segments.shift();
            const options = {};
            for (const segment of segments) {
                const eqIndex = segment.indexOf('=');
                if (eqIndex <= 0) continue;
                const key = segment.slice(0, eqIndex).trim().toLowerCase();
                const value = segment.slice(eqIndex + 1).trim();
                options[key] = value;
            }

            try {
                const managerObj = await services.manager.getByUserId(context.idJogador);
                const vote = await services.deadlyVote.createVote({
                    title,
                    maxSlots: options.vagas,
                    code: options.codigo,
                    createdByManagerId: managerObj?.id || null,
                });

                await services.audit.record({
                    type: 'devo.dv.create',
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                    entityType: 'deadly_vote',
                    entityId: vote.id,
                    payload: { title: vote.title, code: vote.code, maxSlots: vote.max_slots },
                });

                return reply(context, renderDeadlyVoteCreated(vote));
            } catch (err) {
                await services.audit.record({ type: 'devo.dv.create_failed', actorUserId: context.idJogador, error: err.message, payload: { title, options } });
                return reply(context, `Erro ao criar Deadly Vote: ${err.message}`);
            }
        }

        if (sub === 'ver') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.view.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem ver Deadly Votes.');
            }

            const target = String(parsed.args[1] || '').trim();
            if (!target) return reply(context, renderDeadlyVoteUsage());

            const vote = await services.deadlyVote.getByIdOrCode(target);
            if (!vote) return reply(context, 'Deadly Vote nao encontrado.');

            const managerObj = await services.manager.getByUserId(context.idJogador);
            await services.audit.record({
                type: 'devo.dv.view',
                actorUserId: context.idJogador,
                actorManagerId: managerObj?.id || null,
                entityType: 'deadly_vote',
                entityId: vote.id,
                payload: { target },
            });

            return reply(context, renderDeadlyVoteView(vote));
        }

        if (sub === 'listar') {
            const authorized = await isManagerOrOwner(context.idJogador);
            if (!authorized) {
                await services.audit.record({ type: 'devo.dv.list.denied', actorUserId: context.idJogador });
                return reply(context, 'Permissao negada. Apenas Owner/Gerente podem listar Deadly Votes.');
            }

            const first = parsed.args[1] || '';
            const second = parsed.args[2] || '';
            const firstAsLimit = parseInt(first, 10);
            const status = first && !Number.isInteger(firstAsLimit) ? first : null;
            const limit = status ? second : first;

            try {
                const votes = await services.deadlyVote.listVotes({ status, limit });
                const managerObj = await services.manager.getByUserId(context.idJogador);
                await services.audit.record({
                    type: 'devo.dv.list',
                    actorUserId: context.idJogador,
                    actorManagerId: managerObj?.id || null,
                    entityType: 'deadly_vote',
                    payload: { status, limit },
                });

                return reply(context, renderDeadlyVoteList(votes));
            } catch (err) {
                return reply(context, `Erro ao listar Deadly Votes: ${err.message}`);
            }
        }

        return reply(context, renderDeadlyVoteUsage());
    }

    if (parsed.commandName === 'convocacoes') {
        const target = String(parsed.args[0] || '').trim();
        const authorized = await isManagerOrOwner(context.idJogador);

        if (target) {
            if (!authorized) {
                await services.audit.record({ type: 'devo.invitations.list.denied', actorUserId: context.idJogador, payload: { target } });
                return reply(context, 'Permissao negada para ver convocacoes de outro Record.');
            }

            const record = await services.record.resolveRecordTarget(target);
            if (!record) return reply(context, 'Record nao encontrado.');

            const invitations = await services.invitation.listPendingForRecord(record.id);
            const managerObj = await services.manager.getByUserId(context.idJogador);
            await services.audit.record({
                type: 'devo.invitations.list',
                actorUserId: context.idJogador,
                actorManagerId: managerObj?.id || null,
                entityType: 'record',
                entityId: record.id,
                payload: { target },
            });

            return reply(context, renderConvocationsList(invitations));
        }

        if (authorized) {
            return reply(context, [
                renderInvitationUsage(),
                '',
                'Owner/Gerente deve informar um alvo para consultar convocacoes de Record especifico.',
            ].join('\n'));
        }

        const record = await services.record.resolveRecordTarget(context.idJogador);
        if (!record) return reply(context, 'Nenhum Record encontrado para voce.');

        const invitations = await services.invitation.listPendingForRecord(record.id);
        await services.audit.record({
            type: 'devo.invitations.list',
            actorUserId: context.idJogador,
            entityType: 'record',
            entityId: record.id,
            payload: { self: true },
        });

        return reply(context, renderConvocationsList(invitations));
    }

    if (parsed.commandName === 'entrar') {
        const input = String(parsed.args[0] || '').trim();
        if (!input) {
            await services.audit.record({
                type: 'devo.invitation.accept_failed',
                actorUserId: context.idJogador,
                payload: { reason: 'bad_syntax' },
            });
            return reply(context, renderInvitationResponseUsage());
        }

        try {
            const result = await services.invitation.acceptInvitation({
                actorUserId: context.idJogador,
                input,
            });

            if (result.outcome === 'sem_vaga') {
                return reply(context, renderInvitationNoSlots(result));
            }

            return reply(context, renderInvitationAccepted(result));
        } catch (err) {
            await services.audit.record({
                type: 'devo.invitation.accept_failed',
                actorUserId: context.idJogador,
                error: err.message,
                payload: { input, reason: err.message },
            });
            return reply(context, `Erro ao entrar: ${err.message}`);
        }
    }

    if (parsed.commandName === 'recusar') {
        const input = String(parsed.args[0] || '').trim();
        if (!input) {
            await services.audit.record({
                type: 'devo.invitation.refuse_failed',
                actorUserId: context.idJogador,
                payload: { reason: 'bad_syntax' },
            });
            return reply(context, renderInvitationResponseUsage());
        }

        try {
            const result = await services.invitation.refuseInvitation({
                actorUserId: context.idJogador,
                input,
            });

            return reply(context, renderInvitationRefused(result));
        } catch (err) {
            await services.audit.record({
                type: 'devo.invitation.refuse_failed',
                actorUserId: context.idJogador,
                error: err.message,
                payload: { input, reason: err.message },
            });
            return reply(context, `Erro ao recusar: ${err.message}`);
        }
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
