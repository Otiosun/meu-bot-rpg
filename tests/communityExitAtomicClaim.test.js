const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureExitConfirmationSchema,
    processExpiredExitConfirmations,
} = require('../helpers/clover/communityExitManager');
const { prunePlayerResetBackups } = require('../helpers/clover/playerReset');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureExitConfirmationSchema(db);
    return db;
}

async function seedExpired(db, playerId = 'player@lid') {
    const result = await db.run(
        `INSERT INTO clover_exit_confirmations
         (player_id, status, expires_at)
         VALUES (?, 'pending', datetime('now', '-1 minute'))`,
        [playerId]
    );
    return result.lastID;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('duas varreduras concorrentes arquivam a saída expirada uma única vez', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpired(db);
    let archiveCalls = 0;

    const archivePlayerFn = async () => {
        archiveCalls += 1;
        await delay(40);
        return { ok: true, backupPath: 'backup-unico.sqlite' };
    };

    const [first, second] = await Promise.all([
        processExpiredExitConfirmations({ sock: null, db, archivePlayerFn }),
        processExpiredExitConfirmations({ sock: null, db, archivePlayerFn }),
    ]);

    assert.equal(archiveCalls, 1);
    assert.equal([...first, ...second].filter((item) => item.ok).length, 1);

    const row = await db.get(
        `SELECT status, backup_path, processing_token, processing_started_at, last_error
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.equal(row.status, 'expired');
    assert.equal(row.backup_path, 'backup-unico.sqlite');
    assert.equal(row.processing_token, null);
    assert.equal(row.processing_started_at, null);
    assert.equal(row.last_error, null);
});

test('falha libera a reivindicação para uma nova tentativa', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpired(db);

    const failed = await processExpiredExitConfirmations({
        sock: null,
        db,
        archivePlayerFn: async () => {
            throw new Error('falha simulada');
        },
    });
    assert.equal(failed[0].ok, false);

    const afterFailure = await db.get(
        `SELECT status, processing_token, processing_started_at, last_error
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.equal(afterFailure.status, 'pending');
    assert.equal(afterFailure.processing_token, null);
    assert.equal(afterFailure.processing_started_at, null);
    assert.match(afterFailure.last_error, /falha simulada/);

    const retried = await processExpiredExitConfirmations({
        sock: null,
        db,
        archivePlayerFn: async () => ({ ok: true, backupPath: 'retry.sqlite' }),
    });
    assert.equal(retried[0].ok, true);
    assert.equal((await db.get('SELECT status FROM clover_exit_confirmations WHERE id = ?', [confirmationId])).status, 'expired');
});

test('retenção mantém somente os backups mais recentes de cada operação e jogador', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-player-reset-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const now = Date.now();
    for (let index = 0; index < 8; index += 1) {
        const stamp = `2026-07-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`;
        const filePath = path.join(root, `${stamp}-community-exit-expired-player@lid.sqlite`);
        fs.writeFileSync(filePath, `backup-${index}`);
        const time = new Date(now - index * 1000);
        fs.utimesSync(filePath, time, time);
    }

    const result = prunePlayerResetBackups(root, {
        keepPerKey: 5,
        maxAgeDays: 365,
        nowMs: now,
    });

    const remaining = fs.readdirSync(root).filter((name) => name.endsWith('.sqlite'));
    assert.equal(result.removed.length, 3);
    assert.equal(remaining.length, 5);
});
