'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    DEFAULT_BUSY_TIMEOUT_MS,
    SYNCHRONOUS_VALUES,
    configureCloverDatabaseConnection,
    observeCloverDatabaseConnection,
    openCloverDatabase,
} = require('../helpers/clover/databaseConnection');

function temporaryDatabase(t, prefix = 'clover-sqlite-contract-') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const filename = path.join(directory, 'database.sqlite');
    return filename;
}

function closeAndRemove(t, db, filename) {
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });
}

test('contrato fisico observavel confirma o driver SQLite real em arquivo', async (t) => {
    const filename = temporaryDatabase(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);
    const observed = await observeCloverDatabaseConnection(db);

    assert.match(observed.sqliteVersion, /^\d+\.\d+\.\d+/);
    assert.equal(observed.journalMode, 'wal');
    assert.equal(observed.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS);
    assert.equal(observed.synchronous, SYNCHRONOUS_VALUES.FULL);
    assert.equal(observed.foreignKeys, 1);
    assert.ok(Number.isInteger(observed.walAutocheckpoint) && observed.walAutocheckpoint >= 0);
});

test('WAL com readback obrigatorio nao invalida banco em memoria', async (t) => {
    const db = await openCloverDatabase({ filename: ':memory:' });
    t.after(() => db.close());
    const observed = await observeCloverDatabaseConnection(db);
    assert.notEqual(observed.journalMode, '');
    assert.equal(observed.foreignKeys, 1);
});

test('configuracao fisica nao cria nem altera objetos de schema', async (t) => {
    const filename = temporaryDatabase(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);
    const before = await db.all(`SELECT type, name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`);
    await configureCloverDatabaseConnection(db, { filename: 'contract.sqlite' });
    const after = await db.all(`SELECT type, name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`);
    assert.deepEqual(after, before);
});
