'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const {
    backupSqliteDatabase,
    restoreSqliteBackupToNewPath,
    sha256File,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');
const { assertDatabaseAtCanonicalMigrationHead } = require('../helpers/ci/f10MigrationGate');

function makeTempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-f10-restore-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function closeQuietly(db) {
    if (db && typeof db.close === 'function') await db.close().catch(() => {});
}

function assertSha256(value) {
    assert.match(value, /^[a-f0-9]{64}$/);
}

test('backup canônico restaura para novo arquivo, preserva hash/snapshot e volta a subir até o head de migrations', async (t) => {
    const dir = makeTempDir(t);
    const sourcePath = path.join(dir, 'source.sqlite');
    const backupPath = path.join(dir, 'backup.sqlite');
    const restoredPath = path.join(dir, 'restored.sqlite');
    const sentinelId = 'f10-restore-sentinel@s.whatsapp.net';

    let sourceDb;
    let restoredDb;
    try {
        sourceDb = await database.criarBanco({ filename: sourcePath });
        await assertDatabaseAtCanonicalMigrationHead(sourceDb);
        await sourceDb.run(
            'INSERT INTO jogadores (id, nome, dinheiro, raca) VALUES (?, ?, ?, ?)',
            [sentinelId, 'Restore Sentinel', 321, 'Humano']
        );
        await closeQuietly(sourceDb);
        sourceDb = null;

        const backup = await backupSqliteDatabase(sourcePath, backupPath);
        assert.equal(backup.integrity, 'ok');
        assert.ok(backup.bytes > 0);
        assertSha256(backup.sha256);
        assert.equal(backup.sha256, sha256File(backupPath));
        assert.equal(
            fs.readdirSync(dir).some((name) => name.includes('.backup.sqlite.creating-')),
            false,
            'staging de backup não pode sobreviver ao sucesso'
        );

        sourceDb = await database.criarBanco({ filename: sourcePath });
        await sourceDb.run('UPDATE jogadores SET dinheiro = 999 WHERE id = ?', [sentinelId]);
        await closeQuietly(sourceDb);
        sourceDb = null;

        const restored = await restoreSqliteBackupToNewPath(backupPath, restoredPath);
        assert.equal(restored.integrity, 'ok');
        assert.equal(restored.bytes, backup.bytes);
        assertSha256(restored.sha256);
        assert.equal(restored.sourceSha256, backup.sha256);
        assert.equal(restored.sha256, backup.sha256);
        assert.equal(restored.sha256, sha256File(restoredPath));

        const verification = await verifySqliteDatabase(restoredPath);
        assert.equal(verification.ok, true);

        restoredDb = await database.criarBanco({ filename: restoredPath });
        await assertDatabaseAtCanonicalMigrationHead(restoredDb);
        const row = await restoredDb.get('SELECT id, nome, dinheiro, raca FROM jogadores WHERE id = ?', [sentinelId]);
        assert.deepEqual(row, {
            id: sentinelId,
            nome: 'Restore Sentinel',
            dinheiro: 321,
            raca: 'Humano',
        });
    } finally {
        await closeQuietly(sourceDb);
        await closeQuietly(restoredDb);
    }
});

test('backup fail-closed: destino existente nunca é apagado ou sobrescrito', async (t) => {
    const dir = makeTempDir(t);
    const sourcePath = path.join(dir, 'source.sqlite');
    const destinationPath = path.join(dir, 'known-good-backup.sqlite');
    const preserved = Buffer.from('KNOWN_GOOD_BACKUP_MUST_SURVIVE');
    let db;
    try {
        db = await database.criarBanco({ filename: sourcePath });
        await closeQuietly(db);
        db = null;
        fs.writeFileSync(destinationPath, preserved);

        await assert.rejects(
            backupSqliteDatabase(sourcePath, destinationPath),
            (error) => error?.code === 'backup_destination_exists'
        );
        assert.deepEqual(fs.readFileSync(destinationPath), preserved);
    } finally {
        await closeQuietly(db);
    }
});

test('restore fail-closed: não sobrescreve destino existente e recusa origem=destino', async (t) => {
    const dir = makeTempDir(t);
    const backupPath = path.join(dir, 'backup.sqlite');
    const destinationPath = path.join(dir, 'destination.sqlite');
    fs.writeFileSync(backupPath, 'not-a-db');
    fs.writeFileSync(destinationPath, 'existing');

    await assert.rejects(
        restoreSqliteBackupToNewPath(backupPath, destinationPath),
        /Destino de restore já existe/
    );
    await assert.rejects(
        restoreSqliteBackupToNewPath(backupPath, backupPath),
        /Origem e destino do restore não podem ser iguais/
    );
});

test('restore de backup corrompido falha antes da promoção e não deixa destino residual', async (t) => {
    const dir = makeTempDir(t);
    const corruptBackupPath = path.join(dir, 'corrupt-backup.sqlite');
    const destinationPath = path.join(dir, 'must-not-survive.sqlite');
    fs.writeFileSync(corruptBackupPath, 'definitely-not-sqlite');

    await assert.rejects(
        restoreSqliteBackupToNewPath(corruptBackupPath, destinationPath)
    );
    assert.equal(fs.existsSync(destinationPath), false);
});
