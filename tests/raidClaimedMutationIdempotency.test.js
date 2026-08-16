'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    prepareClaim,
    runClaimedRaidMutation,
} = require('../helpers/clover/raidClaimedMutationIdempotency');

class FakeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

function errorFactory(code, message, details = {}) {
    return new FakeError(code, message, details);
}

class FakeDb {
    constructor() {
        this.claims = new Map();
        this.events = [];
        this.nextEventId = 1;
        this.failReceiptOnce = false;
    }

    async exec() {
        return true;
    }

    async get(sql, params = []) {
        if (sql.includes('clover_raid_events') && sql.includes('idempotency_key')) {
            return this.events.find((event) => event.idempotency_key === params[0]) || null;
        }
        if (sql.includes('clover_raid_events') && sql.includes('WHERE id = ?')) {
            return this.events.find((event) => event.id === Number(params[0])) || null;
        }
        if (sql.includes('clover_raid_mutation_requests')) {
            return this.claims.get(params[0]) || null;
        }
        return null;
    }

    async run(sql, params = []) {
        if (sql.includes('INSERT INTO clover_raid_mutation_requests')) {
            const [
                key,
                operation,
                fingerprint,
                actorId,
                raidId,
                subjectPlayerId,
                processingToken,
                leaseExpiresAt,
            ] = params;
            this.claims.set(key, {
                idempotency_key: key,
                operation,
                fingerprint,
                actor_id: actorId,
                raid_id: raidId,
                subject_player_id: subjectPlayerId,
                status: 'processing',
                processing_token: processingToken,
                lease_expires_at: leaseExpiresAt,
                result_json: null,
                created_at: '2026-08-07 12:00:00',
                updated_at: '2026-08-07 12:00:00',
            });
            return { changes: 1 };
        }

        if (sql.includes("SET status = 'processing'")) {
            const [processingToken, leaseExpiresAt, subjectPlayerId, key, operation, fingerprint] = params;
            const claim = this.claims.get(key);
            if (claim && claim.operation === operation && claim.fingerprint === fingerprint) {
                Object.assign(claim, {
                    status: 'processing',
                    processing_token: processingToken,
                    lease_expires_at: leaseExpiresAt,
                    subject_player_id: subjectPlayerId,
                });
                return { changes: 1 };
            }
            return { changes: 0 };
        }

        if (sql.includes("SET status = 'completed'")) {
            const [resultJson, key, operation, fingerprint] = params;
            const claim = this.claims.get(key);
            if (claim && claim.operation === operation && claim.fingerprint === fingerprint) {
                Object.assign(claim, {
                    status: 'completed',
                    result_json: resultJson,
                    processing_token: null,
                    lease_expires_at: null,
                });
                return { changes: 1 };
            }
            return { changes: 0 };
        }

        if (sql.includes("SET status = 'pending'")) {
            const [key, operation, fingerprint, processingToken] = params;
            const claim = this.claims.get(key);
            if (
                claim
                && claim.operation === operation
                && claim.fingerprint === fingerprint
                && claim.processing_token === processingToken
            ) {
                Object.assign(claim, {
                    status: 'pending',
                    processing_token: null,
                    lease_expires_at: null,
                });
                return { changes: 1 };
            }
            return { changes: 0 };
        }

        if (sql.includes('INSERT INTO clover_raid_events')) {
            if (this.failReceiptOnce) {
                this.failReceiptOnce = false;
                throw new Error('receipt write failed');
            }
            const [raidId, action, actorId, subjectPlayerId, afterJson, key, metadataJson] = params;
            const event = {
                id: this.nextEventId++,
                raid_id: raidId,
                action,
                actor_id: actorId,
                subject_player_id: subjectPlayerId,
                after_json: afterJson,
                idempotency_key: key,
                metadata_json: metadataJson,
            };
            this.events.push(event);
            return { lastID: event.id, changes: 1 };
        }

        throw new Error(`Unexpected fake SQL: ${sql}`);
    }
}

function options(key = 'k1', payload = { value: 1 }) {
    return {
        operation: 'op',
        input: { idempotencyKey: key },
        payload,
        actorId: 'actor',
        raidId: 7,
        subjectPlayerId: 'target',
        errorFactory,
    };
}

test('claimed mutation executes once then replays persistent receipt', async () => {
    const db = new FakeDb();
    let executions = 0;
    const base = options();

    const first = await runClaimedRaidMutation(db, {
        ...base,
        execute: async () => {
            executions += 1;
            return { ok: true, value: 42 };
        },
    });
    const second = await runClaimedRaidMutation(db, {
        ...base,
        execute: async () => {
            executions += 1;
            return { ok: true, value: 99 };
        },
    });

    assert.equal(executions, 1);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.value, 42);
    assert.equal(db.claims.get('k1').status, 'completed');
    assert.equal(db.events.length, 1);
});

test('claimed mutation rejects same key with different payload', async () => {
    const db = new FakeDb();
    const first = await prepareClaim(db, {
        ...options('conflict', { value: 1 }),
        leaseMs: 60_000,
    });
    assert.equal(first.mode, 'execute');

    await assert.rejects(
        () => prepareClaim(db, {
            ...options('conflict', { value: 2 }),
            leaseMs: 60_000,
        }),
        (error) => error?.code === 'idempotency_conflict'
    );
});

test('processing claim recovers committed domain effect without executing again', async () => {
    const db = new FakeDb();
    const base = options('recover');
    const prepared = await prepareClaim(db, { ...base, leaseMs: 60_000 });
    assert.equal(prepared.mode, 'execute');

    let executions = 0;
    let recoveries = 0;
    const result = await runClaimedRaidMutation(db, {
        ...base,
        recover: async () => {
            recoveries += 1;
            return { ok: true, recovered: true };
        },
        execute: async () => {
            executions += 1;
            return { ok: true };
        },
    });

    assert.equal(executions, 0);
    assert.equal(recoveries, 1);
    assert.equal(result.recoveredAfterAmbiguousCommit, true);
    assert.equal(db.claims.get('recover').status, 'completed');
    assert.equal(db.events.length, 1);
});

test('domain failure releases claimed mutation to pending', async () => {
    const db = new FakeDb();
    const base = options('fail');

    await assert.rejects(
        () => runClaimedRaidMutation(db, {
            ...base,
            execute: async () => {
                throw new Error('domain failure');
            },
        }),
        /domain failure/
    );

    assert.equal(db.claims.get('fail').status, 'pending');
});

test('receipt failure after domain success keeps processing claim for recovery', async () => {
    const db = new FakeDb();
    const base = options('postcommit');
    let executions = 0;
    db.failReceiptOnce = true;

    await assert.rejects(
        () => runClaimedRaidMutation(db, {
            ...base,
            execute: async () => {
                executions += 1;
                return { ok: true, committed: true };
            },
        }),
        /receipt write failed/
    );

    assert.equal(executions, 1);
    assert.equal(db.claims.get('postcommit').status, 'processing');

    const second = await runClaimedRaidMutation(db, {
        ...base,
        recover: async () => ({ ok: true, committed: true }),
        execute: async () => {
            executions += 1;
            return { ok: true };
        },
    });

    assert.equal(executions, 1);
    assert.equal(second.recoveredAfterAmbiguousCommit, true);
    assert.equal(db.claims.get('postcommit').status, 'completed');
});
