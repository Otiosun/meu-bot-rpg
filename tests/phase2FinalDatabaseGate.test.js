'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { observeCloverDatabaseConnection } = require('../helpers/clover/databaseConnection');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationCatalog');
const {
    computeSchemaFingerprint,
    inspectCloverMigrationState,
} = require('../helpers/clover/schemaMigrationService');
const { assertSqliteOwnership } = require('../helpers/clover/sqliteOwnershipAudit');

function temporaryFilename(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase2-final-gate-'));
    const filename = path.join(directory, 'database.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return filename;
}

async function startup(filename) {
    const db = await database.criarBanco({ filename });
    const observed = await observeCloverDatabaseConnection(db);
    const state = await inspectCloverMigrationState(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    const fingerprint = await computeSchemaFingerprint(db);
    return { db, observed, state, fingerprint };
}

async function assertPhysicalIntegrity(db) {
    const quick = await db.get('PRAGMA quick_check');
    const integrity = await db.get('PRAGMA integrity_check');
    assert.equal(Object.values(quick)[0], 'ok');
    assert.equal(Object.values(integrity)[0], 'ok');
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    await db.all('PRAGMA wal_checkpoint(PASSIVE)');
}

test('gate final: fresh, repeticao e fixture legada preservam schema, ledger e dados', async (t) => {
    const filename = temporaryFilename(t);
    const first = await startup(filename);
    try {
        assert.equal(first.observed.journalMode, 'wal');
        assert.equal(first.observed.busyTimeoutMs, 10_000);
        assert.equal(first.observed.foreignKeys, 1);
        assert.equal(first.state.userVersion, 28);
        assert.equal(first.state.applied.length, CURRENT_SCHEMA_MIGRATIONS.length);
        assert.equal(first.state.schemaFingerprintMatchesLatest, true);
        await assertPhysicalIntegrity(first.db);

        await first.db.run('INSERT INTO jogadores (id, nome, dinheiro) VALUES (?, ?, ?)', ['player-final', 'Final Gate', 77]);
        await first.db.run('INSERT INTO player_progress (player_id, ph_total, ph_bonus) VALUES (?, ?, ?)', ['player-final', 12, 3]);
        await first.db.run(`
            INSERT INTO clover_raids (raid_key, name, owner_player_id, status, scope_type, counts_monthly)
            VALUES (?, ?, ?, ?, ?, ?)
        `, ['final-gate-raid', 'Final gate raid', 'player-final', 'lobby', 'global', 0]);
    } finally {
        await first.db.close();
    }

    const second = await startup(filename);
    try {
        assert.equal(second.fingerprint, first.fingerprint);
        assert.deepEqual(
            await second.db.get('SELECT nome, dinheiro FROM jogadores WHERE id = ?', ['player-final']),
            { nome: 'Final Gate', dinheiro: 77 },
        );
        assert.deepEqual(
            await second.db.get('SELECT ph_total, ph_bonus FROM player_progress WHERE player_id = ?', ['player-final']),
            { ph_total: 12, ph_bonus: 3 },
        );
        assert.equal((await second.db.get('SELECT COUNT(*) AS count FROM clover_raids WHERE raid_key = ?', ['final-gate-raid'])).count, 1);
    } finally {
        await second.db.close();
    }

    const third = await startup(filename);
    try {
        assert.equal(third.fingerprint, first.fingerprint);
        assert.equal(third.state.userVersion, 28);
        assert.equal(third.state.applied.at(-1).migration_key, '0028_raid_reward_proposal_idempotency');
        assert.equal((await third.db.get('SELECT COUNT(*) AS count FROM jogadores WHERE id = ?', ['player-final'])).count, 1);
        assert.equal((await third.db.get('SELECT COUNT(*) AS count FROM player_progress WHERE player_id = ?', ['player-final'])).count, 1);
        assert.equal((await third.db.get('SELECT COUNT(*) AS count FROM clover_raids WHERE raid_key = ?', ['final-gate-raid'])).count, 1);
        await assertPhysicalIntegrity(third.db);
    } finally {
        await third.db.close();
    }
});

test('gate final: ownership do runtime continua deterministico e fail-closed', () => {
    const audit = assertSqliteOwnership(path.join(__dirname, '..'));
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.blockers, []);
});
