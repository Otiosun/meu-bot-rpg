'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, observeCloverDatabaseConnection } = require('../helpers/clover/databaseConnection');
const { checkpointSqliteWal, inspectSqlitePhysicalIntegrity } = require('../helpers/clover/sqlitePhysicalIntegrityService');

function fixture(t, prefix = 'clover-sqlite-physical-') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const filename = path.join(directory, 'physical.sqlite');
    const connections = [];
    t.after(async () => {
        for (const db of connections.reverse()) await db.close().catch(() => {});
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return {
        filename,
        async open(options = {}) {
            const db = await openCloverDatabase({ filename, ...options });
            connections.push(db);
            return db;
        },
    };
}

test('WAL file-backed persiste entre conexoes, readers e reopen sem pressupor arquivos auxiliares', async (t) => {
    const lab = fixture(t, 'clover-wal-reopen-');
    const writer = await lab.open();
    const reader = await lab.open();
    assert.equal((await observeCloverDatabaseConnection(writer)).journalMode, 'wal');
    assert.equal((await observeCloverDatabaseConnection(reader)).journalMode, 'wal');
    await writer.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await writer.run(`INSERT INTO entries (id, value) VALUES (1, 'committed')`);
    assert.deepEqual(await reader.get('SELECT value FROM entries WHERE id = 1'), { value: 'committed' });
    await reader.close();
    const reopened = await lab.open();
    assert.equal((await observeCloverDatabaseConnection(reopened)).journalMode, 'wal');
    assert.deepEqual(await reopened.get('SELECT value FROM entries WHERE id = 1'), { value: 'committed' });
});

test('busy timeout espera write lock real e preserva atomicidade apos liberar writer', async (t) => {
    const lab = fixture(t, 'clover-busy-contention-');
    const a = await lab.open({ busyTimeoutMs: 1_000 });
    const b = await lab.open({ busyTimeoutMs: 1_000 });
    await a.exec('CREATE TABLE contention (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await a.exec('BEGIN IMMEDIATE');
    await a.run(`INSERT INTO contention (id, value) VALUES (1, 'from-a')`);
    const started = Date.now();
    const pending = b.run(`INSERT INTO contention (id, value) VALUES (2, 'from-b')`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await a.exec('COMMIT');
    await pending;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 80, `writer B falhou instantaneamente (${elapsed}ms)`);
    assert.deepEqual(await b.all('SELECT id, value FROM contention ORDER BY id'), [
        { id: 1, value: 'from-a' }, { id: 2, value: 'from-b' },
    ]);
});

test('physical integrity e checkpoint WAL preservam commits file-backed', async (t) => {
    const lab = fixture(t, 'clover-checkpoint-');
    const db = await lab.open();
    await db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));`);
    await db.exec('BEGIN IMMEDIATE');
    await db.run('INSERT INTO parent (id) VALUES (1)');
    await db.run('INSERT INTO child (id, parent_id) VALUES (1, 1)');
    await db.exec('COMMIT');
    const passive = await checkpointSqliteWal(db, 'PASSIVE');
    assert.ok(passive.busy <= 1);
    const truncate = await checkpointSqliteWal(db, 'TRUNCATE');
    assert.ok(truncate.busy <= 1);
    await inspectSqlitePhysicalIntegrity(db);
    assert.deepEqual(await db.get('SELECT parent_id FROM child WHERE id = 1'), { parent_id: 1 });
});
