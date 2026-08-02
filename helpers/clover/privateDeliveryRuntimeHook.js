'use strict';

const { sendPrivateMessage, sendPrivateText } = require('../chatReply');
const { sendSpellReviewInviteToPlayer } = require('./groupManager');
const {
    processNextPrivateDelivery,
    workerEnabled,
} = require('./privateDeliveryWorker');

function runOnOpenEnabled(env = process.env) {
    return String(env?.CLOVER_PV_DELIVERY_RUN_ON_OPEN || '').trim() === '1';
}

async function inspectReachoutLock(sock) {
    if (typeof sock?.fetchAccountReachoutTimelock !== 'function') {
        return { ok: true, available: false, lock: null };
    }

    try {
        const lock = await sock.fetchAccountReachoutTimelock();
        return {
            ok: true,
            available: true,
            lock: lock || null,
        };
    } catch (error) {
        return {
            ok: false,
            available: true,
            lock: null,
            error: error?.message || String(error),
        };
    }
}

async function runPrivateDeliveryWorkerOnce(options = {}) {
    const env = options.env || process.env;
    if (!workerEnabled(env)) {
        return { ok: true, skipped: true, reason: 'worker_disabled' };
    }
    if (!runOnOpenEnabled(env)) {
        return { ok: true, skipped: true, reason: 'run_on_open_disabled' };
    }

    const reachout = await inspectReachoutLock(options.sock);
    if (!reachout.ok) {
        return {
            ok: false,
            skipped: true,
            reason: 'reachout_state_unavailable',
            error: reachout.error,
        };
    }
    if (reachout.lock?.isActive) {
        return {
            ok: true,
            skipped: true,
            reason: 'reachout_locked',
            enforcementType: reachout.lock.enforcementType || null,
            timeEnforcementEnds: reachout.lock.timeEnforcementEnds || null,
        };
    }

    const processNext = options.processNextPrivateDelivery || processNextPrivateDelivery;
    return processNext({
        db: options.db,
        sock: options.sock,
        env,
        now: options.now,
        workerId: options.workerId || `pv-worker:${process.pid}:${options.context || 'controlled'}`,
        retryDelaySeconds: options.retryDelaySeconds,
        sendPrivateText: options.sendPrivateText || sendPrivateText,
        sendPrivateMessage: options.sendPrivateMessage || sendPrivateMessage,
        sendSpellReviewInvite: options.sendSpellReviewInvite || sendSpellReviewInviteToPlayer,
    });
}

module.exports = {
    inspectReachoutLock,
    runOnOpenEnabled,
    runPrivateDeliveryWorkerOnce,
};
