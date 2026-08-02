'use strict';

const crypto = require('node:crypto');

const {
    PRIVATE_KINDS,
    buildQueuePolicyInput,
    evaluateQueuedPrivateJob,
    isQueuedJobExpired,
    parseSqliteTimestamp,
} = require('./privateDeliveryWorker');

const TERMINAL_STATUSES = new Set(['sent', 'failed', 'cancelled']);
const DEFAULT_STALE_LOCK_MINUTES = 30;

function incrementCounter(target, key) {
    const normalized = String(key || 'unknown');
    target[normalized] = Number(target[normalized] || 0) + 1;
}

function maskTarget(jid) {
    const raw = String(jid || '').trim();
    if (!raw) return null;
    const [user = '', domain = 'unknown'] = raw.split('@');
    const suffix = user.replace(/\D/g, '').slice(-4);
    return suffix ? `***${suffix}@${domain}` : `***@${domain}`;
}

function hashFingerprint(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function ageHours(value, now = new Date()) {
    const parsed = parseSqliteTimestamp(value);
    if (!parsed) return null;
    const difference = now.getTime() - parsed.getTime();
    if (!Number.isFinite(difference)) return null;
    return Math.round((difference / 36e5) * 100) / 100;
}

function isScheduledForFuture(job, now = new Date()) {
    const runAfter = parseSqliteTimestamp(job?.run_after);
    return Boolean(runAfter && runAfter.getTime() > now.getTime());
}

function isStaleProcessing(job, now = new Date(), staleLockMinutes = DEFAULT_STALE_LOCK_MINUTES) {
    if (String(job?.status || '') !== 'processing') return false;
    const lockedAt = parseSqliteTimestamp(job?.locked_at);
    if (!lockedAt) return true;
    return now.getTime() - lockedAt.getTime() > Math.max(1, staleLockMinutes) * 60 * 1000;
}

function classifyObservedJob(job, options = {}) {
    const now = options.now || new Date();
    const env = options.env || {};
    const staleLockMinutes = options.staleLockMinutes || DEFAULT_STALE_LOCK_MINUTES;
    const status = String(job?.status || 'unknown');
    const policyInput = buildQueuePolicyInput(job);
    const base = {
        id: Number(job?.id || 0),
        kind: String(job?.kind || 'unknown'),
        status,
        category: String(job?.category || 'unknown'),
        priority: Number(job?.priority || 0),
        attempts: Number(job?.attempts || 0),
        maxAttempts: Number(job?.max_attempts || 0),
        source: policyInput.source || null,
        dedupePresent: Boolean(policyInput.dedupeKey),
        target: maskTarget(job?.target_jid),
        createdAt: job?.created_at || null,
        runAfter: job?.run_after || null,
        lockedAt: job?.locked_at || null,
        createdAgeHours: ageHours(job?.created_at, now),
    };

    if (TERMINAL_STATUSES.has(status)) {
        return { ...base, decision: 'terminal', reason: status };
    }

    if (status === 'processing') {
        const stale = isStaleProcessing(job, now, staleLockMinutes);
        return {
            ...base,
            decision: stale ? 'stale_processing' : 'processing',
            reason: stale ? 'processing_lock_stale_or_missing' : 'processing_lock_active',
        };
    }

    if (status !== 'pending') {
        return { ...base, decision: 'invalid_status', reason: 'unsupported_status' };
    }

    if (!PRIVATE_KINDS.includes(String(job?.kind || ''))) {
        return { ...base, decision: 'ignored_non_private', reason: 'unsupported_private_delivery_kind' };
    }

    if (isScheduledForFuture(job, now)) {
        return { ...base, decision: 'scheduled_future', reason: 'run_after_in_future' };
    }

    if (isQueuedJobExpired(job, env, now)) {
        return { ...base, decision: 'expired', reason: 'job_expired' };
    }

    const policyDecision = evaluateQueuedPrivateJob(job, env);
    if (!policyDecision.allowed) {
        return {
            ...base,
            decision: 'policy_blocked',
            reason: policyDecision.reason || 'policy_blocked',
            policyCategory: policyDecision.category || policyDecision.policy?.category || null,
        };
    }

    return {
        ...base,
        decision: 'eligible',
        reason: policyDecision.reason || 'allowed',
        policyCategory: policyDecision.category || policyDecision.policy?.category || null,
    };
}

function findDuplicateDedupeKeys(rows = []) {
    const counts = new Map();
    for (const row of rows) {
        if (!['pending', 'processing'].includes(String(row?.status || ''))) continue;
        const key = String(row?.dedupe_key || '').trim();
        if (!key) continue;
        counts.set(key, Number(counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => ({
            fingerprint: hashFingerprint(key),
            count,
        }))
        .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint));
}

function observeDeliveryJobs(rows = [], options = {}) {
    const items = rows.map((row) => classifyObservedJob(row, options));
    const summary = {
        total: items.length,
        byStatus: {},
        byKind: {},
        byCategory: {},
        byDecision: {},
        bySource: {},
        eligible: 0,
        policyBlocked: 0,
        expired: 0,
        staleProcessing: 0,
        duplicateDedupeKeyCount: 0,
    };

    for (const item of items) {
        incrementCounter(summary.byStatus, item.status);
        incrementCounter(summary.byKind, item.kind);
        incrementCounter(summary.byCategory, item.category);
        incrementCounter(summary.byDecision, item.decision);
        incrementCounter(summary.bySource, item.source || 'unknown');
    }

    summary.eligible = Number(summary.byDecision.eligible || 0);
    summary.policyBlocked = Number(summary.byDecision.policy_blocked || 0);
    summary.expired = Number(summary.byDecision.expired || 0);
    summary.staleProcessing = Number(summary.byDecision.stale_processing || 0);

    const duplicateDedupeKeys = findDuplicateDedupeKeys(rows);
    summary.duplicateDedupeKeyCount = duplicateDedupeKeys.length;

    return {
        version: 'clover.private-delivery-observer.v1',
        readOnly: true,
        generatedAt: (options.now || new Date()).toISOString(),
        summary,
        duplicateDedupeKeys,
        items,
    };
}

module.exports = {
    DEFAULT_STALE_LOCK_MINUTES,
    TERMINAL_STATUSES,
    ageHours,
    classifyObservedJob,
    findDuplicateDedupeKeys,
    hashFingerprint,
    isScheduledForFuture,
    isStaleProcessing,
    maskTarget,
    observeDeliveryJobs,
};
