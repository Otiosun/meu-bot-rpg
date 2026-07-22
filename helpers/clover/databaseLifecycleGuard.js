'use strict';

const states = new WeakMap();

function createState(db) {
    const state = {
        db,
        active: 0,
        retired: false,
        closing: false,
        closed: false,
        closePromise: null,
        waiters: new Set(),
        labels: new Map(),
        lastReleasedAt: Date.now(),
    };
    states.set(db, state);
    return state;
}

function getState(db) {
    if (!db || typeof db !== 'object') return null;
    return states.get(db) || createState(db);
}

function registerDatabase(db) {
    getState(db);
    return db;
}

function snapshotDatabaseLifecycle(db) {
    const state = getState(db);
    if (!state) return null;
    return {
        active: state.active,
        retired: state.retired,
        closing: state.closing,
        closed: state.closed,
        labels: Object.fromEntries(state.labels),
        lastReleasedAt: state.lastReleasedAt,
    };
}

function notifyIdle(state) {
    if (state.active !== 0) return;
    for (const resolve of state.waiters) resolve();
    state.waiters.clear();
}

function beginDatabaseLease(db, label = 'operation') {
    const state = getState(db);
    if (!state) {
        const error = new Error('Banco indisponível.');
        error.code = 'database_unavailable';
        throw error;
    }
    if (state.retired || state.closing || state.closed) {
        const error = new Error('Banco em encerramento; operação recusada.');
        error.code = 'database_retired';
        throw error;
    }

    const normalizedLabel = String(label || 'operation');
    state.active += 1;
    state.labels.set(normalizedLabel, (state.labels.get(normalizedLabel) || 0) + 1);
    let released = false;

    return () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        const count = (state.labels.get(normalizedLabel) || 1) - 1;
        if (count <= 0) state.labels.delete(normalizedLabel);
        else state.labels.set(normalizedLabel, count);
        state.lastReleasedAt = Date.now();
        notifyIdle(state);
    };
}

async function withDatabaseLease(db, label, operation) {
    const release = beginDatabaseLease(db, label);
    try {
        return await operation();
    } finally {
        release();
    }
}

function waitForIdle(state, timeoutMs) {
    if (state.active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            state.waiters.delete(onIdle);
            clearTimeout(timer);
            resolve(value);
        };
        const onIdle = () => finish(true);
        state.waiters.add(onIdle);
        const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        timer.unref?.();
    });
}

async function closeDatabaseOnce(db, options = {}) {
    const state = getState(db);
    if (!state || state.closed) return { ok: true, alreadyClosed: true };
    if (state.closePromise) return state.closePromise;

    const closeFn = options.closeFn || ((target) => target.close());
    state.closing = true;
    state.closePromise = (async () => {
        try {
            await closeFn(db);
            state.closed = true;
            return { ok: true, alreadyClosed: false };
        } catch (error) {
            if (error?.code === 'SQLITE_MISUSE' && /closed/i.test(String(error?.message || ''))) {
                state.closed = true;
                return { ok: true, alreadyClosed: true };
            }
            state.closing = false;
            state.closePromise = null;
            throw error;
        }
    })();

    return state.closePromise;
}

async function retireDatabase(db, options = {}) {
    const state = getState(db);
    if (!state) return { ok: true, skipped: true };
    if (state.closed) return { ok: true, alreadyClosed: true };

    state.retired = true;
    const graceMs = Math.max(0, Number(options.graceMs ?? 0));
    const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 30000));

    if (graceMs > 0) {
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, graceMs);
            timer.unref?.();
        });
    }

    const idle = await waitForIdle(state, timeoutMs);
    const result = await closeDatabaseOnce(db, options);
    return {
        ...result,
        idle,
        forced: !idle,
    };
}

module.exports = {
    beginDatabaseLease,
    closeDatabaseOnce,
    registerDatabase,
    retireDatabase,
    snapshotDatabaseLifecycle,
    withDatabaseLease,
};
