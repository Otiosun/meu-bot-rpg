'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CREATION_MARKER_KEY,
    createRaidWithPersistentIdempotency,
    prepareRaidCreation,
} = require('../helpers/clover/raidCreationIdempotency');

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

class FakeCreationDb {
    constructor() {
        this.claims = new Map();
        this.raids = [];
        this.events = [];
        this.nextEventId = 1;
        this.transactions = [];
    }

    async exec(sql) {
        const command = String(sql || '').trim().toUpperCase();
        if (command.startsWith('BEGIN') || command === 'COMMIT' || command === 'ROLLBACK') {
            this.transactions.push(command);
        }
        return true;
    }

    async all(sql) {
        if (sql.includes('FROM clover_raids')) {
            return [...this.raids].sort((a, b) => b.id - a.id);
        }
        return [];
    }

    async get(sql, params = []) {
        if (sql.includes('clover_raid_events') && sql.includes('idempotency_key')) {
            return this.events.find((event) => event.idempotency_key === params[0]) || null;
        }
        if (sql.includes('clover_raid_events') && sql.includes('WHERE id = ?')) {
            return this.events.find((event) => event.id === Number(params[0])) || null;
        }
        if (sql.includes('clover_raid_creation_requests')) {
            return this.claims.get(params[0]) || null;
        }
        return null;
    }

    async run(sql, params = []) {
        if (sql.includes('INSERT INTO clover_raid_creation_requests')) {
            const [key, fingerprint, actorId, processingToken, leaseExpiresAt] = params;
            this.claims.set(key, {
                idempotency_key: key,
                fingerprint,
                actor_id: actorId,
                status: 'processing',
                processing_token: processingToken,
                lease_expires_at: leaseExpiresAt,
                raid_id: null,
                result_json: null,
            });
            return { changes: 1 };
        }

        if (sql.includes("SET status = 'processing'")) {
            const [actorId, processingToken, leaseExpiresAt, key, fingerprint] = params;
            const claim = this.claims.get(key);
            if (claim && claim.fingerprint === fingerprint) {
                Object.assign(claim, {
                    actor_id: actorId,
                    status: 'processing',
                    processing_token: processingToken,
                    lease_expires_at: leaseExpiresAt,
                });
                return { changes: 1 };
            }
            return { changes: 0 };
        }

        if (sql.includes("SET status = 'completed'")) {
            const [raidId, resultJson, key, fingerprint] = params;
            const claim = this.claims.get(key);
            if (claim && claim.fingerprint === fingerprint) {
                Object.assign(claim, {
                    status: 'completed',
                    raid_id: raidId,
                    result_json: resultJson,
                    processing_token: null,
                    lease_expires_at: null,
                });
                return { changes: 1 };
            }
            return { changes: 0 };
        }

        if (sql.includes("SET status = 'pending'")) {
            const [key, fingerprint, processingToken] = params;
            const claim = this.claims.get(key);
            if (
                claim
                && claim.fingerprint === fingerprint
                && claim.processing_token === processingToken
                && claim.status === 'processing'
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
            const [raidId, action, actorId, subjectPlayerId, afterJson, key, metadataJson] = params;
            if (this.events.some((event) => event.idempotency_key === key)) {
                throw new Error('duplicate event key');
            }
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

function raidMetadata(input) {
    return JSON.stringify(input.metadata || {});
}

test('create com mesma chave executa uma vez e depois faz replay persistente', async () => {
    const db = new FakeCreationDb();
    let executions = 0;
    const input = {
        idempotencyKey: 'create-raid-1',
        name: 'Raid de teste',
        category: 'saga_pessoal',
    };
    const options = {
        errorFactory,
        execute: async (preparedInput) => {
            executions += 1;
            const raid = {
                id: 10,
                key: 'RAID-ONE',
                metadata: preparedInput.metadata,
            };
            db.raids.push({
                id: raid.id,
                raid_key: raid.key,
                metadata_json: raidMetadata(preparedInput),
            });
            return { ok: true, raid, role: 'owner', principal: true };
        },
        recover: async () => {
            throw new Error('recover should not run');
        },
    };

    const first = await createRaidWithPersistentIdempotency(db, 'actor@test', input, options);
    const second = await createRaidWithPersistentIdempotency(db, 'actor@test', input, options);

    assert.equal(executions, 1);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.idempotentReplay, true);
    assert.equal(second.raid.key, 'RAID-ONE');
    assert.equal(db.raids.length, 1);
    assert.equal(db.events.length, 1);
    assert.equal(db.claims.get('create-raid-1').status, 'completed');
});

test('retry recupera Raid que commitou antes do recibo final', async () => {
    const db = new FakeCreationDb();
    const input = {
        idempotencyKey: 'create-crash-1',
        name: 'Raid ambigua',
        category: 'saga_pessoal',
    };
    const prepared = await prepareRaidCreation(db, {
        actorId: 'actor@test',
        input,
        errorFactory,
    });
    assert.equal(prepared.mode, 'execute');

    db.raids.push({
        id: 22,
        raid_key: 'RAID-RECOVERED',
        metadata_json: JSON.stringify({
            [CREATION_MARKER_KEY]: prepared.input.metadata[CREATION_MARKER_KEY],
        }),
    });

    let executions = 0;
    let recoveries = 0;
    const result = await createRaidWithPersistentIdempotency(db, 'actor@test', input, {
        errorFactory,
        execute: async () => {
            executions += 1;
            throw new Error('must not execute');
        },
        recover: async (raidKey, raidId) => {
            recoveries += 1;
            return {
                ok: true,
                raid: { id: raidId, key: raidKey },
                role: 'owner',
                principal: true,
            };
        },
    });

    assert.equal(executions, 0);
    assert.equal(recoveries, 1);
    assert.equal(result.duplicate, true);
    assert.equal(result.recoveredAfterAmbiguousCommit, true);
    assert.equal(result.raid.key, 'RAID-RECOVERED');
    assert.equal(db.events.length, 1);
    assert.equal(db.claims.get('create-crash-1').status, 'completed');
});

test('claim ativo impede segunda criacao concorrente sem Raid recuperavel', async () => {
    const db = new FakeCreationDb();
    const input = {
        idempotencyKey: 'create-busy-1',
        name: 'Raid ocupada',
        category: 'saga_pessoal',
    };

    const first = await prepareRaidCreation(db, {
        actorId: 'actor@test',
        input,
        errorFactory,
        leaseMs: 60_000,
    });
    assert.equal(first.mode, 'execute');

    await assert.rejects(
        () => prepareRaidCreation(db, {
            actorId: 'actor@test',
            input,
            errorFactory,
            leaseMs: 60_000,
        }),
        (error) => error?.code === 'idempotency_in_progress'
    );
});

test('mesma chave com criacao diferente falha fechada', async () => {
    const db = new FakeCreationDb();
    await prepareRaidCreation(db, {
        actorId: 'actor@test',
        input: {
            idempotencyKey: 'create-conflict-1',
            name: 'Raid A',
            category: 'saga_pessoal',
        },
        errorFactory,
        leaseMs: 60_000,
    });

    await assert.rejects(
        () => prepareRaidCreation(db, {
            actorId: 'actor@test',
            input: {
                idempotencyKey: 'create-conflict-1',
                name: 'Raid B',
                category: 'saga_pessoal',
            },
            errorFactory,
        }),
        (error) => error?.code === 'idempotency_conflict'
    );
});
