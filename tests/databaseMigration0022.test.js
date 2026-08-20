'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    columnExists,
    tableExists,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    RAID_PARTICIPANT_FINALIZATION_INDEX,
    RAID_PARTICIPANT_FINALIZATION_KEY,
    RAID_PARTICIPANT_FINALIZATION_MIGRATION,
    RAID_PARTICIPANT_FINALIZATION_STORED_STATUSES,
    RAID_PARTICIPANT_FINALIZATION_TARGETS,
    RAID_PARTICIPANT_FINALIZATION_VERSION,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0022-raid-finalization-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function createParticipantBase(db, options = {}) {
    const withFinalization = options.withFinalization === true;
    const finalizationColumns = withFinalization
        ? ",\n            finalization_status TEXT NOT NULL DEFAULT 'pending',\n            finalization_note TEXT DEFAULT NULL,\n            finalized_by TEXT DEFAULT NULL,\n            finalized_at TEXT DEFAULT NULL"
        : '';
    await db.exec(`
        CREATE TABLE clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'joined',
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP${finalizationColumns}
        )
    `);
}

async function run0022(db) {
    return runCloverSchemaMigrations(db, {
        migrations: [RAID_PARTICIPANT_FINALIZATION_MIGRATION],
    });
}

async function ledgerVersions(db) {
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

async function indexColumns(db) {
    const rows = await db.all('PRAGMA index_info(idx_clover_raid_participant_finalization)');
    return rows
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((row) => row.name);
}

test('0022 possui exatamente quatro targets de finalizacao, quatro status armazenados e o indice runtime exato', () => {
    assert.equal(RAID_PARTICIPANT_FINALIZATION_VERSION, 22);
    assert.equal(RAID_PARTICIPANT_FINALIZATION_KEY, '0022_raid_participant_finalization');
    assert.deepEqual(RAID_PARTICIPANT_FINALIZATION_STORED_STATUSES, [
        'pending', 'eligible', 'absent', 'ineligible',
    ]);
    assert.equal(RAID_PARTICIPANT_FINALIZATION_TARGETS.length, 4);
    assert.deepEqual(
        RAID_PARTICIPANT_FINALIZATION_TARGETS.map((target) => [
            target.table, target.column, target.definition,
        ]),
        [
            ['clover_raid_participants', 'finalization_status', "TEXT NOT NULL DEFAULT 'pending'"],
            ['clover_raid_participants', 'finalization_note', 'TEXT DEFAULT NULL'],
            ['clover_raid_participants', 'finalized_by', 'TEXT DEFAULT NULL'],
            ['clover_raid_participants', 'finalized_at', 'TEXT DEFAULT NULL'],
        ]
    );
    assert.deepEqual(RAID_PARTICIPANT_FINALIZATION_INDEX, {
        name: 'idx_clover_raid_participant_finalization',
        table: 'clover_raid_participants',
        columns: ['raid_id', 'finalization_status', 'status', 'id'],
    });
    for (const forbidden of [
        'clover_raid_rewards.resource_key',
        'clover_raid_monthly_reservations.scope_key',
        'clover_raid_monthly_ledger.entry_key',
    ]) {
        assert.equal(
            RAID_PARTICIPANT_FINALIZATION_TARGETS
                .map((target) => `${target.table}.${target.column}`)
                .includes(forbidden),
            false,
            forbidden
        );
    }
});

test('0022 adiciona as quatro colunas com pending para legado e cria apenas o indice de finalizacao', async (t) => {
    const db = await openTestDatabase(t);
    await createParticipantBase(db);
    const inserted = await db.run(
        `INSERT INTO clover_raid_participants (raid_id, player_id, status)
         VALUES (7, 'legacy-player', 'completed')`
    );

    const result = await run0022(db);
    assert.equal(result.latestVersion, 22);
    assert.equal(result.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 22);
    assert.deepEqual(await ledgerVersions(db), [22]);

    for (const target of RAID_PARTICIPANT_FINALIZATION_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, target.column);
    }

    const row = await db.get(
        `SELECT finalization_status, finalization_note, finalized_by, finalized_at
         FROM clover_raid_participants WHERE id = ?`,
        [inserted.lastID]
    );
    assert.deepEqual(row, {
        finalization_status: 'pending',
        finalization_note: null,
        finalized_by: null,
        finalized_at: null,
    });
    assert.deepEqual(await indexColumns(db), ['raid_id', 'finalization_status', 'status', 'id']);
    assert.equal(await tableExists(db, 'clover_raid_rewards'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_ledger'), false);
});

test('0022 preserva completed+pending: compatibilidade eligible_legacy continua responsabilidade do runtime', async (t) => {
    const db = await openTestDatabase(t);
    await createParticipantBase(db, { withFinalization: true });
    const inserted = await db.run(
        `INSERT INTO clover_raid_participants
         (raid_id, player_id, status, finalization_status, finalization_note, finalized_by, finalized_at)
         VALUES (3, 'legacy-completed', 'completed', 'pending', NULL, NULL, NULL)`
    );
    const before = await db.get(
        'SELECT * FROM clover_raid_participants WHERE id = ?',
        [inserted.lastID]
    );

    await run0022(db);

    const after = await db.get(
        'SELECT * FROM clover_raid_participants WHERE id = ?',
        [inserted.lastID]
    );
    assert.deepEqual(after, before);
    assert.equal(after.finalization_status, 'pending');
    assert.deepEqual(await indexColumns(db), ['raid_id', 'finalization_status', 'status', 'id']);
});

test('0022 preserva integralmente estados validos ja revisados e nao normaliza dados', async (t) => {
    const db = await openTestDatabase(t);
    await createParticipantBase(db, { withFinalization: true });
    await db.exec(`
        INSERT INTO clover_raid_participants
        (raid_id, player_id, status, finalization_status, finalization_note, finalized_by, finalized_at)
        VALUES
          (8, 'p1', 'completed', 'eligible', NULL, 'host', '2026-07-25 12:00:00'),
          (8, 'p2', 'completed', 'absent', 'Ausente.', 'host', '2026-07-25 12:01:00'),
          (8, 'p3', 'completed', 'ineligible', 'Nao cumpriu.', 'host', '2026-07-25 12:02:00'),
          (8, 'p4', 'removed', 'pending', NULL, NULL, NULL)
    `);
    const before = await db.all('SELECT * FROM clover_raid_participants ORDER BY id');

    await run0022(db);

    const after = await db.all('SELECT * FROM clover_raid_participants ORDER BY id');
    assert.deepEqual(after, before);
});

test('0022 aceita forma armazenada que o runtime consegue normalizar sem reescreve-la', async (t) => {
    const db = await openTestDatabase(t);
    await createParticipantBase(db, { withFinalization: true });
    await db.run(
        `INSERT INTO clover_raid_participants
         (raid_id, player_id, status, finalization_status)
         VALUES (9, 'case-player', 'active', ' Eligible ')`
    );

    await run0022(db);

    const row = await db.get(
        'SELECT finalization_status FROM clover_raid_participants WHERE player_id = ?',
        ['case-player']
    );
    assert.equal(row.finalization_status, ' Eligible ');
});

test('0022 falha fechado para status sem mapeamento e reverte colunas adicionadas na mesma migration', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'joined',
            finalization_status TEXT NOT NULL DEFAULT 'pending'
        )
    `);
    await db.run(
        `INSERT INTO clover_raid_participants
         (raid_id, player_id, status, finalization_status)
         VALUES (10, 'bad-player', 'active', 'misterioso')`
    );

    await assert.rejects(
        run0022(db),
        (error) => error?.code === 'raid_finalization_state_mapping_required'
            && error?.participantId === 1
            && error?.observedStatus === 'misterioso'
    );

    assert.equal(await columnExists(db, 'clover_raid_participants', 'finalization_status'), true);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'finalization_note'), false);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'finalized_by'), false);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'finalized_at'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
    assert.equal(
        await db.get(
            "SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND name='idx_clover_raid_participant_finalization'"
        ),
        undefined
    );
});

test('0022 falha fechado para coluna preexistente com forma incompatível', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'joined',
            finalization_status TEXT DEFAULT 'pending'
        )
    `);

    await assert.rejects(
        run0022(db),
        (error) => error?.code === 'raid_finalization_schema_mapping_required'
            && error?.column === 'finalization_status'
    );

    assert.equal(await columnExists(db, 'clover_raid_participants', 'finalization_note'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0022 detecta indice homonimo com colunas erradas e reverte sem substituir silenciosamente', async (t) => {
    const db = await openTestDatabase(t);
    await createParticipantBase(db, { withFinalization: true });
    await db.exec(`
        CREATE INDEX idx_clover_raid_participant_finalization
        ON clover_raid_participants (raid_id, status)
    `);

    await assert.rejects(
        run0022(db),
        (error) => error?.code === 'raid_finalization_index_mapping_required'
            && Array.isArray(error?.observedColumns)
    );

    assert.deepEqual(await indexColumns(db), ['raid_id', 'status']);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});
