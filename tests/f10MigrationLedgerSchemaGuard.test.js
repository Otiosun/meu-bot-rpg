'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    computeSchemaFingerprint,
    inspectMigrationLedgerSchemaState,
} = require('../helpers/clover/schemaMigrationService');
const {
    assertDatabaseAtCanonicalMigrationHead,
} = require('../helpers/ci/f10MigrationGate');

function makeTempDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-f10-ledger-guard-'));
    const filename = path.join(dir, 'database.sqlite');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return filename;
}

async function closeQuietly(db) {
    if (db && typeof db.close === 'function') await db.close().catch(() => {});
}

test('ledger divergente não pode se esconder atrás do fingerprint de domínio', async (t) => {
    const filename = makeTempDatabase(t);
    let db;
    let verifyDb;
    try {
        db = await database.criarBanco({ filename });
        const canonical = await assertDatabaseAtCanonicalMigrationHead(db);
        assert.equal(canonical.ledgerSchemaKind, 'exact');
        assert.equal(canonical.appliedCount, 33);
        const canonicalFingerprint = await computeSchemaFingerprint(db);
        await closeQuietly(db);
        db = null;

        verifyDb = await openCloverDatabase({ filename });
        await verifyDb.exec(`
            ALTER TABLE ${MIGRATION_TABLE} RENAME TO ${MIGRATION_TABLE}_old;

            CREATE TABLE ${MIGRATION_TABLE} (
                version INTEGER,
                migration_key TEXT NOT NULL,
                checksum TEXT NOT NULL,
                schema_fingerprint TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );

            INSERT INTO ${MIGRATION_TABLE}
                (version,migration_key,checksum,schema_fingerprint,applied_at,metadata_json)
            SELECT version,migration_key,checksum,schema_fingerprint,applied_at,metadata_json
            FROM ${MIGRATION_TABLE}_old;

            DROP TABLE ${MIGRATION_TABLE}_old;
        `);

        assert.equal((await inspectMigrationLedgerSchemaState(verifyDb)).kind, 'divergent');
        assert.equal((await verifyDb.get(`SELECT COUNT(*) AS total FROM ${MIGRATION_TABLE}`)).total, 33);
        assert.equal(Number(Object.values((await verifyDb.get('PRAGMA user_version')) || {})[0] || 0), 33);
        assert.equal(await computeSchemaFingerprint(verifyDb), canonicalFingerprint);
        await closeQuietly(verifyDb);
        verifyDb = null;

        await assert.rejects(
            () => database.criarBanco({ filename }),
            (error) => error?.code === 'migration_ledger_schema_mismatch'
        );

        verifyDb = await openCloverDatabase({ filename });
        assert.equal((await inspectMigrationLedgerSchemaState(verifyDb)).kind, 'divergent');
        assert.equal((await verifyDb.get(`SELECT COUNT(*) AS total FROM ${MIGRATION_TABLE}`)).total, 33);
        assert.equal(Number(Object.values((await verifyDb.get('PRAGMA user_version')) || {})[0] || 0), 33);
        assert.equal(await computeSchemaFingerprint(verifyDb), canonicalFingerprint);
    } finally {
        await closeQuietly(db);
        await closeQuietly(verifyDb);
    }
});
