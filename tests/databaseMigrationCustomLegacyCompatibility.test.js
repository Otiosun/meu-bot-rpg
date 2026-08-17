'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { criarBanco } = require('../database');
const {
    openCloverDatabase,
    readPragmaScalar,
} = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    columnExists,
} = require('../helpers/clover/schemaMigrationService');

test('custom legacy sem opener preserva baseline-only para fixtures antigas', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-custom-legacy-'));
    const filename = path.join(dir, 'database.sqlite');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const db = await criarBanco({
        createLegacyDatabase: async () => {
            const connection = await openCloverDatabase({ filename });
            await connection.exec('CREATE TABLE legacy_fixture (id INTEGER PRIMARY KEY)');
            return connection;
        },
    });
    t.after(() => db.close());

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 1);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1]);
    assert.equal(await columnExists(db, 'clover_character_stats', 'ph_accumulated'), false);
});
