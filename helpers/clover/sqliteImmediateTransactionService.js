'use strict';

// sqlite's transaction state belongs to the connection. Two async callers using
// the same sqlite wrapper cannot safely overlap BEGIN/COMMIT/ROLLBACK: a failed
// BEGIN from one caller must never rollback another caller's active transaction.
// Keep top-level transactions serialized per connection while preserving
// BEGIN IMMEDIATE as the cross-connection/process locking boundary.
const connectionGates = new WeakMap();

function assertConnection(db) {
    if (!db || (typeof db !== 'object' && typeof db !== 'function') || typeof db.exec !== 'function') {
        throw new TypeError('Uma conexao SQLite valida e obrigatoria.');
    }
}

async function runSerializedOnConnection(db, work) {
    assertConnection(db);
    if (typeof work !== 'function') throw new TypeError('work deve ser uma funcao.');

    const previousGate = connectionGates.get(db) || Promise.resolve();
    let releaseCurrent;
    const currentGate = new Promise((resolve) => {
        releaseCurrent = resolve;
    });
    connectionGates.set(db, currentGate);

    await previousGate;
    try {
        return await work();
    } finally {
        releaseCurrent();
        if (connectionGates.get(db) === currentGate) connectionGates.delete(db);
    }
}

async function withImmediateTransaction(db, work) {
    return runSerializedOnConnection(db, async () => {
        let began = false;
        try {
            await db.exec('BEGIN IMMEDIATE');
            began = true;
            const result = await work();
            await db.exec('COMMIT');
            began = false;
            return result;
        } catch (error) {
            if (began) await db.exec('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

module.exports = {
    runSerializedOnConnection,
    withImmediateTransaction,
};
