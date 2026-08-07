'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const skillTreePath = require.resolve('../helpers/clover/skillTreeService');
const phPath = require.resolve('../helpers/clover/phService');
const approvalPath = require.resolve('../helpers/clover/skillApprovalService');

let spendCalls = 0;
let currentStatus = 'approval';
let effectiveCost = 5;

require.cache[skillTreePath] = {
    id: skillTreePath,
    filename: skillTreePath,
    loaded: true,
    exports: {
        getNodeDetails: async () => ({
            ok: true,
            state: { tree: { id: 'mana', name: 'Mana' } },
            node: { id: 'node_aprovacao', name: 'Nó Aprovado', cost: 5 },
            nodeState: {
                status: currentStatus,
                effectiveCost,
                discount: { percent: 0, sources: [] },
            },
        }),
        getTreeState: async () => ({
            ok: true,
            tree: { id: 'mana', name: 'Mana' },
        }),
    },
};

require.cache[phPath] = {
    id: phPath,
    filename: phPath,
    loaded: true,
    exports: {
        spendPhInTransaction: async (_db, playerId, amount, source, reason, actorId, metadata, relatedId) => {
            spendCalls += 1;
            return {
                ok: true,
                playerId,
                amount: -Math.abs(amount),
                source,
                reason,
                actorId,
                metadata,
                relatedId,
                ledgerId: 77,
            };
        },
    },
};

delete require.cache[approvalPath];
const service = require('../helpers/clover/skillApprovalService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT
        );
        CREATE TABLE clover_skill_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            tree_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            purchased_at TEXT DEFAULT CURRENT_TIMESTAMP,
            purchased_by TEXT,
            source TEXT,
            metadata_json TEXT,
            UNIQUE(player_id, tree_id, node_id)
        );
        INSERT INTO jogadores (id, personagem_nome)
        VALUES ('player@test', 'Teste');
    `);
    await service.ensureSkillApprovalSchema(db);
    return db;
}

function resetState() {
    spendCalls = 0;
    currentStatus = 'approval';
    effectiveCost = 5;
}

test('request persists pending approval without buying node or spending PH', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const first = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test'
    );
    const second = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test'
    );

    assert.equal(first.ok, true);
    assert.equal(first.request.status, 'pending');
    assert.equal(second.idempotent, true);
    assert.equal(second.request.id, first.request.id);
    assert.equal(spendCalls, 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes')).total), 0);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS total FROM clover_skill_approval_events WHERE action = 'requested'")).total), 1);
});

test('reject is idempotent and never spends PH', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(db, 'player@test', 'mana', 'node_aprovacao');
    const first = await service.rejectSkillApproval(db, requested.request.request_key, 'admin@test', 'não aprovado');
    const second = await service.rejectSkillApproval(db, requested.request.request_key, 'admin@test', 'não aprovado');

    assert.equal(first.request.status, 'rejected');
    assert.equal(second.idempotent, true);
    assert.equal(spendCalls, 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes')).total), 0);
});

test('approve buys once, spends PH once and repeated approve is replay-safe', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(db, 'player@test', 'mana', 'node_aprovacao');
    const first = await service.approveSkillApproval(db, requested.request.request_key, 'admin@test', 'ok');
    const second = await service.approveSkillApproval(db, requested.request.request_key, 'admin@test', 'ok');

    assert.equal(first.request.status, 'approved');
    assert.equal(first.purchase.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(spendCalls, 1);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes')).total), 1);
    const node = await db.get('SELECT source, metadata_json FROM clover_skill_nodes LIMIT 1');
    assert.equal(node.source, 'skill_tree_approval');
    assert.equal(JSON.parse(node.metadata_json).approval_request_key, requested.request.request_key);
});

test('stale pending review recovers committed approved purchase without spending again', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(db, 'player@test', 'mana', 'node_aprovacao');
    const approved = await service.approveSkillApproval(db, requested.request.request_key, 'admin@test', 'ok');
    assert.equal(spendCalls, 1);

    await db.run(
        `UPDATE clover_skill_approval_requests
         SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, purchase_id = NULL,
             review_token = 'stale-token', review_started_at = '2020-01-01 00:00:00'
         WHERE request_key = ?`,
        [requested.request.request_key]
    );

    const recovered = await service.approveSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'retry'
    );

    assert.equal(recovered.request.status, 'approved');
    assert.equal(recovered.purchase.idempotent, true);
    assert.equal(recovered.purchase.purchaseId, approved.purchase.purchaseId);
    assert.equal(spendCalls, 1);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS total FROM clover_skill_approval_events WHERE action = 'claim_recovered'")).total), 1);
});

test('approve fails closed when cost changed after request', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(db, 'player@test', 'mana', 'node_aprovacao');
    effectiveCost = 7;

    await assert.rejects(
        () => service.approveSkillApproval(db, requested.request.request_key, 'admin@test', 'ok'),
        (error) => error?.code === 'approval_cost_changed'
    );
    assert.equal(spendCalls, 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes')).total), 0);
    const row = await db.get('SELECT status, review_token FROM clover_skill_approval_requests WHERE request_key = ?', [requested.request.request_key]);
    assert.equal(row.status, 'pending');
    assert.equal(row.review_token, null);
});
