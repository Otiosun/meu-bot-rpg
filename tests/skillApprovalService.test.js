'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const skillTreePath = require.resolve('../helpers/clover/skillTreeService');
const approvalPath = require.resolve('../helpers/clover/skillApprovalService');

let buyCalls = 0;
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
        buyNode: async (db, playerId, treeId, nodeId, actorId, options = {}) => {
            buyCalls += 1;

            const existing = await db.get(
                `SELECT id, source, metadata_json
                   FROM clover_skill_nodes
                  WHERE player_id = ? AND tree_id = ? AND node_id = ?
                  LIMIT 1`,
                [playerId, treeId, nodeId]
            );

            if (existing) {
                return {
                    ok: true,
                    idempotent: true,
                    purchaseId: Number(existing.id),
                    source: existing.source,
                };
            }

            const metadata = {
                ...(options.metadata || {}),
                approval_request_key: options.metadata?.approval_request_key || null,
            };

            const inserted = await db.run(
                `INSERT INTO clover_skill_nodes
                 (player_id, tree_id, node_id, purchased_by, source, metadata_json)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    playerId,
                    treeId,
                    nodeId,
                    actorId,
                    options.source || 'skill_tree_approval',
                    JSON.stringify(metadata),
                ]
            );

            return {
                ok: true,
                idempotent: false,
                purchaseId: Number(inserted.lastID),
                source: options.source || 'skill_tree_approval',
            };
        },
    },
};

delete require.cache[approvalPath];
const service = require('../helpers/clover/skillApprovalService');
const MAINTENANCE_OFF = { maintenanceMode: false };

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            display_name TEXT
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

        INSERT INTO jogadores (id, personagem_nome, nome, display_name)
        VALUES ('player@test', 'Teste', 'Conta Teste', 'Display Teste');
    `);

    await service.ensureSkillApprovalSchema(db);
    return db;
}

function resetState() {
    buyCalls = 0;
    currentStatus = 'approval';
    effectiveCost = 5;
}

test('request creates one persistent pending record and never buys node', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const first = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );
    const second = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(first.request.status, 'pending');
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.request.id, first.request.id);
    assert.equal(buyCalls, 0);

    const nodes = await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes');
    const events = await db.get(
        "SELECT COUNT(*) AS total FROM clover_skill_approval_events WHERE action = 'requested'"
    );

    assert.equal(Number(nodes.total), 0);
    assert.equal(Number(events.total), 1);
});

test('request serializes player name with current jogadores schema', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    assert.equal(requested.request.playerName, 'Teste');
});

test('reject is idempotent and never buys node', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    const first = await service.rejectSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'não aprovado'
    );
    const second = await service.rejectSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'não aprovado'
    );

    assert.equal(first.request.status, 'rejected');
    assert.equal(second.idempotent, true);
    assert.equal(buyCalls, 0);

    const nodes = await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes');
    assert.equal(Number(nodes.total), 0);
});

test('approve calls buyNode once and repeated approve is replay-safe', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    const first = await service.approveSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'ok',
        MAINTENANCE_OFF
    );
    const second = await service.approveSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'ok',
        MAINTENANCE_OFF
    );

    assert.equal(first.request.status, 'approved');
    assert.equal(first.purchase.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(buyCalls, 1);

    const nodes = await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes');
    assert.equal(Number(nodes.total), 1);

    const node = await db.get(
        'SELECT source, metadata_json FROM clover_skill_nodes LIMIT 1'
    );

    assert.equal(node.source, 'skill_tree_approval');
    assert.equal(
        JSON.parse(node.metadata_json).approval_request_key,
        requested.request.request_key
    );
});

test('stale review recovers existing approved purchase without second buyNode call', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    await service.approveSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'ok',
        MAINTENANCE_OFF
    );

    assert.equal(buyCalls, 1);

    await db.run(
        `UPDATE clover_skill_approval_requests
            SET status = 'pending',
                reviewed_by = NULL,
                reviewed_at = NULL,
                purchase_id = NULL,
                review_token = 'stale-token',
                review_started_at = '2020-01-01 00:00:00'
          WHERE request_key = ?`,
        [requested.request.request_key]
    );

    const recovered = await service.approveSkillApproval(
        db,
        requested.request.request_key,
        'admin@test',
        'retry',
        MAINTENANCE_OFF
    );

    assert.equal(recovered.request.status, 'approved');
    assert.equal(buyCalls, 1);

    const recoveredEvents = await db.get(
        "SELECT COUNT(*) AS total FROM clover_skill_approval_events WHERE action = 'claim_recovered'"
    );
    assert.equal(Number(recoveredEvents.total), 1);
});

test('approve fails closed when effective cost changes after request', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    effectiveCost = 7;

    await assert.rejects(
        () => service.approveSkillApproval(
            db,
            requested.request.request_key,
            'admin@test',
            'ok',
            MAINTENANCE_OFF
        ),
        (error) => error?.code === 'approval_cost_changed'
    );

    assert.equal(buyCalls, 0);

    const row = await db.get(
        'SELECT status, review_token FROM clover_skill_approval_requests WHERE request_key = ?',
        [requested.request.request_key]
    );

    assert.equal(row.status, 'pending');
    assert.equal(row.review_token, null);
});


test('owned node without matching approval request key fails closed', async (t) => {
    resetState();
    const db = await fixture();
    t.after(() => db.close());

    const requested = await service.requestSkillApproval(
        db,
        'player@test',
        'mana',
        'node_aprovacao',
        'player@test',
        MAINTENANCE_OFF
    );

    await db.run(
        `INSERT INTO clover_skill_nodes
         (player_id, tree_id, node_id, purchased_by, source, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            'player@test',
            'mana',
            'node_aprovacao',
            'other-flow@test',
            'manual_other_flow',
            JSON.stringify({ approval_request_key: 'SAR-other' }),
        ]
    );

    currentStatus = 'owned';

    await assert.rejects(
        () => service.approveSkillApproval(
            db,
            requested.request.request_key,
            'admin@test',
            'ok',
            MAINTENANCE_OFF
        ),
        (error) => error?.code === 'node_already_owned'
    );

    const row = await db.get(
        'SELECT status, review_token FROM clover_skill_approval_requests WHERE request_key = ?',
        [requested.request.request_key]
    );

    assert.equal(row.status, 'pending');
    assert.equal(row.review_token, null);
    assert.equal(buyCalls, 0);
});
