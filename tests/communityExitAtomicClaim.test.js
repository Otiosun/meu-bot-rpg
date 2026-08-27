const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    confirmExitAndReset,
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

test('duas varreduras concorrentes expiram a saída sem arquivar ou resetar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpired(db);

    const [first, second] = await Promise.all([
        processExpiredExitConfirmations({ sock: null, db }),
        processExpiredExitConfirmations({ sock: null, db }),
    ]);

    const processed = [...first, ...second];
    const safeExpiry = processed.filter(
        (item) => item.reason === 'community_exit_expired_no_action'
    );
    assert.equal(safeExpiry.length, 1);
    assert.equal(safeExpiry[0].skipped, true);
    assert.equal(safeExpiry[0].backupPath, null);

    const row = await db.get(
        `SELECT status, response_text, backup_path, processing_token, processing_started_at, last_error
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.equal(row.status, 'expired');
    assert.equal(row.response_text, 'expired');
    assert.equal(row.backup_path, null);
    assert.equal(row.processing_token, null);
    assert.equal(row.processing_started_at, null);
    assert.equal(row.last_error, null);
});

test('saída expirada é terminal e não volta para fila destrutiva', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpired(db);

    const first = await processExpiredExitConfirmations({ sock: null, db });
    assert.equal(first.length, 1);
    assert.equal(first[0].reason, 'community_exit_expired_no_action');
    assert.equal(first[0].skipped, true);

    const second = await processExpiredExitConfirmations({ sock: null, db });
    assert.deepEqual(second, []);

    const row = await db.get(
        `SELECT status, backup_path, last_error
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.deepEqual(row, {
        status: 'expired',
        backup_path: null,
        last_error: null,
    });
});

test('SIM explícito do player falha fechado e exige ação administrativa', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpired(db, 'confirmed@lid');

    await assert.rejects(
        () => confirmExitAndReset({
            sock: null,
            db,
            playerId: 'confirmed@lid',
            confirmationId,
            status: 'confirmed',
            responseText: 'sim',
        }),
        (error) => {
            assert.equal(error.code, 'manual_staff_lifecycle_required');
            assert.match(error.message, /ação administrativa explícita/i);
            return true;
        }
    );

    const row = await db.get(
        `SELECT status, response_text, backup_path, processing_token, processing_started_at, last_error
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.equal(row.status, 'pending');
    assert.equal(row.response_text, null);
    assert.equal(row.backup_path, null);
    assert.equal(row.processing_token, null);
    assert.equal(row.processing_started_at, null);
    assert.match(row.last_error, /ação administrativa explícita/i);
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
