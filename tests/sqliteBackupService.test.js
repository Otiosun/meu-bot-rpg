'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    backupSqliteDatabase,
    loadNativeSqliteBackup,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

function removeDirectory(directory) {
    fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
    });
}

async function closeQuietly(db) {
    if (!db) return;
    try {
        await db.close();
    } catch (error) {
        if (!/closed|not open/i.test(String(error?.message || error))) throw error;
    }
}

test('cria snapshot íntegro com node:sqlite.backup sem alterar a origem', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-sqlite-backup-'));
    const sourcePath = path.join(directory, 'source.sqlite');
    const destinationPath = path.join(directory, 'snapshot.sqlite');
    let source = null;
    let snapshot = null;

    t.after(async () => {
        await closeQuietly(snapshot);
        await closeQuietly(source);
        removeDirectory(directory);
    });

    assert.ok(loadNativeSqliteBackup(), 'node:sqlite.backup precisa estar disponível neste Node.');

    source = await open({
        filename: sourcePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
    });
    await source.exec('PRAGMA journal_mode = WAL');
    await source.exec('CREATE TABLE audit_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await source.run('INSERT INTO audit_fixture (value) VALUES (?)', ['antes do backup']);

    const backup = await backupSqliteDatabase(sourcePath, destinationPath);
    assert.equal(backup.method, 'node:sqlite.backup');
    assert.equal(backup.integrity, 'ok');
    assert.ok(backup.bytes > 0);

    await source.run('INSERT INTO audit_fixture (value) VALUES (?)', ['depois do backup']);
    await source.close();
    source = null;

    snapshot = await open({
        filename: destinationPath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    const rows = await snapshot.all('SELECT value FROM audit_fixture ORDER BY id');
    assert.deepEqual(rows, [{ value: 'antes do backup' }]);

    await snapshot.close();
    snapshot = null;

    const verification = await verifySqliteDatabase(destinationPath);
    assert.equal(verification.ok, true);
    assert.equal(verification.integrity, 'ok');
});

test('recusa usar o mesmo caminho como origem e destino', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-sqlite-backup-same-'));
    const sourcePath = path.join(directory, 'source.sqlite');
    fs.writeFileSync(sourcePath, 'placeholder');
    try {
        await assert.rejects(
            backupSqliteDatabase(sourcePath, sourcePath),
            /Origem e destino do backup não podem ser iguais/
        );
    } finally {
        removeDirectory(directory);
    }
});
