const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    createOrRefreshExitConfirmation,
    ensureExitConfirmationSchema,
    handleExitConfirmationReply,
    processExpiredExitConfirmations,
} = require('../helpers/clover/communityExitManager');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureExitConfirmationSchema(db);
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            ficha_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            jogo_liberado_at TEXT
        );

        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
        )
    `);
    return db;
}

async function seedReleasedPlayer(db, playerId, releasedModifier) {
    await db.run(
        `INSERT INTO jogadores
         (id, ficha_status, personagem_aparencia_status, jogo_status, jogo_liberado_at)
         VALUES (?, 'aprovada', 'approved', 'liberado', datetime('now', ?))`,
        [playerId, releasedModifier]
    );
}

async function seedPendingExit(db, playerId, expiresModifier = '+72 hours') {
    const result = await db.run(
        `INSERT INTO clover_exit_confirmations
         (player_id, status, expires_at)
         VALUES (?, 'pending', datetime('now', ?))`,
        [playerId, expiresModifier]
    );
    return result.lastID;
}

function createSockRecorder(messages) {
    return {
        sendMessage: async (jid, message) => {
            messages.push({ jid, message });
            return { key: { id: `msg-${messages.length}` } };
        },
    };
}

test('saida de jogador recem-liberado nao cria pendencia de arquivamento automatico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const messages = [];
    const playerId = '5511999000001@s.whatsapp.net';
    await seedReleasedPlayer(db, playerId, '-1 day');

    const result = await createOrRefreshExitConfirmation({
        sock: createSockRecorder(messages),
        db,
        groupId: 'community@g.us',
        participantId: playerId,
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'recent_release_grace');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_exit_confirmations')).total, 0);
    // The private-message policy is fail-closed for this source; the grace
    // decision is persisted without bypassing the transport policy.
    assert.equal(messages.length, 0);
});

test('saida de jogador recem-liberado cancela pendencia existente sem arquivar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const messages = [];
    const playerId = '5511999000002@s.whatsapp.net';
    await seedReleasedPlayer(db, playerId, '-2 days');
    const confirmationId = await seedPendingExit(db, playerId);

    const result = await createOrRefreshExitConfirmation({
        sock: createSockRecorder(messages),
        db,
        groupId: 'community@g.us',
        participantId: playerId,
    });

    assert.equal(result.reason, 'recent_release_grace');
    const row = await db.get('SELECT status, response_text FROM clover_exit_confirmations WHERE id = ?', [confirmationId]);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.response_text, 'recent_release_grace');
});

test('expiracao durante carencia de recem-liberado cancela sem arquivar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const playerId = '5511999000003@s.whatsapp.net';
    await seedReleasedPlayer(db, playerId, '-3 days');
    const confirmationId = await seedPendingExit(db, playerId, '-1 minute');
    let archiveCalls = 0;

    const processed = await processExpiredExitConfirmations({
        sock: null,
        db,
        archivePlayerFn: async () => {
            archiveCalls += 1;
            return { ok: true, backupPath: 'should-not-exist.sqlite' };
        },
    });

    assert.equal(archiveCalls, 0);
    assert.equal(processed[0].skipped, true);
    assert.equal(processed[0].reason, 'recent_release_grace');
    const row = await db.get(
        `SELECT status, response_text, backup_path, processing_token, processing_started_at
         FROM clover_exit_confirmations
         WHERE id = ?`,
        [confirmationId]
    );
    assert.equal(row.status, 'cancelled');
    assert.equal(row.response_text, 'recent_release_grace:expired');
    assert.equal(row.backup_path, null);
    assert.equal(row.processing_token, null);
    assert.equal(row.processing_started_at, null);
});

test('confirmacao durante carencia de recem-liberado cancela sem arquivar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const messages = [];
    const playerId = '5511999000004@s.whatsapp.net';
    await seedReleasedPlayer(db, playerId, '-4 days');
    await seedPendingExit(db, playerId);

    const result = await handleExitConfirmationReply({
        sock: createSockRecorder(messages),
        db,
        playerId,
        text: 'sim',
        sendPrivateTextFn: async ({ playerId: target, text }) => {
            messages.push({ jid: target, message: { text } });
            return { ok: true };
        },
    });

    assert.equal(result.handled, true);
    assert.equal(result.action, 'recent_release_grace');
    assert.equal((await db.get('SELECT status FROM clover_exit_confirmations WHERE player_id = ?', [playerId])).status, 'cancelled');
    assert.match(messages.at(-1).message.text, /nao foi arquivado automaticamente/);
});

test('expiracao fora da carencia continua arquivando normalmente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const playerId = '5511999000005@s.whatsapp.net';
    await seedReleasedPlayer(db, playerId, '-10 days');
    const confirmationId = await seedPendingExit(db, playerId, '-1 minute');
    let archiveCalls = 0;

    const processed = await processExpiredExitConfirmations({
        sock: null,
        db,
        archivePlayerFn: async () => {
            archiveCalls += 1;
            return { ok: true, backupPath: 'older-player.sqlite' };
        },
    });

    assert.equal(archiveCalls, 1);
    assert.equal(processed[0].ok, true);
    const row = await db.get('SELECT status, backup_path FROM clover_exit_confirmations WHERE id = ?', [confirmationId]);
    assert.equal(row.status, 'expired');
    assert.equal(row.backup_path, 'older-player.sqlite');
});
