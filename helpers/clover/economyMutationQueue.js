'use strict';

let mutationTail = Promise.resolve();
let queueDepth = 0;
let activeMutation = null;
let ticketSequence = 0;

class EconomyQueueTimeoutError extends Error {
    constructor(details = {}) {
        super('A fila economica esta ocupada. Tente novamente em alguns segundos.');
        this.name = 'EconomyQueueTimeoutError';
        this.code = 'economy_queue_timeout';
        this.details = details;
    }
}

function positiveInteger(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
}

function safeLabel(value, fallback) {
    const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_./: -]/g, '');
    return normalized.slice(0, 160) || fallback;
}

function writeQueueLog(logger, level, event, details) {
    const target = logger && typeof logger[level] === 'function'
        ? logger[level]
        : logger && typeof logger.log === 'function'
            ? logger.log
            : null;
    if (!target) return;
    target.call(logger, '[economy-queue]', JSON.stringify({ event, ...details }));
}

function getEconomyQueueState(now = Date.now()) {
    return {
        depth: queueDepth,
        active: Boolean(activeMutation),
        operation: activeMutation?.operation || null,
        activeForMs: activeMutation ? Math.max(0, now - activeMutation.startedAt) : 0,
    };
}

async function runEconomyMutationExclusive(action, options = {}) {
    if (typeof action !== 'function') throw new TypeError('A fila economica exige uma funcao.');

    const ticket = ++ticketSequence;
    const operation = safeLabel(options.operation, 'economy_mutation');
    const requestId = safeLabel(options.requestId, '') || null;
    const maxWaitMs = positiveInteger(options.maxWaitMs);
    const slowWaitMs = positiveInteger(options.slowWaitMs, 500);
    const slowRunMs = positiveInteger(options.slowRunMs, 2000);
    const logger = options.logger || console;
    const enqueuedAt = Date.now();
    const previous = mutationTail.catch(() => {});
    let releaseCurrent;
    const currentDone = new Promise((resolve) => {
        releaseCurrent = resolve;
    });

    mutationTail = previous.then(() => currentDone);
    queueDepth += 1;

    let timeoutTimer = null;
    let releaseWasDeferred = false;
    let startedAt = null;

    try {
        let acquired = true;
        if (maxWaitMs > 0) {
            acquired = await Promise.race([
                previous.then(() => true),
                new Promise((resolve) => {
                    timeoutTimer = setTimeout(() => resolve(false), maxWaitMs);
                }),
            ]);
        } else {
            await previous;
        }

        if (!acquired) {
            const waitMs = Date.now() - enqueuedAt;
            releaseWasDeferred = true;
            previous.finally(releaseCurrent);
            writeQueueLog(logger, 'warn', 'wait_timeout', {
                operation,
                requestId,
                waitMs,
                depth: queueDepth,
            });
            throw new EconomyQueueTimeoutError({ operation, requestId, waitMs });
        }

        if (timeoutTimer) clearTimeout(timeoutTimer);
        const waitMs = Date.now() - enqueuedAt;
        startedAt = Date.now();
        activeMutation = { ticket, operation, requestId, startedAt };

        if (waitMs >= slowWaitMs) {
            writeQueueLog(logger, 'warn', 'slow_wait', {
                operation,
                requestId,
                waitMs,
                depth: queueDepth,
            });
        }

        return await action();
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        queueDepth = Math.max(0, queueDepth - 1);

        if (activeMutation?.ticket === ticket) {
            const runMs = Date.now() - startedAt;
            if (runMs >= slowRunMs) {
                writeQueueLog(logger, 'warn', 'slow_mutation', {
                    operation,
                    requestId,
                    runMs,
                });
            }
            activeMutation = null;
        }

        if (!releaseWasDeferred) releaseCurrent();
    }
}

module.exports = {
    EconomyQueueTimeoutError,
    getEconomyQueueState,
    runEconomyMutationExclusive,
};
