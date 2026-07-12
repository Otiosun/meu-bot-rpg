const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    archiveAndResetPlayer,
    resetPlayerState,
} = require('../helpers/clover/playerReset');
const { ensurePlayerLifecycleSchema } = require('../helpers/clover/playerLifecycleService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT,
            is_shadow INTEGER DEFAULT 0,
            numero_roll_escolhido INTEGER DEFAULT NULL
        );

        CREATE TABLE slot_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            category TEXT NOT NULL,
            option_key TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT DEFAULT '-',
            roll_number INTEGER DEFAULT NULL,
            expires_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT DEFAULT NULL
        );

        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            called_at TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            closed_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            captain_player_id TEXT DEFAULT NULL,
            vice_captain_player_id TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_antighost_activity (
            player_id TEXT PRIMARY KEY,
            last_activity_at TEXT DEFAULT NULL,
            last_activity_kind TEXT DEFAULT NULL,
            candidate_at TEXT DEFAULT NULL,
            last_notice_level TEXT DEFAULT NULL,
            last_notice_at TEXT DEFAULT NULL,
            exempt_until TEXT DEFAULT NULL,
            exempt_reason TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL
        );
    `);
    await ensurePlayerLifecycleSchema(db);
    return db;
}

async function seed(db, id = 'player@lid') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao, is_shadow)
         VALUES (?, 'Nilo', 'Nilo', 'Arthur Pendragon', 'aprovada', 'liberado', 'Touros Negros', 0)`,
        [id]
    );
    await db.run(
        `INSERT INTO slot_reservations (player_id, category, option_key, status)
         VALUES (?, 'magic', 'fire', 'confirmed')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES (?, 'waiting')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, captain_player_id)
         VALUES ('touros_negros', 'Touros Negros', ?)`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_antighost_activity
         (player_id, last_activity_at, last_activity_kind, candidate_at, last_notice_level)
         VALUES (?, '2026-07-01 00:00:00', 'message', '2026-07-10 00:00:00', 'candidate_14')`,
        [id]
    );
    await db.run('INSERT INTO clover_ph_ledger (player_id, amount) VALUES (?, 50)', [id]);
}

test('arquivo legado não contém mais DELETE FROM jogadores', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'helpers', 'clover', 'playerReset.js'),
        'utf8'
    );
    assert.doesNotMatch(source, /DELETE\s+FROM\s+jogadores/i);
});

test('resetPlayerState converte pedido legado em arquivamento reversível', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const result = await resetPlayerState(db, 'player@lid', {
        reason: 'Saída confirmada',
        actorId: 'owner@lid',
    });

    assert.equal(result.ok, true);
    assert.equal(result.archived, true);
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.ok(player);
    assert.equal(player.personagem_nome, 'Arthur Pendragon');
    assert.equal(player.lifecycle_status, 'archived');
    assert.equal(player.jogo_status, 'arquivado');
    assert.equal(player.esquadrao, '-');

    const ph = await db.get('SELECT COUNT(*) AS total, SUM(amount) AS amount FROM clover_ph_ledger WHERE player_id = ?', ['player@lid']);
    assert.equal(ph.total, 1);
    assert.equal(ph.amount, 50);
    assert.equal((await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['player@lid'])).status, 'released');
    assert.equal((await db.get('SELECT status FROM clover_spell_review_queue WHERE player_id = ?', ['player@lid'])).status, 'removed');
});

test('archiveAndResetPlayer preserva cadastro e retorna resultado explícito', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const result = await archiveAndResetPlayer({
        sock: null,
        db,
        playerId: 'player@lid',
        reason: 'anti-ghost confirmado',
        actorId: 'owner@lid',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'lifecycle_archive');
    assert.ok(result.lifecycle);
    const player = await db.get('SELECT id, personagem_nome, lifecycle_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.deepEqual(player, {
        id: 'player@lid',
        personagem_nome: 'Arthur Pendragon',
        lifecycle_status: 'archived',
    });
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger WHERE player_id = ?', ['player@lid'])).total, 1);
});
