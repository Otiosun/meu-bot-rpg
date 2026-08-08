'use strict';

const {
    getSpellReviewAutoFlowEnabled,
    fillSpellReviewSlots,
    concludeSpellReviewEntry,
} = require('./spellReviewFlowService');
const {
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
    sendSpellReviewInviteToPlayer,
} = require('./groupManager');
const {
    claimNextSpellReviewExternalJob,
    completeSpellReviewExternalJob,
    enqueueSpellReviewInviteJob,
    failSpellReviewExternalJob,
} = require('./spellReviewExternalJobService');

function calledEntryInviteKey(entry, prefix = 'spell-review') {
    const calledToken = String(entry?.called_at || entry?.calledAt || 'unknown')
        .replace(/[^0-9A-Za-z]/g, '')
        .slice(0, 32) || 'unknown';
    return `${prefix}:entry:${Number(entry?.id || 0)}:called:${calledToken}:invite`;
}

async function inviteCalledEntries(sock, db, entries, options = {}) {
    const invites = [];
    if (!entries?.length) return invites;

    let link = null;
    if (options.rotate !== false) {
        link = await rotateSpellReviewInviteLink(sock, db).catch((error) => {
            console.log('[spell-flow] não consegui atualizar o link antes do lote:', error?.message || error);
            return null;
        });
    }

    for (const entry of entries) {
        const invite = await sendSpellReviewInviteToPlayer(sock, db, entry.player_id, {
            rotate: false,
            queueFallback: false,
            link,
        }).catch((error) => ({
            ok: false,
            reason: 'unexpected_error',
            error: error?.message || String(error),
        }));
        invites.push({ entry, invite });
        if (!invite?.ok) {
            await enqueueSpellReviewInviteJob(db, {
                key: calledEntryInviteKey(entry, options.retryKeyPrefix || 'spell-review:auto'),
                playerId: entry.player_id,
                metadata: {
                    source: 'spell-flow-invite-retry',
                    queueEntryId: Number(entry.id || 0),
                    calledAt: entry.called_at || null,
                    previousReason: invite?.reason || 'send_failed',
                },
            }).catch((error) => {
                console.log('[spell-flow] não consegui persistir retry de convite:', error?.message || error);
            });
        }
    }
    return invites;
}

async function fillAndInviteSpellReviewCapacity({
    sock,
    db,
    actorId = 'system',
    force = false,
    rotate = true,
    excludePlayerIds = [],
} = {}) {
    if (!sock || !db) return { ok: false, code: 'runtime_unavailable', called: [], invites: [] };

    const autoFlow = await getSpellReviewAutoFlowEnabled(db);
    if (!force && !autoFlow) {
        return { ok: false, code: 'auto_disabled', autoFlow, called: [], invites: [] };
    }

    const fill = await fillSpellReviewSlots(db, actorId, { excludePlayerIds });
    const invites = await inviteCalledEntries(sock, db, fill.called, { rotate });

    return {
        ok: true,
        autoFlow,
        ...fill,
        invites,
    };
}

async function removeSpellReviewParticipantSafely(sock, db, playerId) {
    if (!sock || !db || !playerId) return { ok: false, reason: 'missing_runtime' };
    return removeSpellReviewParticipant(sock, db, playerId).catch((error) => ({
        ok: false,
        reason: 'remove_failed',
        error: error?.message || String(error),
    }));
}

async function executeSpellReviewExternalJob({ sock, db, job } = {}) {
    if (!sock || !db || !job) {
        const error = new Error('Runtime externo indisponível.');
        error.code = 'runtime_unavailable';
        throw error;
    }

    if (job.type === 'remove_participant') {
        const removal = await removeSpellReviewParticipantSafely(sock, db, job.playerId);
        if (!removal?.ok) {
            const error = new Error(`Não foi possível remover participante do grupo: ${removal?.reason || 'remove_failed'}`);
            error.code = removal?.reason || 'remove_failed';
            error.details = removal;
            throw error;
        }
        return { type: job.type, removal: { ok: true } };
    }

    if (job.type === 'invite_player') {
        const invite = await sendSpellReviewInviteToPlayer(sock, db, job.playerId, {
            rotate: false,
            queueFallback: false,
        });
        if (!invite?.ok) {
            const error = new Error(`Não foi possível enviar convite da avaliação: ${invite?.reason || 'send_failed'}`);
            error.code = invite?.reason || 'send_failed';
            error.details = { reason: invite?.reason || null };
            throw error;
        }
        return { type: job.type, invite: { ok: true } };
    }

    if (job.type === 'fill_capacity') {
        const force = Boolean(job.metadata?.force);
        const autoFlow = await getSpellReviewAutoFlowEnabled(db);
        if (!force && !autoFlow) {
            return { type: job.type, skipped: true, code: 'auto_disabled', called: 0 };
        }
        const fill = await fillSpellReviewSlots(
            db,
            job.metadata?.actorId || 'system:spell-external-job',
            { excludePlayerIds: Array.isArray(job.metadata?.excludePlayerIds) ? job.metadata.excludePlayerIds : [] }
        );
        for (const entry of fill.called || []) {
            await enqueueSpellReviewInviteJob(db, {
                key: calledEntryInviteKey(entry, job.key),
                playerId: entry.player_id,
                metadata: {
                    source: 'spell-review-fill-job',
                    parentJobKey: job.key,
                    queueEntryId: Number(entry.id || 0),
                    calledAt: entry.called_at || null,
                },
            });
        }
        return {
            type: job.type,
            called: Number(fill.called?.length || 0),
            skipped: Number(fill.skipped?.length || 0),
            capacity: Number(fill.capacity || 0),
        };
    }

    const error = new Error(`Tipo de efeito externo não suportado: ${job.type}`);
    error.code = 'unsupported_external_job';
    throw error;
}

async function processSpellReviewExternalJobs({ sock, db, maxJobs = 12 } = {}) {
    if (!sock || !db) return { ok: false, code: 'runtime_unavailable', processed: [] };
    const processed = [];
    const limit = Math.max(1, Math.min(50, Number(maxJobs || 12)));
    for (let index = 0; index < limit; index += 1) {
        const job = await claimNextSpellReviewExternalJob(db);
        if (!job) break;
        try {
            const result = await executeSpellReviewExternalJob({ sock, db, job });
            const completed = await completeSpellReviewExternalJob(db, job.id, result);
            processed.push({ job: completed, ok: true, result });
        } catch (error) {
            const failed = await failSpellReviewExternalJob(db, job.id, error);
            processed.push({
                job: failed,
                ok: false,
                error: error?.message || String(error),
                code: error?.code || 'external_job_failed',
            });
        }
    }
    return { ok: true, processed };
}

async function completeSpellReviewPostCommit({
    sock,
    db,
    playerId,
    actorId,
} = {}) {
    const removal = await removeSpellReviewParticipantSafely(sock, db, playerId);
    const fill = await fillAndInviteSpellReviewCapacity({
        sock,
        db,
        actorId,
        force: false,
        rotate: true,
        excludePlayerIds: [playerId],
    });

    return {
        handled: true,
        concludedAlready: true,
        removal,
        fill,
    };
}

async function completeSpellReviewAfterSave({
    sock,
    db,
    playerId,
    actorId,
    reason = 'feitiço salvo pelo ADM',
} = {}) {
    const concluded = await concludeSpellReviewEntry(db, playerId, actorId, reason);
    if (!concluded.ok) {
        return {
            handled: false,
            concluded,
            removal: null,
            fill: null,
        };
    }

    const postCommit = await completeSpellReviewPostCommit({
        sock,
        db,
        playerId,
        actorId,
    });

    return {
        ...postCommit,
        concluded,
    };
}

function startSpellReviewFlowScheduler(options = {}) {
    if (global.__cloverSpellReviewFlowScheduler) {
        return global.__cloverSpellReviewFlowScheduler;
    }

    const intervalMs = Math.max(15000, Number(options.intervalMs || 45000));
    const state = {
        running: false,
        timer: null,
        intervalMs,
    };

    state.timer = setInterval(async () => {
        if (state.running) return;
        const runtime = global.runtimeClover;
        const sock = runtime?.sockAtivo;
        const db = runtime?.dbAtivo;
        if (!sock || !db || runtime?.encerrando) return;

        state.running = true;
        try {
            const external = await processSpellReviewExternalJobs({ sock, db, maxJobs: 12 });
            const failed = (external.processed || []).filter((item) => !item.ok).length;
            if (failed) {
                console.log(`[spell-flow] efeitos externos com retry=${failed}`);
            }
            const result = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: 'system:spell-flow-scheduler',
                force: false,
                rotate: false,
            });
            if (result?.called?.length) {
                console.log(`[spell-flow] vagas preenchidas automaticamente=${result.called.length}; capacidade=${result.capacity}; ativos=${result.state?.active}`);
            }
        } catch (error) {
            console.log('[spell-flow] falha no ciclo automático:', error?.message || error);
        } finally {
            state.running = false;
        }
    }, intervalMs);

    state.timer.unref?.();
    global.__cloverSpellReviewFlowScheduler = state;
    return state;
}

module.exports = {
    calledEntryInviteKey,
    completeSpellReviewAfterSave,
    completeSpellReviewPostCommit,
    executeSpellReviewExternalJob,
    fillAndInviteSpellReviewCapacity,
    inviteCalledEntries,
    processSpellReviewExternalJobs,
    removeSpellReviewParticipantSafely,
    startSpellReviewFlowScheduler,
};