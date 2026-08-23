'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    CLASSIFICATION,
    applyPlan,
    assertApplyTarget,
    buildPlan,
    main,
    redactedPlan,
} = require('../scripts/planSquadPolicyRepair');

async function fixture() {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clover-squad-policy-repair-'));
    const filename = path.join(dir, 'clover-f3-disposable-policy-repair-fixture.sqlite');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            esquadrao TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado'
        );
        CREATE TABLE clover_squads (squad_key TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ended_at TEXT DEFAULT NULL,
            changed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_squad_membership_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            membership_id INTEGER DEFAULT NULL,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('added', 'removed', 'transferred')),
            performed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_player_lifecycle_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await db.run("INSERT INTO clover_squads (squad_key, name) VALUES ('black_bulls', 'Black Bulls')");
    return { db, dir, filename };
}

async function closeFixture(value) {
    await value.db.close();
    await fs.promises.rm(value.dir, { recursive: true, force: true });
}

async function seedExpectedCandidates(db) {
    await db.run("INSERT INTO jogadores VALUES ('archive@lid', '-', 'archived', 'aprovada', 'arquivado')");
    const membership = await db.run(
        `INSERT INTO clover_squad_memberships
         (squad_key, player_id, status, joined_at, changed_by, reason)
         VALUES ('black_bulls', 'archive@lid', 'active', '2026-08-01 00:00:00', 'captain@lid', 'join')`
    );
    await db.run(
        `INSERT INTO clover_squad_membership_events
         (membership_id, squad_key, player_id, action, performed_by, reason, created_at)
         VALUES (?, 'black_bulls', 'archive@lid', 'added', 'captain@lid', 'join', '2026-08-01 00:00:00')`,
        [membership.lastID]
    );
    await db.run("INSERT INTO clover_player_lifecycle_events (player_id, operation_type, created_at) VALUES ('archive@lid', 'archive', '2026-08-02 00:00:00')");
    await db.run("INSERT INTO jogadores VALUES ('legacy@lid', 'Black Bulls', 'active', 'aprovada', 'liberado')");
}

test('classifies archive and grandfather candidates from policy preconditions', async () => {
    const value = await fixture();
    try {
        await seedExpectedCandidates(value.db);
        const plan = await buildPlan(value.db);
        assert.equal(plan.aggregate.archive_end_membership, 1);
        assert.equal(plan.aggregate.legacy_grandfather, 1);
        assert.equal(plan.aggregate.safe_actions_total, 2);
        assert.deepEqual(plan.actions.map((item) => item.classification).sort(), [
            CLASSIFICATION.ARCHIVE_END_MEMBERSHIP,
            CLASSIFICATION.LEGACY_GRANDFATHER,
        ]);
    } finally { await closeFixture(value); }
});

test('apply changes only safe candidates, preserves legacy projection, and is idempotent', async () => {
    const value = await fixture();
    try {
        await seedExpectedCandidates(value.db);
        const first = await applyPlan(value.db);
        assert.equal(first.applied.length, 2);
        const archived = await value.db.get("SELECT status, ended_at, changed_by FROM clover_squad_memberships WHERE player_id = 'archive@lid'");
        assert.equal(archived.status, 'archived');
        assert.ok(archived.ended_at);
        assert.equal(archived.changed_by, 'system:phase3-f3f1');
        const grandfathered = await value.db.get("SELECT * FROM clover_squad_memberships WHERE player_id = 'legacy@lid' AND status = 'active'");
        assert.equal(grandfathered.squad_key, 'black_bulls');
        assert.match(grandfathered.metadata_json, /phase3_legacy_grandfather/);
        assert.equal((await value.db.get("SELECT esquadrao FROM jogadores WHERE id = 'legacy@lid'")).esquadrao, 'Black Bulls');
        assert.equal((await value.db.get("SELECT COUNT(*) AS total FROM clover_squad_membership_events WHERE player_id IN ('archive@lid', 'legacy@lid') AND action IN ('added', 'removed')")).total, 3);
        const second = await applyPlan(value.db);
        assert.equal(second.applied.length, 0);
        assert.equal(second.plan.aggregate.safe_actions_total, 0);
    } finally { await closeFixture(value); }
});

test('grandfather precondition failures stay manual and invalid legacy Squad is blocked', async () => {
    const value = await fixture();
    try {
        await value.db.exec(`
            INSERT INTO jogadores VALUES ('archived@lid', 'Black Bulls', 'archived', 'aprovada', 'liberado');
            INSERT INTO jogadores VALUES ('unapproved@lid', 'Black Bulls', 'active', 'pending', 'liberado');
            INSERT INTO jogadores VALUES ('blocked@lid', 'Unknown Squad', 'active', 'aprovada', 'liberado');
            INSERT INTO jogadores VALUES ('departed@lid', 'Black Bulls', 'active', 'aprovada', 'liberado');
            INSERT INTO clover_squad_memberships (squad_key, player_id, status, changed_by) VALUES ('black_bulls', 'departed@lid', 'removed', 'captain@lid');
        `);
        const plan = await buildPlan(value.db);
        assert.equal(plan.aggregate.legacy_grandfather, 0);
        assert.equal(plan.aggregate.manual_review, 3);
        assert.equal(plan.aggregate.blocked_invalid_state, 1);
        assert.ok(plan.details.some((item) => item.player_id === 'blocked@lid' && item.classification === CLASSIFICATION.BLOCKED_INVALID_STATE));
    } finally { await closeFixture(value); }
});

test('CLI defaults to dry-run and protected apply requires both confirmations', async () => {
    const value = await fixture();
    try {
        await seedExpectedCandidates(value.db);
        const dry = await main(['--db', value.filename]);
        assert.equal(dry.mode, 'DRY_RUN');
        assert.equal((await value.db.get("SELECT status FROM clover_squad_memberships WHERE player_id = 'archive@lid'")).status, 'active');
        await assert.rejects(main(['--db', value.filename, '--apply']), /both --apply/);
    } finally { await closeFixture(value); }
});

test('protected apply checkpoints its own sidecars and a second apply is a no-op', async () => {
    const value = await fixture();
    try {
        await seedExpectedCandidates(value.db);
        const first = await main(['--db', value.filename, '--apply', '--non-live-copy-confirmed']);
        assert.equal(first.applied_actions, 2);
        assert.equal(fs.existsSync(`${value.filename}-wal`), false);
        assert.equal(fs.existsSync(`${value.filename}-shm`), false);
        const second = await main(['--db', value.filename, '--apply', '--non-live-copy-confirmed']);
        assert.equal(second.applied_actions, 0);
        assert.equal(second.plan.safe_actions_total, 0);
    } finally { await closeFixture(value); }
});

test('live and non-disposable targets are rejected before apply', async () => {
    assert.throws(() => assertApplyTarget(path.resolve(__dirname, '..', 'banco.sqlite')), /live runtime/);
    const value = await fixture();
    try {
        const ordinary = path.join(value.dir, 'ordinary.sqlite');
        await fs.promises.copyFile(value.filename, ordinary);
        assert.throws(() => assertApplyTarget(ordinary), /disposable campaign filename/);
    } finally { await closeFixture(value); }
});

test('redacted planner output contains no player identifier or Squad name', async () => {
    const value = await fixture();
    try {
        await value.db.run("INSERT INTO jogadores VALUES ('sensitive-player-123', 'Black Bulls', 'active', 'aprovada', 'liberado')");
        const output = JSON.stringify(redactedPlan(await buildPlan(value.db)));
        assert.doesNotMatch(output, /sensitive-player|123|black bulls/i);
    } finally { await closeFixture(value); }
});
