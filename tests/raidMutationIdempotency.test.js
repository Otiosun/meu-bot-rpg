'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canonicalJson,
    inspectRaidMutationReceipt,
    mutationFingerprint,
    withoutIdempotencyFields,
} = require('../helpers/clover/raidMutationIdempotency');
const {
    runPersistentMutation,
} = require('../helpers/clover/raidIdempotentMutationService');

class FakeRaidDb {
    constructor() {
        this.events = [];
        this.transaction = [];
        this.nextId = 1;
    }

    async exec(sql) {
        const command = String(sql || '').trim().toUpperCase();
        this.transaction.push(command);
        return true;
    }

    async get(sql, params = []) {
        if (sql.includes('WHERE idempotency_key = ?')) {
            return this.events.find((event) => event.idempotency_key === params[0]) || null;
        }
        if (sql.includes('WHERE id = ?')) {
            return this.events.find((event) => event.id === Number(params[0])) || null;
        }
        return null;
    }

    async run(sql, params = []) {
        if (!sql.includes('INSERT INTO clover_raid_events')) {
            throw new Error(`Unexpected fake SQL: ${sql}`);
        }
        const [raidId, action, actorId, subjectPlayerId, afterJson, key, metadataJson] = params;
        if (this.events.some((event) => event.idempotency_key === key)) {
            const error = new Error('UNIQUE constraint failed: clover_raid_events.idempotency_key');
            error.code = 'SQLITE_CONSTRAINT';
            throw error;
        }
        const event = {
            id: this.nextId++,
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
}

test('canonical fingerprint ignora a chave e ordena objetos', () => {
    const a = {
        targetType: 'general',
        metadata: { z: 2, a: 1 },
        idempotencyKey: 'first',
    };
    const b = {
        idempotency_key: 'second',
        metadata: { a: 1, z: 2 },
        targetType: 'general',
    };

    assert.deepEqual(withoutIdempotencyFields(a), {
        targetType: 'general',
        metadata: { z: 2, a: 1 },
    });
    assert.equal(canonicalJson(withoutIdempotencyFields(a)), canonicalJson(withoutIdempotencyFields(b)));
    assert.equal(mutationFingerprint('add_reward', a), mutationFingerprint('add_reward', b));
});

test('retry com mesma chave e mesmo payload devolve o primeiro resultado sem executar novamente', async () => {
    const db = new FakeRaidDb();
    let executions = 0;
    const input = {
        idempotencyKey: 'raid-reward-abc',
        rewardType: 'ph',
        amount: 10,
    };
    const options = {
        operation: 'add_reward',
        raidKey: 'RAID-TEST',
        actorId: 'actor@test',
        input,
        execute: async () => {
            executions += 1;
            return { ok: true, reward: { id: 44, raidId: 7, amount: 10 } };
        },
    };

    const first = await runPersistentMutation(db, options);
    const second = await runPersistentMutation(db, options);

    assert.equal(executions, 1);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.idempotentReplay, true);
    assert.equal(second.reward.id, 44);
    assert.equal(db.events.length, 1);
    assert.equal(db.transaction.filter((item) => item === 'BEGIN IMMEDIATE').length, 2);
    assert.equal(db.transaction.filter((item) => item === 'COMMIT').length, 2);
});

test('mesma chave com payload diferente falha fechada e nao executa a segunda mutacao', async () => {
    const db = new FakeRaidDb();
    let executions = 0;

    const base = {
        operation: 'add_condition',
        raidKey: 'RAID-TEST',
        actorId: 'actor@test',
        execute: async () => {
            executions += 1;
            return { ok: true, condition: { id: 12, raid_id: 7 } };
        },
    };

    await runPersistentMutation(db, {
        ...base,
        input: { idempotencyKey: 'condition-abc', label: 'Queimadura', severity: 'normal' },
    });

    await assert.rejects(
        () => runPersistentMutation(db, {
            ...base,
            input: { idempotencyKey: 'condition-abc', label: 'Queimadura', severity: 'critica' },
        }),
        (error) => error?.code === 'idempotency_conflict'
    );

    assert.equal(executions, 1);
    assert.equal(db.events.length, 1);
    assert.equal(db.transaction.at(-1), 'ROLLBACK');
});

test('falha da mutacao faz rollback e nao grava recibo', async () => {
    const db = new FakeRaidDb();

    await assert.rejects(
        () => runPersistentMutation(db, {
            operation: 'add_reward',
            raidKey: 'RAID-TEST',
            actorId: 'actor@test',
            input: { idempotencyKey: 'reward-fail', rewardType: 'ph', amount: 10 },
            execute: async () => {
                throw new Error('boom');
            },
        }),
        /boom/
    );

    assert.equal(db.events.length, 0);
    assert.deepEqual(db.transaction, ['BEGIN IMMEDIATE', 'ROLLBACK']);
});

test('evento antigo ou de outra operacao com a mesma chave e conflito', () => {
    const payload = {
        raidKey: 'RAID-TEST',
        actorId: 'actor@test',
        input: { idempotencyKey: 'same', label: 'X' },
    };
    const event = {
        action: 'raid_completed',
        metadata_json: '{}',
        after_json: '{}',
    };
    const inspection = inspectRaidMutationReceipt(event, 'add_condition', payload);
    assert.equal(inspection.status, 'conflict');
});
