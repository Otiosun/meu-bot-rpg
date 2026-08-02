'use strict';

const { evaluatePrivateMessagePolicy } = require('./privateMessagePolicy');

const PRIVATE_KINDS = Object.freeze([
    'private_text',
    'private_message',
    'spell_review_invite',
]);

const SOURCE_ALIASES = Object.freeze({
    appearance_approved: 'appearance_result',
    aparencia_aprovada: 'appearance_result',
    game_liberated: 'game_release',
    jogo_liberado: 'game_release',
    spell_review: 'spell_review_invite',
    anti_ghost: 'anti_ghost_notice',
    antighost: 'anti_ghost_notice',
    community_exit: 'community_exit_confirmation',
    saida_comunidade: 'community_exit_confirmation',
    return_bonus: 'anti_ghost_return_bonus',
    checklist: 'weekly_checklist_reset',
    incentivo: 'return_bonus_manual',
});

const DEFAULT_MAX_AGE_HOURS = 72;

function normalizeSource(value) {
    return String(value || '').trim().toLowerCase();
}

function canonicalQueueSource(source) {
    const normalized = normalizeSource(source);
    return SOURCE_ALIASES[normalized] || normalized || null;
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value ?? null);
    } catch {
        return JSON.stringify({ serialization_failed: true });
    }
}

function workerEnabled(env = process.env) {
    return String(env?.CLOVER_PV_DELIVERY_WORKER_ENABLED || '').trim() === '1';
}

function resolveMaxAgeHours(env = process.env) {
    const parsed = Number(env?.CLOVER_PV_DELIVERY_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_AGE_HOURS;
    return Math.max(1, Math.min(168, parsed));
}

function parseSqliteTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZone = /(?:Z|[+-]\d\d:\d\d)$/.test(normalized)
        ? normalized
        : `${normalized}Z`;
    const parsed = new Date(withZone);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isQueuedJobExpired(job, env = process.env, now = new Date()) {
    const createdAt = parseSqliteTimestamp(job?.created_at);
    if (!createdAt) return false;
    const ageMs = now.getTime() - createdAt.getTime();
    if (ageMs < 0) return false;
    return ageMs > resolveMaxAgeHours(env) * 60 * 60 * 1000;
}

function buildQueuePolicyInput(job) {
    const payload = safeJsonParse(job?.payload_json, {});
    const metadata = payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : {};
    const source = canonicalQueueSource(
        payload.source
        || payload.message?.source
        || job?.created_by
    );

    return {
        source,
        targetCount: 1,
        explicitConfirmation: metadata.explicitConfirmation === true,
        dedupeKey: job?.dedupe_key || metadata.dedupeKey || null,
    };
}

function evaluateQueuedPrivateJob(job, env = process.env) {
    if (!job || !PRIVATE_KINDS.includes(String(job.kind || ''))) {
        return {
            allowed: false,
            reason: 'unsupported_private_delivery_kind',
            policy: null,
        };
    }
    return evaluatePrivateMessagePolicy(buildQueuePolicyInput(job), env);
}

async function claimNextPrivateJob(db, options = {}) {
    if (!db?.exec || !db?.get || !db?.run) {
        return { ok: false, reason: 'missing_db' };
    }

    const workerId = String(options.workerId || `pv-worker:${process.pid}`);
    const placeholders = PRIVATE_KINDS.map(() => '?').join(', ');

    await db.exec('BEGIN IMMEDIATE');
    try {
        const job = await db.get(
            `SELECT *
             FROM clover_delivery_jobs
             WHERE status = 'pending'
               AND kind IN (${placeholders})
               AND datetime(COALESCE(run_after, CURRENT_TIMESTAMP)) <= CURRENT_TIMESTAMP
             ORDER BY priority DESC, id ASC
             LIMIT 1`,
            PRIVATE_KINDS
        );

        if (!job) {
            await db.exec('COMMIT');
            return { ok: true, job: null };
        }

        const updated = await db.run(
            `UPDATE clover_delivery_jobs
             SET status = 'processing',
                 attempts = attempts + 1,
                 locked_at = CURRENT_TIMESTAMP,
                 locked_by = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND status = 'pending'`,
            [workerId, job.id]
        );

        if (Number(updated?.changes || 0) !== 1) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'claim_lost' };
        }

        await db.exec('COMMIT');
        return {
            ok: true,
            job: {
                ...job,
                status: 'processing',
                attempts: Number(job.attempts || 0) + 1,
                locked_by: workerId,
            },
        };
    } catch (error) {
        await Promise.resolve(db.exec('ROLLBACK')).catch(() => null);
        throw error;
    }
}

async function finishJob(db, job, status, details = {}) {
    const sent = status === 'sent';
    const resultJson = safeJsonStringify(details.result);
    const lastError = details.error ? String(details.error).slice(0, 1000) : null;

    const updated = await db.run(
        `UPDATE clover_delivery_jobs
         SET status = ?,
             sent_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE sent_at END,
             last_error = ?,
             result_json = ?,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status = 'processing'
           AND locked_by = ?`,
        [status, sent ? 1 : 0, lastError, resultJson, job.id, job.locked_by]
    );

    return Number(updated?.changes || 0) === 1;
}

async function retryOrFailJob(db, job, error, options = {}) {
    const maxAttempts = Math.max(1, Number(job.max_attempts || 1));
    const attempts = Math.max(1, Number(job.attempts || 1));
    if (attempts >= maxAttempts) {
        const finished = await finishJob(db, job, 'failed', { error });
        return {
            ok: false,
            status: finished ? 'failed' : 'claim_lost',
            error: String(error),
        };
    }

    const retryDelaySeconds = Math.max(30, Number(options.retryDelaySeconds || 300));
    const updated = await db.run(
        `UPDATE clover_delivery_jobs
         SET status = 'pending',
             run_after = datetime('now', ?),
             last_error = ?,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status = 'processing'
           AND locked_by = ?`,
        [`+${retryDelaySeconds} seconds`, String(error).slice(0, 1000), job.id, job.locked_by]
    );

    return {
        ok: false,
        status: Number(updated?.changes || 0) === 1 ? 'pending' : 'claim_lost',
        error: String(error),
    };
}

async function dispatchPrivateJob({
    job,
    sock,
    db,
    sendPrivateText,
    sendPrivateMessage,
    sendSpellReviewInvite,
}) {
    const payload = safeJsonParse(job.payload_json, {});
    const policyInput = buildQueuePolicyInput(job);
    const policy = {
        source: policyInput.source,
        dedupeKey: policyInput.dedupeKey,
        explicitConfirmation: policyInput.explicitConfirmation,
        targetCount: 1,
    };

    if (job.kind === 'private_text') {
        if (typeof sendPrivateText !== 'function') throw new Error('missing_send_private_text');
        return sendPrivateText({
            sock,
            playerId: job.target_jid,
            text: payload.text,
            mentions: payload.mentions || [],
            policy,
        });
    }

    if (job.kind === 'private_message') {
        if (typeof sendPrivateMessage !== 'function') throw new Error('missing_send_private_message');
        return sendPrivateMessage({
            sock,
            playerId: job.target_jid,
            message: payload.message,
            policy,
        });
    }

    if (job.kind === 'spell_review_invite') {
        if (typeof sendSpellReviewInvite !== 'function') throw new Error('missing_spell_review_invite_sender');
        return sendSpellReviewInvite(sock, db, payload.playerId || job.target_jid, {
            rotate: payload.rotate === true,
            addToGroup: payload.addToGroup !== false,
            queueFallback: false,
        });
    }

    throw new Error(`unsupported_private_delivery_kind:${job.kind}`);
}

async function cancelClaimedJob(db, job, reason, result = null) {
    const finished = await finishJob(db, job, 'cancelled', {
        error: reason,
        result,
    });
    return finished ? 'cancelled' : 'claim_lost';
}

async function processNextPrivateDelivery(options = {}) {
    const env = options.env || process.env;
    if (!workerEnabled(env)) {
        return { ok: true, skipped: true, reason: 'worker_disabled' };
    }

    const claimed = await claimNextPrivateJob(options.db, options);
    if (!claimed.ok || !claimed.job) {
        return claimed.ok
            ? { ok: true, skipped: true, reason: 'empty_queue' }
            : claimed;
    }

    const job = claimed.job;
    if (isQueuedJobExpired(job, env, options.now || new Date())) {
        const status = await cancelClaimedJob(options.db, job, 'job_expired');
        return {
            ok: status === 'cancelled',
            skipped: true,
            reason: status === 'cancelled' ? 'job_expired' : 'claim_lost',
            jobId: job.id,
        };
    }

    const policyDecision = evaluateQueuedPrivateJob(job, env);
    if (!policyDecision.allowed) {
        const status = await cancelClaimedJob(
            options.db,
            job,
            `pv_policy:${policyDecision.reason}`,
            { policyDecision }
        );
        return {
            ok: status === 'cancelled',
            skipped: true,
            reason: status === 'cancelled' ? 'policy_blocked' : 'claim_lost',
            jobId: job.id,
            policyDecision,
        };
    }

    try {
        const result = await dispatchPrivateJob({ ...options, job });
        if (result?.skipped) {
            const reason = result.reason || 'transport_skipped';
            if (reason === 'pv_policy_blocked') {
                const status = await cancelClaimedJob(options.db, job, reason, result);
                return {
                    ok: status === 'cancelled',
                    skipped: true,
                    reason: status === 'cancelled' ? reason : 'claim_lost',
                    jobId: job.id,
                    result,
                };
            }
            return retryOrFailJob(options.db, job, reason, options);
        }

        if (result?.ok === false) {
            return retryOrFailJob(
                options.db,
                job,
                result.reason || 'transport_failed',
                options
            );
        }

        const finished = await finishJob(options.db, job, 'sent', { result });
        if (!finished) return { ok: false, status: 'claim_lost', jobId: job.id };
        return { ok: true, sent: true, jobId: job.id, result };
    } catch (error) {
        return retryOrFailJob(options.db, job, error?.message || error, options);
    }
}

module.exports = {
    DEFAULT_MAX_AGE_HOURS,
    PRIVATE_KINDS,
    SOURCE_ALIASES,
    buildQueuePolicyInput,
    canonicalQueueSource,
    claimNextPrivateJob,
    dispatchPrivateJob,
    evaluateQueuedPrivateJob,
    isQueuedJobExpired,
    parseSqliteTimestamp,
    processNextPrivateDelivery,
    resolveMaxAgeHours,
    safeJsonParse,
    safeJsonStringify,
    workerEnabled,
};
