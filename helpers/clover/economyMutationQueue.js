'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const pending = [];
let queueDepth = 0;
let activeWriter = null;
const activeReaders = new Map();
let ticketSequence = 0;
const mutationContext = new AsyncLocalStorage();

class EconomyQueueTimeoutError extends Error {
    constructor(details = {}) {
        super('A fila economica esta ocupada. Tente novamente em alguns segundos.');
        this.name = 'EconomyQueueTimeoutError';
        this.code = 'economy_queue_timeout';
        this.details = details;
    }
}

class EconomyQueueUpgradeError extends Error {
    constructor(details = {}) {
        super('Uma mutacao economica nao pode iniciar dentro de uma leitura compartilhada.');
        this.name = 'EconomyQueueUpgradeError';
        this.code = 'economy_queue_read_to_write_upgrade';
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

function isEconomyReadOperation(operation, options = {}) {
    if (options.readOnly === true || options.mode === 'read') return true;
    const normalized = safeLabel(operation, 'economy_mutation');
    return /^GET(?:\s|$)/i.test(normalized)
        || normalized === 'site:pr-shop-dashboard';
}

function activeReadState() {
    let earliest = null;
    for (const state of activeReaders.values()) {
        if (!earliest || state.startedAt < earliest.startedAt) earliest = state;
    }
    return earliest;
}

function getEconomyQueueState(now = Date.now()) {
    const active = activeWriter || activeReadState();
    return {
        depth: queueDepth,
        active: Boolean(active),
        operation: active?.operation || null,
        activeForMs: active ? Math.max(0, now - active.startedAt) : 0,
    };
}

function removePending(entry) {
    const index = pending.indexOf(entry);
    if (index < 0) return false;
    pending.splice(index, 1);
    return true;
}

function finishEntry(entry) {
    queueDepth = Math.max(0, queueDepth - 1);
    if (entry.kind === 'write') {
        if (activeWriter?.ticket === entry.ticket) activeWriter = null;
    } else {
        activeReaders.delete(entry.ticket);
    }
    processQueue();
}

function settleEntry(entry, executionContext, startedAt, error, value) {
    executionContext.active = false;
    const runMs = Date.now() - startedAt;
    if (runMs >= entry.slowRunMs) {
        writeQueueLog(entry.logger, 'warn', entry.kind === 'write' ? 'slow_mutation' : 'slow_read', {
            operation: entry.operation,
            requestId: entry.requestId,
            runMs,
        });
    }

    finishEntry(entry);
    if (error) entry.reject(error);
    else entry.resolve(value);
}

function runEntry(entry) {
    entry.started = true;
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);

    const waitMs = Date.now() - entry.enqueuedAt;
    const startedAt = Date.now();
    const executionContext = {
        active: true,
        kind: entry.kind,
        ticket: entry.ticket,
        operation: entry.operation,
        requestId: entry.requestId,
    };

    if (entry.kind === 'write') {
        activeWriter = {
            ticket: entry.ticket,
            operation: entry.operation,
            requestId: entry.requestId,
            startedAt,
        };
    } else {
        activeReaders.set(entry.ticket, {
            ticket: entry.ticket,
            operation: entry.operation,
            requestId: entry.requestId,
            startedAt,
        });
    }

    if (waitMs >= entry.slowWaitMs) {
        writeQueueLog(entry.logger, 'warn', 'slow_wait', {
            kind: entry.kind,
            operation: entry.operation,
            requestId: entry.requestId,
            waitMs,
            depth: queueDepth,
        });
    }

    Promise.resolve()
        .then(() => mutationContext.run(executionContext, entry.action))
        .then(
            (value) => settleEntry(entry, executionContext, startedAt, null, value),
            (error) => settleEntry(entry, executionContext, startedAt, error)
        );
}

function processQueue() {
    if (activeWriter) return;

    if (activeReaders.size > 0) {
        while (pending[0]?.kind === 'read') {
            runEntry(pending.shift());
        }
        return;
    }

    const next = pending[0];
    if (!next) return;
    if (next.kind === 'write') {
        runEntry(pending.shift());
        return;
    }

    while (pending[0]?.kind === 'read') {
        runEntry(pending.shift());
    }
}

async function runEconomyMutationExclusive(action, options = {}) {
    if (typeof action !== 'function') throw new TypeError('A fila economica exige uma funcao.');

    const operation = safeLabel(options.operation, 'economy_mutation');
    const requestId = safeLabel(options.requestId, '') || null;
    const logger = options.logger || console;
    const kind = isEconomyReadOperation(operation, options) ? 'read' : 'write';
    const inheritedContext = mutationContext.getStore();

    if (inheritedContext?.active) {
        if (inheritedContext.kind === 'read' && kind === 'write') {
            const details = {
                operation,
                requestId,
                outerOperation: inheritedContext.operation,
                outerRequestId: inheritedContext.requestId,
            };
            writeQueueLog(logger, 'error', 'nested_upgrade_rejected', details);
            throw new EconomyQueueUpgradeError(details);
        }

        writeQueueLog(logger, 'warn', 'nested_reuse', {
            kind,
            operation,
            requestId,
            outerKind: inheritedContext.kind,
            outerOperation: inheritedContext.operation,
            outerRequestId: inheritedContext.requestId,
        });
        return action();
    }

    const ticket = ++ticketSequence;
    const maxWaitMs = positiveInteger(options.maxWaitMs);
    const slowWaitMs = positiveInteger(options.slowWaitMs, 500);
    const slowRunMs = positiveInteger(options.slowRunMs, 2000);
    const enqueuedAt = Date.now();

    return new Promise((resolve, reject) => {
        const entry = {
            action,
            kind,
            ticket,
            operation,
            requestId,
            logger,
            maxWaitMs,
            slowWaitMs,
            slowRunMs,
            enqueuedAt,
            resolve,
            reject,
            started: false,
            timeoutTimer: null,
        };

        queueDepth += 1;
        pending.push(entry);

        if (maxWaitMs > 0) {
            entry.timeoutTimer = setTimeout(() => {
                if (entry.started || !removePending(entry)) return;
                queueDepth = Math.max(0, queueDepth - 1);
                const waitMs = Date.now() - enqueuedAt;
                writeQueueLog(logger, 'warn', 'wait_timeout', {
                    kind,
                    operation,
                    requestId,
                    waitMs,
                    depth: queueDepth,
                });
                reject(new EconomyQueueTimeoutError({ operation, requestId, waitMs }));
                processQueue();
            }, maxWaitMs);
        }

        processQueue();
    });
}

module.exports = {
    EconomyQueueTimeoutError,
    EconomyQueueUpgradeError,
    getEconomyQueueState,
    isEconomyReadOperation,
    runEconomyMutationExclusive,
};