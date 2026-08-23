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
} = require('../scripts/planSquadMembershipReconciliation');

async function fixture({ players = [], squads = [{ key: 'black-bulls', name: 'Black Bulls' }], memberships = [] } = {}) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clover-squad-reconcile-'));
    const filename = path.join(dir, 'clover-f3-disposable-reconciliation-fixture.sqlite');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`CREATE TABLE jogadores (id TEXT PRIMARY KEY, esquadrao TEXT DEFAULT '-', lifecycle_status TEXT DEFAULT 'active');
        CREATE TABLE clover_squads (squad_key TEXT PRIMARY KEY, name TEXT NOT NULL, captain_player_id TEXT, vice_captain_player_id TEXT);
        CREATE TABLE clover_squad_memberships (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL, squad_key TEXT NOT NULL, status TEXT NOT NULL);`);
    for (const squad of squads) await db.run('INSERT INTO clover_squads (squad_key, name, captain_player_id, vice_captain_player_id) VALUES (?, ?, ?, ?)', [squad.key, squad.name, squad.captain || null, squad.vice || null]);
    for (const player of players) await db.run('INSERT INTO jogadores (id, esquadrao, lifecycle_status) VALUES (?, ?, ?)', [player.id, player.squad ?? '-', player.lifecycle ?? 'active']);
    for (const membership of memberships) await db.run('INSERT INTO clover_squad_memberships (id, player_id, squad_key, status) VALUES (?, ?, ?, ?)', [membership.id, membership.player, membership.key, membership.status]);
    return { db, filename, dir };
}

async function closeFixture(value) { await value.db.close(); await fs.promises.rm(value.dir, { recursive: true, force: true }); }

test('valid canonical-only is a projection-only SAFE_AUTO action', async () => {
    const value = await fixture({ players: [{ id: 'redacted-player', squad: '-' }], memberships: [{ id: 1, player: 'redacted-player', key: 'black-bulls', status: 'active' }] });
    try {
        const plan = await buildPlan(value.db);
        assert.equal(plan.aggregate.safe_actions_total, 1);
        assert.equal(plan.actions[0].classification, CLASSIFICATION.SAFE_AUTO);
        assert.equal(plan.actions[0].operation_type, 'project_canonical_membership_to_legacy');
        assert.equal(plan.actions[0].authority_source, 'clover_squad_memberships.active');
        assert.ok(plan.actions[0].preconditions_verified.exactly_one_active_membership);
    } finally { await closeFixture(value); }
});

test('conflicts, duplicates, and unknown canonical keys are never auto-repaired', async () => {
    const cases = [
        { players: [{ id: 'one', squad: 'Golden Dawn' }], memberships: [{ id: 1, player: 'one', key: 'black-bulls', status: 'active' }] },
        { players: [{ id: 'two', squad: '-' }], memberships: [{ id: 1, player: 'two', key: 'black-bulls', status: 'active' }, { id: 2, player: 'two', key: 'black-bulls', status: 'active' }] },
        { players: [{ id: 'three', squad: '-' }], memberships: [{ id: 1, player: 'three', key: 'unknown', status: 'active' }] },
    ];
    for (const input of cases) {
        const value = await fixture(input);
        try {
            const plan = await buildPlan(value.db);
            assert.equal(plan.aggregate.safe_actions_total, 0);
            assert.equal(plan.details[0].classification, CLASSIFICATION.BLOCKED_INVALID_STATE);
        } finally { await closeFixture(value); }
    }
});

test('legacy-only states stay manual without promotion by inference', async () => {
    const value = await fixture({ players: [{ id: 'legacy-only', squad: 'Black Bulls' }] });
    try {
        const plan = await buildPlan(value.db);
        assert.equal(plan.aggregate.legacy_only_manual, 1);
        assert.equal(plan.aggregate.legacy_only_safe_auto, 0);
        assert.equal(plan.details[0].classification, CLASSIFICATION.MANUAL_REVIEW);
        assert.equal(plan.details[0].reason_code, 'AMBIGUOUS');
    } finally { await closeFixture(value); }
});

test('dry-run does not write; disposable apply updates only the authorized legacy projection and is idempotent', async () => {
    const value = await fixture({ players: [{ id: 'safe', squad: '-' }, { id: 'manual', squad: 'Black Bulls' }], memberships: [{ id: 1, player: 'safe', key: 'black-bulls', status: 'active' }] });
    try {
        const before = await value.db.get('SELECT esquadrao FROM jogadores WHERE id = ?', ['safe']);
        assert.equal(before.esquadrao, '-');
        const dry = await buildPlan(value.db);
        assert.equal(dry.actions.length, 1);
        assert.equal((await value.db.get('SELECT esquadrao FROM jogadores WHERE id = ?', ['safe'])).esquadrao, '-');
        const first = await applyPlan(value.db);
        assert.equal(first.applied.length, 1);
        assert.equal((await value.db.get('SELECT esquadrao FROM jogadores WHERE id = ?', ['safe'])).esquadrao, 'Black Bulls');
        assert.equal((await value.db.get('SELECT esquadrao FROM jogadores WHERE id = ?', ['manual'])).esquadrao, 'Black Bulls');
        assert.equal((await value.db.get('SELECT status FROM clover_squad_memberships WHERE id = 1')).status, 'active');
        const second = await applyPlan(value.db);
        assert.equal(second.applied.length, 0);
        assert.equal(second.plan.aggregate.safe_actions_total, 0);
    } finally { await closeFixture(value); }
});

test('CLI defaults to dry-run and requires two explicit apply confirmations', async () => {
    const value = await fixture({ players: [{ id: 'safe', squad: '-' }], memberships: [{ id: 1, player: 'safe', key: 'black-bulls', status: 'active' }] });
    try {
        const result = await main(['--db', value.filename]);
        assert.equal(result.mode, 'DRY_RUN');
        assert.equal((await value.db.get('SELECT esquadrao FROM jogadores WHERE id = ?', ['safe'])).esquadrao, '-');
        await assert.rejects(main(['--db', value.filename, '--apply']), /both --apply/);
    } finally { await closeFixture(value); }
});

test('protected apply with no safe action stays read-only and leaves no sidecars', async () => {
    const value = await fixture({ players: [{ id: 'manual', squad: 'Black Bulls' }] });
    try {
        const result = await main(['--db', value.filename, '--apply', '--non-live-copy-confirmed']);
        assert.equal(result.applied_actions, 0);
        assert.equal(fs.existsSync(`${value.filename}-wal`), false);
        assert.equal(fs.existsSync(`${value.filename}-shm`), false);
    } finally { await closeFixture(value); }
});

test('live and non-disposable targets are rejected before apply', async () => {
    assert.throws(() => assertApplyTarget(path.resolve(__dirname, '..', 'banco.sqlite')), /live runtime/);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clover-squad-guard-'));
    const ordinary = path.join(dir, 'ordinary.sqlite');
    await fs.promises.writeFile(ordinary, 'not-a-sqlite-file');
    try { assert.throws(() => assertApplyTarget(ordinary), /disposable campaign filename/); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
});

test('aggregate evidence contains no raw identifiers', async () => {
    const value = await fixture({ players: [{ id: 'sensitive-jid-12345', squad: '-' }], memberships: [{ id: 1, player: 'sensitive-jid-12345', key: 'black-bulls', status: 'active' }] });
    try {
        const output = JSON.stringify(redactedPlan(await buildPlan(value.db)));
        assert.doesNotMatch(output, /sensitive-jid|12345/);
        assert.doesNotMatch(output, /black bulls/i);
    } finally { await closeFixture(value); }
});

test('CLI aggregate does not expose identifiers from the divergence auditor', async () => {
    const value = await fixture({ players: [{ id: 'sensitive-jid-67890', squad: '-' }], memberships: [{ id: 1, player: 'sensitive-jid-67890', key: 'black-bulls', status: 'active' }] });
    try {
        const output = JSON.stringify(await main(['--db', value.filename]));
        assert.doesNotMatch(output, /sensitive-jid|67890/);
        assert.doesNotMatch(output, /black bulls/i);
    } finally { await closeFixture(value); }
});
