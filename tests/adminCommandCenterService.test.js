'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    getAdminCommandCenter,
    getAdminUnifiedHistory,
} = require('../helpers/clover/adminCommandCenterService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_admin_operations (
            id INTEGER PRIMARY KEY,
            code TEXT,
            status TEXT,
            title TEXT,
            reason TEXT,
            actor_id TEXT,
            metadata_json TEXT,
            error_json TEXT,
            updated_at TEXT
        );
        CREATE TABLE clover_admin_operation_units (
            id INTEGER PRIMARY KEY,
            operation_id INTEGER,
            status TEXT
        );
        CREATE TABLE clover_admin_operation_events (
            id INTEGER PRIMARY KEY,
            operation_id INTEGER,
            event_type TEXT,
            from_status TEXT,
            to_status TEXT,
            actor_id TEXT,
            payload_json TEXT,
            created_at TEXT
        );
        CREATE TABLE clover_raid_reward_proposals (
            id INTEGER PRIMARY KEY,
            raid_id INTEGER,
            proposed_by TEXT,
            status TEXT,
            proposed_at TEXT,
            reviewed_by TEXT,
            reviewed_at TEXT,
            review_note TEXT,
            delivery_key TEXT
        );
        CREATE TABLE clover_raid_reward_proposal_revisions (
            proposal_id INTEGER,
            revision_number INTEGER,
            submitted_by TEXT,
            submission_action TEXT,
            proposal_status TEXT,
            snapshot_hash TEXT,
            snapshot_version INTEGER,
            submitted_at TEXT
        );
        CREATE TABLE clover_canonical_admin_role_changes (
            code TEXT PRIMARY KEY,
            status TEXT,
            action TEXT,
            actor_id TEXT,
            target_id TEXT,
            requested_role TEXT,
            reason TEXT,
            created_at TEXT,
            expires_at TEXT,
            applied_at TEXT,
            applied_by TEXT,
            cancelled_at TEXT,
            cancelled_by TEXT,
            undone_at TEXT,
            undone_by TEXT
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT,
            current_stars INTEGER,
            historical_stars INTEGER,
            updated_at TEXT
        );
        CREATE TABLE clover_squad_star_ledger (
            id INTEGER PRIMARY KEY,
            squad_key TEXT,
            amount INTEGER,
            source TEXT
        );
    `);
    await db.exec(`
        INSERT INTO clover_admin_operations VALUES
            (1, 'OP-ABC123', 'partially_applied', 'Entrega em lote', 'Teste',
             'admin@lid', '{}', '{"code":"one_failed"}', '2026-08-02T10:00:00Z');
        INSERT INTO clover_admin_operation_units VALUES
            (1, 1, 'applied'), (2, 1, 'failed');
        INSERT INTO clover_admin_operation_events VALUES
            (1, 1, 'partially_applied', 'applying', 'partially_applied',
             'admin@lid', '{"failed":1}', '2026-08-02T10:00:00Z');
        INSERT INTO clover_raid_reward_proposals VALUES
            (8, 44, 'captain@lid', 'pending', '2026-08-02T09:00:00Z',
             NULL, NULL, NULL, NULL);
        INSERT INTO clover_raid_reward_proposal_revisions VALUES
            (8, 1, 'captain@lid', 'created', 'pending', 'hash-1', 1,
             '2026-08-02T09:00:00Z');
        INSERT INTO clover_canonical_admin_role_changes VALUES
            ('AC-12345678', 'draft', 'set', 'owner@lid', 'target@lid', 'evaluator',
             'Reforço', '2026-08-02T08:00:00Z', '2026-08-02T08:15:00Z',
             NULL, NULL, NULL, NULL, NULL, NULL);
        INSERT INTO clover_squads VALUES
            ('teste', 'Teste', 99, 99, '2026-08-02T07:00:00Z');
        INSERT INTO clover_squad_star_ledger VALUES
            (1, 'teste', 10, 'raid'), (2, 'teste', -4, 'qg_upgrade');
    `);
    return db;
}

function integrityFixture() {
    return {
        generatedAt: '2026-08-02T11:00:00Z',
        readOnly: true,
        summary: { total: 1, critical: 1, warning: 0, info: 0 },
        issues: [{
            section: 'identity',
            severity: 'critical',
            code: 'broken_pointer',
            message: 'Referência quebrada.',
            playerId: 'broken@lid',
            label: 'Cadastro quebrado',
            count: 1,
        }],
    };
}

test('inbox agrega pendencias e nao executa qualquer escrita', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const originalRun = db.run.bind(db);
    const originalExec = db.exec.bind(db);
    db.run = async () => { throw new Error('read_model_attempted_run'); };
    db.exec = async () => { throw new Error('read_model_attempted_exec'); };

    const result = await getAdminCommandCenter(db, {
        now: '2026-08-02T12:00:00Z',
        limit: 20,
        integrityResolver: async () => integrityFixture(),
    });

    db.run = originalRun;
    db.exec = originalExec;

    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.sections.operations.length, 1);
    assert.equal(result.sections.raidRewardProposals.length, 1);
    assert.equal(result.sections.adminRoleChanges[0].status, 'expired_preview');
    assert.equal(result.sections.starAnomalies.length, 1);
    assert.equal(result.sections.starAnomalies[0].metadata.ledgerCurrent, 6);
    assert.equal(result.sections.starAnomalies[0].metadata.ledgerHistorical, 10);
    assert.equal(result.summary.integrityIssues, 1);
    assert.equal(result.items[0].priority, 'critical');
    assert.deepEqual(result.deferredDomains, ['squad_membership_migration']);
});

test('historico unifica operacoes, cargos e revisoes sem perder origem', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await getAdminUnifiedHistory(db, { limit: 20 });
    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.sources.operations, 1);
    assert.equal(result.sources.adminRoles, 1);
    assert.equal(result.sources.raidRewardProposals, 1);
    assert.deepEqual(
        new Set(result.events.map((event) => event.type)),
        new Set(['operation', 'admin_role', 'raid_reward_proposal'])
    );

    const filtered = await getAdminUnifiedHistory(db, {
        limit: 20,
        type: 'operation',
        query: 'abc123',
    });
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].subject, 'OP-ABC123');
});
