'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const legacyDatabase = require('../database/legacy');
const database = require('../database');
const { observeCloverDatabaseConnection, openCloverDatabase } = require('../helpers/clover/databaseConnection');

function temporaryFilename(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-legacy-parity-'));
    const filename = path.join(directory, 'database.sqlite');
    return { directory, filename };
}

function closeAndRemove(t, db, directory) {
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
}

function assertPhysicalContract(observed) {
    assert.equal(observed.journalMode, 'wal');
    assert.equal(observed.busyTimeoutMs, 10_000);
    assert.equal(observed.synchronous, 2);
    assert.equal(observed.foreignKeys, 1);
}

test('abertura legacy aplica o contrato central imediatamente apos open', async (t) => {
    const { directory, filename } = temporaryFilename(t);
    const db = await legacyDatabase.openLegacyDatabaseConnection({ filename });
    closeAndRemove(t, db, directory);
    assertPhysicalContract(await observeCloverDatabaseConnection(db));
});

test('criarBanco legacy usa a abertura central antes do primeiro DDL e remove PRAGMAs duplicados', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');
    const createStart = source.indexOf('async function criarBanco(options = {})');
    const firstDdl = source.indexOf('CREATE TABLE IF NOT EXISTS jogadores', createStart);
    const centralOpen = source.indexOf('await openLegacyDatabaseConnection(options)', createStart);
    assert.ok(centralOpen >= createStart && centralOpen < firstDdl);
    assert.doesNotMatch(source.slice(createStart, firstDdl), /configure\?\.|PRAGMA\s+(?:busy_timeout|journal_mode)/i);
});

test('legacy custom continua recebendo configuracao central como compatibilidade de API', async (t) => {
    const { directory, filename } = temporaryFilename(t);
    let received = null;
    const db = await database.criarBanco({
        filename,
        migrations: [],
        preLegacyMigrations: false,
        createLegacyDatabase: async (options) => {
            received = options;
            return openCloverDatabase(options);
        },
    });
    closeAndRemove(t, db, directory);
    assert.equal(received.filename, filename);
    assertPhysicalContract(await observeCloverDatabaseConnection(db));
});
