const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    confirmExitAndReset,
    processExpiredExitConfirmations,
} = require('../helpers/clover/communityExitManager');

async function createDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

async function seedExpiredConfirmation(db, playerId = 'player@lid') {
    await db.exec(`
        CREATE TABLE clover_exit_confirmations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            source_group_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'cancelled', 'confirmed', 'expired')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            responded_at TEXT DEFAULT NULL,
            response_text TEXT DEFAULT NULL,
            backup_path TEXT DEFAULT NULL
        );
    `);

    const inserted = await db.run(
        `INSERT INTO clover_exit_confirmations
         (player_id, status, expires_at)
         VALUES (?, 'pending', datetime('now', '-1 minute'))`,
        [playerId]
    );
    return inserted.lastID;
}

test('duas varreduras concorrentes resetam a mesma saída apenas uma vez', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedExpiredConfirmation(db);

    let resetCalls = 0;
    const archiveAndResetPlayerFn = async () => {
        resetCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, backupPath: 'backups/player-reset/test.sqlite' };
    };

    const [first, second] = await Promise.all([
        processExpiredExitConfirmations({ db, sock: null, archiveAndResetPlayerFn }),
        processExpiredExitConfirmations({ db, sock: null, archiveAndResetPlayerFn }),
    ]);

    assert.equal(resetCalls, 1);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(
        [...first, ...second].filter((entry) => entry.skipped).length,
        1
    );

    const confirmation = await db.get(
        `SELECT status, backup_path
         FROM clover_exit_confirmations
         LIMIT 1`
    );
    assert.equal(confirmation.status, 'expired');
    assert.equal(confirmation.backup_path, 'backups/player-reset/test.sqlite');
});

test('falha no reset devolve a confirmação para pending', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpiredConfirmation(db);

    await assert.rejects(
        confirmExitAndReset({
            db,
            sock: null,
            playerId: 'player@lid',
            confirmationId,
            status: 'expired',
            responseText: 'expired',
            archiveAndResetPlayerFn: async () => {
                throw new Error('falha simulada');
            },
        }),
        /falha simulada/
    );

    const confirmation = await db.get(
        `SELECT status, responded_at, backup_path
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.equal(confirmation.status, 'pending');
    assert.equal(confirmation.responded_at, null);
    assert.equal(confirmation.backup_path, null);
});

test('uma confirmação já reivindicada não cria outro backup', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const confirmationId = await seedExpiredConfirmation(db);

    await db.run(
        `UPDATE clover_exit_confirmations
         SET status = 'expired'
         WHERE id = ?`,
        [confirmationId]
    );

    let resetCalls = 0;
    const result = await confirmExitAndReset({
        db,
        sock: null,
        playerId: 'player@lid',
        confirmationId,
        status: 'expired',
        responseText: 'expired',
        archiveAndResetPlayerFn: async () => {
            resetCalls += 1;
            return { ok: true, backupPath: 'should-not-exist.sqlite' };
        },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already_claimed');
    assert.equal(resetCalls, 0);
});
