'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { resetPlayer } = require('../helpers/clover/playerResetService');
const {
    forceRestorePlayerReset,
    loadPreview,
} = require('../scripts/forceRestorePlayerReset');

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
            jogo_bloqueio_motivo TEXT,
            jogo_liberado_at TEXT,
            jogo_liberado_by TEXT,
            esquadrao TEXT,
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            idade TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            atributos_max INTEGER DEFAULT 10,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            reflexos INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            mana INTEGER DEFAULT 0,
            pontos INTEGER DEFAULT 5,
            agilidade INTEGER DEFAULT 0,
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

        CREATE TABLE clover_trait_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            trait_type TEXT NOT NULL,
            result_key TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    return db;
}

async function seedOldCharacter(db, id = 'player@lid') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, nome_real, personagem_nome, personagem_idade,
          ficha_status, historia_status, personagem_aparencia_status, jogo_status,
          esquadrao, estrelas, dinheiro, reino, magia, grimorio, patente)
         VALUES (?, 'Leonhardt Feramena', 'Cacador', 'Player', 'Leonhardt Feramena', 19,
                 'aprovada', 'pendente', 'approved', 'arquivado', '-', 0, 1200,
                 'Clover', 'Magia de Legião', 'Grimório de Diamante', '-')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount, kind, source, reason)
         VALUES (?, 30, 'ganho', 'initial_ph', 'PH antigo')`,
        [id]
    );
    for (let roll = 1; roll <= 4; roll += 1) {
        await db.run(
            `INSERT INTO player_rolls
             (player_id, roll_number, kingdom, social_class, race, grimoire, magic_rarity)
             VALUES (?, ?, 'Clover', 'Plebeu', 'Humano', 'Diamante', 'Rara')`,
            [id, roll]
        );
    }
    await db.run(
        `INSERT INTO clover_trait_attempts (player_id, trait_type, result_key)
         VALUES (?, 'aptidao', 'antiga_1'), (?, 'marca', 'antiga_2')`,
        [id, id]
    );
}

test('recuperação forçada arquiva o recomeço parcial e restaura o snapshot antigo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedOldCharacter(db);

    const reset = await resetPlayer(db, {
        playerId: 'player@lid',
        reason: 'Reset acidental',
        actorId: 'owner@lid',
        operationCode: 'RS-FORCE001',
    });
    assert.equal(reset.ok, true);

    await db.run(
        `UPDATE jogadores
         SET magia = 'Magia de Barreira', personagem_nome = '-', jogo_status = 'bloqueado'
         WHERE id = 'player@lid'`
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount, kind, source, reason)
         VALUES ('player@lid', 15, 'ganho', 'initial_ph', 'PH novo parcial')`
    );
    await db.run(
        `INSERT INTO player_rolls
         (player_id, roll_number, kingdom, social_class, race, grimoire, magic_rarity)
         VALUES ('player@lid', 1, 'Spade', 'Nobre', 'Humano', 'Spade', 'Comum')`
    );
    await db.run(
        `INSERT INTO clover_trait_attempts (player_id, trait_type, result_key)
         VALUES ('player@lid', 'aptidao', 'nova_1'), ('player@lid', 'marca', 'nova_2')`
    );

    const preview = await loadPreview(db, {
        playerId: 'player@lid',
        sourceCode: 'RS-FORCE001',
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.currentCounts.player_rolls, 1);
    assert.equal(preview.desiredCounts.player_rolls, 4);

    const result = await forceRestorePlayerReset(db, {
        playerId: 'player@lid',
        sourceCode: 'RS-FORCE001',
        reason: 'Recuperar personagem antigo',
        actorId: 'owner@lid',
        operationCode: 'RR-FORCE001',
        releaseGame: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, 'RR-FORCE001');
    assert.equal(result.result.discardedByTable.player_rolls, 1);
    assert.equal(result.result.insertedByTable.player_rolls, 4);

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.personagem_nome, 'Leonhardt Feramena');
    assert.equal(player.ficha_status, 'aprovada');
    assert.equal(player.personagem_aparencia_status, 'approved');
    assert.equal(player.magia, 'Magia de Legião');
    assert.equal(player.grimorio, 'Grimório de Diamante');
    assert.equal(player.jogo_status, 'liberado');
    assert.equal(player.lifecycle_status, 'active');

    const rolls = await db.all('SELECT roll_number, kingdom FROM player_rolls WHERE player_id = ? ORDER BY roll_number', ['player@lid']);
    assert.deepEqual(rolls, [
        { roll_number: 1, kingdom: 'Clover' },
        { roll_number: 2, kingdom: 'Clover' },
        { roll_number: 3, kingdom: 'Clover' },
        { roll_number: 4, kingdom: 'Clover' },
    ]);

    const traits = await db.all('SELECT result_key FROM clover_trait_attempts WHERE player_id = ? ORDER BY id', ['player@lid']);
    assert.deepEqual(traits.map((row) => row.result_key), ['antiga_1', 'antiga_2']);

    const ledger = await db.all('SELECT amount, reason FROM clover_ph_ledger WHERE player_id = ?', ['player@lid']);
    assert.deepEqual(ledger, [{ amount: 30, reason: 'PH antigo' }]);

    const event = await db.get(
        'SELECT status, restore_operation_code FROM clover_player_reset_events WHERE operation_code = ?',
        ['RS-FORCE001']
    );
    assert.equal(event.status, 'restored');
    assert.equal(event.restore_operation_code, 'RR-FORCE001');

    const restore = await db.get(
        'SELECT before_restore_json FROM clover_player_reset_restores WHERE operation_code = ?',
        ['RR-FORCE001']
    );
    const discarded = JSON.parse(restore.before_restore_json);
    assert.equal(discarded.tables.player_rolls.length, 1);
    assert.equal(discarded.tables.player_rolls[0].kingdom, 'Spade');
});
