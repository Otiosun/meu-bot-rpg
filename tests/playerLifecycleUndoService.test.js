const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    archivePlayer,
    ensurePlayerLifecycleSchema,
    reactivatePlayer,
} = require('../helpers/clover/playerLifecycleService');
const {
    applyLifecycleUndo,
    ensurePlayerLifecycleUndoSchema,
    previewLifecycleUndo,
} = require('../helpers/clover/playerLifecycleUndoService');

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
    `);
    await ensurePlayerLifecycleSchema(db);
    await ensurePlayerLifecycleUndoSchema(db);
    return db;
}

async function seedPlayer(db, id = 'player@lid') {
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
        `INSERT INTO clover_spell_review_queue (player_id, status, requested_at)
         VALUES (?, 'waiting', '2026-07-01 10:00:00')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, captain_player_id)
         VALUES ('touros_negros', 'Touros Negros', ?)`,
        [id]
    );
}

test('desfaz arquivamento e restaura exatamente os vínculos do snapshot', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const archived = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Saiu da comunidade',
        actorId: 'owner@lid',
    });
    assert.equal(archived.ok, true);

    const preview = await previewLifecycleUndo(db, archived.code);
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.changes.lifecycleStatus, ['archived', 'active']);
    assert.deepEqual(preview.changes.gameStatus, ['arquivado', 'liberado']);
    assert.deepEqual(preview.changes.reservations, [0, 1]);
    assert.deepEqual(preview.changes.queueEntries, [0, 1]);

    const undo = await applyLifecycleUndo(db, {
        sourceCode: archived.code,
        reason: 'Arquivamento aplicado por engano',
        actorId: 'owner@lid',
    });
    assert.equal(undo.ok, true);
    assert.match(undo.code, /^LU-/);

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.lifecycle_status, 'active');
    assert.equal(player.jogo_status, 'liberado');
    assert.equal(player.esquadrao, 'Touros Negros');

    const reservation = await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['player@lid']);
    assert.equal(reservation.status, 'confirmed');

    const queue = await db.get('SELECT status, requested_at FROM clover_spell_review_queue WHERE player_id = ?', ['player@lid']);
    assert.equal(queue.status, 'waiting');
    assert.equal(queue.requested_at, '2026-07-01 10:00:00');

    const squad = await db.get('SELECT captain_player_id FROM clover_squads WHERE squad_key = ?', ['touros_negros']);
    assert.equal(squad.captain_player_id, 'player@lid');

    const source = await db.get('SELECT undone_at, undo_operation_code FROM clover_player_lifecycle_events WHERE id = ?', [archived.event?.id || 1]);
    assert.ok(source.undone_at);
    assert.equal(source.undo_operation_code, undo.code);
});

test('desfaz reativação e volta ao estado arquivado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const archived = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Pausa',
        actorId: 'owner@lid',
    });
    assert.equal(archived.ok, true);
    const reactivated = await reactivatePlayer(db, {
        playerId: 'player@lid',
        reason: 'Retorno',
        actorId: 'owner@lid',
    });
    assert.equal(reactivated.ok, true);

    const preview = await previewLifecycleUndo(db, reactivated.code);
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.changes.lifecycleStatus, ['active', 'archived']);

    const undo = await applyLifecycleUndo(db, {
        sourceCode: reactivated.code,
        reason: 'Retorno cancelado',
        actorId: 'owner@lid',
    });
    assert.equal(undo.ok, true);

    const player = await db.get('SELECT lifecycle_status, jogo_status, esquadrao FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.lifecycle_status, 'archived');
    assert.equal(player.jogo_status, 'arquivado');
    assert.equal(player.esquadrao, '-');

    const activeQueue = await db.get(
        `SELECT COUNT(*) AS total FROM clover_spell_review_queue
         WHERE player_id = ? AND status IN ('waiting', 'called')`,
        ['player@lid']
    );
    assert.equal(activeQueue.total, 0);
});

test('bloqueia desfazer quando o estado mudou depois do evento', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const archived = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Teste',
        actorId: 'owner@lid',
    });
    await db.run("UPDATE jogadores SET jogo_status = 'bloqueado' WHERE id = 'player@lid'");

    const preview = await previewLifecycleUndo(db, archived.code);
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'state_drift_detected');

    const undo = await applyLifecycleUndo(db, {
        sourceCode: archived.code,
        reason: 'Não deve aplicar',
        actorId: 'owner@lid',
    });
    assert.equal(undo.ok, false);
    assert.equal(undo.code, 'state_drift_detected');
});

test('bloqueia restauração quando a vaga já foi ocupada por outro player', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const archived = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Pausa',
        actorId: 'owner@lid',
    });
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao, is_shadow)
         VALUES ('outro@lid', 'Outro', 'Outro', 'Outro', 'aprovada', 'liberado', '-', 0)`
    );
    await db.run(
        `INSERT INTO slot_reservations (player_id, category, option_key, status)
         VALUES ('outro@lid', 'magic', 'fire', 'confirmed')`
    );

    const preview = await previewLifecycleUndo(db, archived.code);
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'undo_conflicts');
    assert.ok(preview.conflicts.some((conflict) => conflict.type === 'reservation_occupied'));
});

test('só permite desfazer o evento de ciclo mais recente e apenas uma vez', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const archived = await archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Pausa',
        actorId: 'owner@lid',
    });
    const reactivated = await reactivatePlayer(db, {
        playerId: 'player@lid',
        reason: 'Retorno',
        actorId: 'owner@lid',
    });

    const oldPreview = await previewLifecycleUndo(db, archived.code);
    assert.equal(oldPreview.ok, false);
    assert.equal(oldPreview.code, 'not_latest_lifecycle_event');

    const firstUndo = await applyLifecycleUndo(db, {
        sourceCode: reactivated.code,
        reason: 'Cancelar retorno',
        actorId: 'owner@lid',
    });
    assert.equal(firstUndo.ok, true);

    const secondUndo = await previewLifecycleUndo(db, reactivated.code);
    assert.equal(secondUndo.ok, false);
    assert.equal(secondUndo.code, 'already_undone');
});
