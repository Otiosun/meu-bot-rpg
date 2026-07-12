const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    previewResetPlayer,
    previewRestoreReset,
    resetPlayer,
    restorePlayerReset,
} = require('../helpers/clover/playerResetService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            personagem_idade INTEGER,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT,
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );

        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            quantity INTEGER DEFAULT 1
        );

        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT,
            social_class TEXT,
            race TEXT,
            grimoire TEXT,
            magic_rarity TEXT,
            PRIMARY KEY (player_id, roll_number)
        );

        CREATE TABLE clover_spellbook_spells (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            version INTEGER NOT NULL,
            type TEXT NOT NULL,
            effect TEXT NOT NULL,
            status TEXT NOT NULL
        );

        CREATE TABLE clover_character_bonuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL
        );

        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            called_at TEXT,
            closed_at TEXT,
            closed_by TEXT,
            reason TEXT
        );

        CREATE TABLE slot_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            category TEXT NOT NULL,
            option_key TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT,
            roll_number INTEGER,
            expires_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            group_id TEXT,
            captain_name TEXT,
            captain_player_id TEXT,
            vice_captain_player_id TEXT,
            historical_stars INTEGER DEFAULT 0,
            current_stars INTEGER DEFAULT 0,
            black_stars INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_antighost_activity (
            player_id TEXT PRIMARY KEY,
            community_status TEXT DEFAULT 'member',
            last_activity_at TEXT,
            last_activity_kind TEXT,
            candidate_at TEXT,
            last_notice_level TEXT,
            last_notice_at TEXT,
            exempt_until TEXT,
            exempt_reason TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_archive_cards (
            player_id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            message_key_json TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            status TEXT NOT NULL,
            last_sent_at TEXT,
            updated_at TEXT
        );
    `);
    return db;
}

async function seedPlayer(db, id = 'player@lid') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, nome_real, personagem_nome, personagem_idade,
          ficha_status, historia_status, personagem_aparencia_status, jogo_status,
          esquadrao, estrelas, dinheiro, reino, magia, grimorio, patente)
         VALUES (?, 'Nilo', 'Nilo', 'Nilo Rosa', 'Arthur Pendragon', 19,
                 'aprovada', 'aprovada', 'approved', 'liberado',
                 'Touros Negros', 4, 900, 'Clover', 'Fogo', 'Trevo 3 folhas', 'Cavaleiro')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount, kind, source, reason)
         VALUES (?, 30, 'ganho', 'missao', 'Missão')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_inventory_items (player_id, item_name, quantity)
         VALUES (?, 'Poção', 2)`,
        [id]
    );
    await db.run(
        `INSERT INTO player_rolls
         (player_id, roll_number, kingdom, social_class, race, grimoire, magic_rarity)
         VALUES (?, 1, 'Clover', 'Plebeu', 'Humano', 'Trevo 3 folhas', 'Comum')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_spellbook_spells
         (player_id, name, normalized_name, version, type, effect, status)
         VALUES (?, 'Corte Rubro', 'corte_rubro', 1, 'Criação', 'Corta.', 'approved')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_character_bonuses (player_id, name, status)
         VALUES (?, 'Bônus narrativo', 'ativo')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES (?, 'waiting')`,
        [id]
    );
    await db.run(
        `INSERT INTO slot_reservations (player_id, category, option_key, status, source)
         VALUES (?, 'magic', 'fire', 'confirmed', 'roll')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, captain_player_id, historical_stars, current_stars)
         VALUES ('touros_negros', 'Touros Negros', ?, 10, 4)`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_antighost_activity
         (player_id, community_status, last_activity_at, last_activity_kind, candidate_at, last_notice_level)
         VALUES (?, 'member', '2026-07-01 10:00:00', 'message', '2026-07-10 10:00:00', 'candidate_14')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_archive_cards
         (player_id, group_id, message_key_json, snapshot_hash, snapshot_json, status)
         VALUES (?, 'archive@g.us', '{}', 'hash', '{}', 'active')`,
        [id]
    );
}

test('prévia mostra o que será limpo sem alterar o banco', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const preview = await previewResetPlayer(db, 'player@lid');
    assert.equal(preview.ok, true);
    assert.equal(preview.counts.deletedRows, 5);
    assert.equal(preview.counts.queueEntriesClosed, 1);
    assert.equal(preview.counts.reservationsReleased, 1);
    assert.equal(preview.counts.leadershipRolesCleared, 1);

    const player = await db.get('SELECT personagem_nome FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.personagem_nome, 'Arthur Pendragon');
});

test('reset preserva identidade e apaga somente o estado do personagem', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    const result = await resetPlayer(db, {
        playerId: 'player@lid',
        reason: 'Novo personagem aprovado',
        actorId: 'owner@lid',
        operationCode: 'RS-TEST0001',
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, 'RS-TEST0001');
    assert.equal(result.result.deletedRows, 5);

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.nome_real, 'Nilo Rosa');
    assert.equal(player.personagem_nome, '-');
    assert.equal(player.ficha_status, 'incompleta');
    assert.equal(player.jogo_status, 'bloqueado');
    assert.equal(player.esquadrao, '-');
    assert.equal(player.estrelas, 0);

    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items')).total, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM player_rolls')).total, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_spellbook_spells')).total, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_character_bonuses')).total, 0);

    const queue = await db.get('SELECT status FROM clover_spell_review_queue WHERE player_id = ?', ['player@lid']);
    assert.equal(queue.status, 'removed');
    const reservation = await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['player@lid']);
    assert.equal(reservation.status, 'released');
    const squad = await db.get('SELECT captain_player_id FROM clover_squads WHERE squad_key = ?', ['touros_negros']);
    assert.equal(squad.captain_player_id, null);
    const activity = await db.get('SELECT community_status, candidate_at, last_notice_level FROM clover_antighost_activity WHERE player_id = ?', ['player@lid']);
    assert.equal(activity.community_status, 'member');
    assert.equal(activity.candidate_at, null);
    assert.equal(activity.last_notice_level, null);
    const archive = await db.get('SELECT status FROM clover_archive_cards WHERE player_id = ?', ['player@lid']);
    assert.equal(archive.status, 'deleted');
});

test('restaura o snapshot completo quando nenhum dado novo foi criado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    await resetPlayer(db, {
        playerId: 'player@lid',
        reason: 'Teste de recuperação',
        actorId: 'owner@lid',
        operationCode: 'RS-TEST0002',
    });

    const preview = await previewRestoreReset(db, 'RS-TEST0002');
    assert.equal(preview.ok, true);
    assert.equal(preview.counts.deletedRows, 5);

    const restored = await restorePlayerReset(db, {
        sourceCode: 'RS-TEST0002',
        reason: 'Reset aplicado por engano',
        actorId: 'owner@lid',
        operationCode: 'RR-TEST0002',
    });

    assert.equal(restored.ok, true);
    assert.equal(restored.code, 'RR-TEST0002');
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.personagem_nome, 'Arthur Pendragon');
    assert.equal(player.ficha_status, 'aprovada');
    assert.equal(player.jogo_status, 'liberado');
    assert.equal(player.esquadrao, 'Touros Negros');
    assert.equal(player.estrelas, 4);

    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM player_rolls')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_spellbook_spells')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_character_bonuses')).total, 1);

    const queue = await db.get('SELECT status FROM clover_spell_review_queue WHERE player_id = ?', ['player@lid']);
    assert.equal(queue.status, 'waiting');
    const reservation = await db.get('SELECT status FROM slot_reservations WHERE player_id = ?', ['player@lid']);
    assert.equal(reservation.status, 'confirmed');
    const squad = await db.get('SELECT captain_player_id FROM clover_squads WHERE squad_key = ?', ['touros_negros']);
    assert.equal(squad.captain_player_id, 'player@lid');
    const archive = await db.get('SELECT status FROM clover_archive_cards WHERE player_id = ?', ['player@lid']);
    assert.equal(archive.status, 'active');

    const event = await db.get('SELECT status, restore_operation_code FROM clover_player_reset_events WHERE operation_code = ?', ['RS-TEST0002']);
    assert.equal(event.status, 'restored');
    assert.equal(event.restore_operation_code, 'RR-TEST0002');
});

test('bloqueia restauração quando o player já começou um personagem novo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    await resetPlayer(db, {
        playerId: 'player@lid',
        reason: 'Teste',
        actorId: 'owner@lid',
        operationCode: 'RS-TEST0003',
    });
    await db.run(
        `INSERT INTO player_rolls
         (player_id, roll_number, kingdom, social_class, race, grimoire, magic_rarity)
         VALUES ('player@lid', 2, 'Spade', 'Nobre', 'Humano', 'Spade 3 folhas', 'Rara')`
    );

    const preview = await previewRestoreReset(db, 'RS-TEST0003');
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'state_changed_after_reset');
});

test('bloqueia restauração quando a vaga antiga foi ocupada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedPlayer(db);

    await resetPlayer(db, {
        playerId: 'player@lid',
        reason: 'Teste',
        actorId: 'owner@lid',
        operationCode: 'RS-TEST0004',
    });
    await db.run(
        `INSERT INTO slot_reservations (player_id, category, option_key, status, source)
         VALUES ('other@lid', 'magic', 'fire', 'confirmed', 'novo player')`
    );

    const preview = await previewRestoreReset(db, 'RS-TEST0004');
    assert.equal(preview.ok, false);
    assert.equal(preview.code, 'restore_conflicts');
    assert.equal(preview.conflicts.some((item) => item.type === 'reservation_occupied'), true);
});
