const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    LIFECYCLE_STATUS,
    archivePlayer,
    ensurePlayerLifecycleSchema,
    getPlayerLifecycleState,
    previewArchivePlayer,
    previewReactivatePlayer,
    reactivatePlayer,
} = require('../helpers/clover/playerLifecycleService');

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

async function seedActivePlayer(db, id = 'player@lid') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao, is_shadow)
         VALUES (?, 'Nilo', 'Nilo', 'Arthur Pendragon', 'aprovada', 'liberado', 'Touros Negros', 0)`,
        [id]
    );
    await db.run(
        `INSERT INTO slot_reservations
         (player_id, category, option_key, status)
         VALUES (?, 'magic', 'fire', 'confirmed')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES (?, 'waiting')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, captain_player_id)
         VALUES ('touros_negros', 'Touros Negros', ?)`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_antighost_activity
         (player_id, last_activity_at, last_activity_kind, candidate_at, last_notice_level)
         VALUES (?, '2026-07-01 00:00:00', 'message', '2026-07-10 00:00:00', 'strong_10')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount)
         VALUES (?, 50)`,
        [id]
    );
}

test('arquiva sem apagar personagem, PH ou histórico e libera vínculos operacionais', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedActivePlayer(db);

    const preview = await previewArchivePlayer(db, 'player@lid');
    assert.equal(preview.ok, true);
    assert.equal(preview.changes.queueEntriesClosed, 1);
    assert.equal(preview.changes.reservationsReleased, 1);
    assert.equal(preview.changes.leadershipRolesCleared, 1);

    const result = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Saiu da comunidade',
        actorId: 'owner@lid',
    });

    assert.equal(result.ok, true);
    assert.match(result.code, /^LC-/);
    assert.equal(result.result.preserved.player, true);
    assert.equal(result.result.preserved.ph, true);

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.ok(player);
    assert.equal(player.lifecycle_status, LIFECYCLE_STATUS.ARCHIVED);
    assert.equal(player.jogo_status, 'arquivado');
    assert.equal(player.esquadrao, '-');
    assert.equal(player.archive_reason, 'Saiu da comunidade');

    const queue = await db.get('SELECT status, reason FROM clover_spell_review_queue WHERE player_id = ?', ['player@lid']);
    assert.equal(queue.status, 'removed');
    assert.match(queue.reason, /arquivado/i);

    const reservation = await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['player@lid']);
    assert.equal(reservation.status, 'released');

    const squad = await db.get('SELECT captain_player_id FROM clover_squads WHERE squad_key = ?', ['touros_negros']);
    assert.equal(squad.captain_player_id, null);

    const ph = await db.get('SELECT COUNT(*) AS total, SUM(amount) AS amount FROM clover_ph_ledger WHERE player_id = ?', ['player@lid']);
    assert.equal(ph.total, 1);
    assert.equal(ph.amount, 50);

    const event = await db.get('SELECT * FROM clover_player_lifecycle_events WHERE operation_code = ?', [result.code]);
    assert.equal(event.operation_type, 'archive');
});

test('reativa e restaura reserva, esquadrão, liderança e fila no fim', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedActivePlayer(db);

    const archived = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Pausa',
        actorId: 'owner@lid',
    });
    assert.equal(archived.ok, true);

    const preview = await previewReactivatePlayer(db, 'player@lid');
    assert.equal(preview.ok, true);
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.changes.reservationsRestored, 1);
    assert.equal(preview.changes.queueRestoredToEnd, true);

    const reactivated = await reactivatePlayer(db, {
        playerId: 'player@lid',
        reason: 'Retorno aprovado',
        actorId: 'owner@lid',
    });

    assert.equal(reactivated.ok, true);
    assert.equal(reactivated.result.lifecycleStatus, LIFECYCLE_STATUS.ACTIVE);
    assert.equal(reactivated.result.reservationsRestored, 1);
    assert.equal(reactivated.result.queue.restored, true);
    assert.equal(reactivated.result.leadership.restored, 1);

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.lifecycle_status, LIFECYCLE_STATUS.ACTIVE);
    assert.equal(player.jogo_status, 'liberado');
    assert.equal(player.esquadrao, 'Touros Negros');
    assert.equal(player.archived_at, null);

    const reservation = await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['player@lid']);
    assert.equal(reservation.status, 'confirmed');

    const activeQueue = await db.all(
        `SELECT * FROM clover_spell_review_queue
         WHERE player_id = ? AND status IN ('waiting', 'called')`,
        ['player@lid']
    );
    assert.equal(activeQueue.length, 1);
    assert.equal(activeQueue[0].status, 'waiting');

    const squad = await db.get('SELECT captain_player_id FROM clover_squads WHERE squad_key = ?', ['touros_negros']);
    assert.equal(squad.captain_player_id, 'player@lid');

    const state = await getPlayerLifecycleState(db, 'player@lid');
    assert.equal(state.ok, true);
    assert.equal(state.latestEvent.operation_type, 'reactivate');
});

test('conflito de vaga mantém jogo bloqueado e marca reativação pendente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedActivePlayer(db, 'arquivado@lid');

    const archived = await archivePlayer(db, {
        playerId: 'arquivado@lid',
        reason: 'Pausa',
        actorId: 'owner@lid',
    });
    assert.equal(archived.ok, true);

    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao, is_shadow)
         VALUES ('novo@lid', 'Novo', 'Novo', 'Novo Personagem', 'aprovada', 'liberado', '-', 0)`
    );
    await db.run(
        `INSERT INTO slot_reservations
         (player_id, category, option_key, status)
         VALUES ('novo@lid', 'magic', 'fire', 'confirmed')`
    );

    const preview = await previewReactivatePlayer(db, 'arquivado@lid');
    assert.equal(preview.ok, true);
    assert.equal(preview.conflicts.length, 1);

    const reactivated = await reactivatePlayer(db, {
        playerId: 'arquivado@lid',
        reason: 'Retorno com conflito',
        actorId: 'owner@lid',
    });

    assert.equal(reactivated.ok, true);
    assert.equal(reactivated.result.lifecycleStatus, LIFECYCLE_STATUS.REACTIVATION_PENDING);
    assert.equal(reactivated.result.reservationConflicts.length, 1);

    const player = await db.get('SELECT lifecycle_status, jogo_status FROM jogadores WHERE id = ?', ['arquivado@lid']);
    assert.equal(player.lifecycle_status, LIFECYCLE_STATUS.REACTIVATION_PENDING);
    assert.equal(player.jogo_status, 'bloqueado');

    const reservation = await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['arquivado@lid']);
    assert.equal(reservation.status, 'released');
});

test('recusa cadastro sombra e player já arquivado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao, is_shadow)
         VALUES ('sombra@lid', 'Sombra', 'Sombra', 'Espelho', 'aprovada', 'liberado', '-', 1)`
    );

    const shadow = await archivePlayer(db, {
        playerId: 'sombra@lid',
        reason: 'Teste',
        actorId: 'owner@lid',
    });
    assert.equal(shadow.ok, false);
    assert.equal(shadow.code, 'shadow_player');

    await seedActivePlayer(db, 'normal@lid');
    const first = await archivePlayer(db, {
        playerId: 'normal@lid',
        reason: 'Teste',
        actorId: 'owner@lid',
    });
    assert.equal(first.ok, true);

    const second = await archivePlayer(db, {
        playerId: 'normal@lid',
        reason: 'Teste novamente',
        actorId: 'owner@lid',
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'already_archived');
});
