const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureSpellbookSchema } = require('../helpers/clover/spellbookService');
const { diagnoseDatabaseIntegrity } = require('../helpers/clover/databaseIntegrityService');

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
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            active INTEGER DEFAULT 1
        );

        CREATE TABLE clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual'
        );

        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        CREATE TABLE clover_antighost_activity (
            player_id TEXT PRIMARY KEY,
            community_status TEXT DEFAULT 'unknown'
        );
    `);
    await ensureSpellbookSchema(db);
    return db;
}

async function addPlayer(db, player) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao,
          canonical_player_id, merged_into, is_shadow, identity_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            player.id,
            player.nome || player.personagemNome || '-',
            player.displayName || player.personagemNome || '-',
            player.personagemNome ?? '-',
            player.fichaStatus || 'aprovada',
            player.jogoStatus || 'liberado',
            player.esquadrao || '-',
            player.canonicalPlayerId || null,
            player.mergedInto || null,
            player.isShadow ? 1 : 0,
            player.identityStatus || 'active',
        ]
    );
}

function codes(report) {
    return new Set(report.issues.map((issue) => issue.code));
}

test('detecta inconsistências cruzadas sem alterar o banco', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(`INSERT INTO clover_squads (squad_key, name) VALUES ('touros_negros', 'Touros Negros')`);

    await addPlayer(db, {
        id: 'sem-personagem@lid',
        personagemNome: '-',
        fichaStatus: 'aprovada',
        jogoStatus: 'liberado',
        esquadrao: 'Esquadrão Inexistente',
    });
    await addPlayer(db, {
        id: 'sombra@lid',
        personagemNome: 'Espelho',
        jogoStatus: 'liberado',
        isShadow: true,
    });
    await addPlayer(db, {
        id: 'fora@lid',
        personagemNome: 'Fora da Comunidade',
        jogoStatus: 'liberado',
        esquadrao: 'Touros Negros',
    });

    await db.run(
        `INSERT INTO clover_player_aliases (player_id_destino, alias_type, alias_value, active)
         VALUES ('apagado@lid', 'manual', 'Alias Órfão', 1)`
    );
    await db.run(
        `INSERT INTO clover_inventory_items (player_id, item_name)
         VALUES ('apagado@lid', 'Item Órfão')`
    );
    await db.run(
        `INSERT INTO clover_antighost_activity (player_id, community_status)
         VALUES ('fora@lid', 'out')`
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES ('apagado@lid', 'waiting')`
    );

    const before = {
        players: (await db.get('SELECT COUNT(*) AS total FROM jogadores')).total,
        queue: (await db.get('SELECT COUNT(*) AS total FROM clover_spell_review_queue')).total,
        items: (await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items')).total,
    };

    const report = await diagnoseDatabaseIntegrity(db, { sampleLimit: 5 });
    const foundCodes = codes(report);

    assert.equal(report.readOnly, true);
    assert.ok(foundCodes.has('released_without_character'));
    assert.ok(foundCodes.has('approved_profile_without_character'));
    assert.ok(foundCodes.has('shadow_player_released'));
    assert.ok(foundCodes.has('shadow_without_destination'));
    assert.ok(foundCodes.has('alias_target_missing'));
    assert.ok(foundCodes.has('active_queue_entry_blocked'));
    assert.ok(foundCodes.has('orphan_player_reference'));
    assert.ok(foundCodes.has('unknown_player_squad'));
    assert.ok(foundCodes.has('outside_community_but_released'));
    assert.ok(report.summary.critical > 0);
    assert.ok(report.summary.warning > 0);

    const after = {
        players: (await db.get('SELECT COUNT(*) AS total FROM jogadores')).total,
        queue: (await db.get('SELECT COUNT(*) AS total FROM clover_spell_review_queue')).total,
        items: (await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items')).total,
    };
    assert.deepEqual(after, before);
});

test('detecta ponte canônica quebrada e nome de personagem duplicado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addPlayer(db, {
        id: 'primeiro@lid',
        personagemNome: 'Arthur Pendragon',
        canonicalPlayerId: 'destino-inexistente@lid',
        jogoStatus: 'bloqueado',
    });
    await addPlayer(db, {
        id: 'segundo@lid',
        personagemNome: 'Arthur   Pendragon',
        jogoStatus: 'bloqueado',
    });

    const report = await diagnoseDatabaseIntegrity(db);
    const foundCodes = codes(report);

    assert.ok(foundCodes.has('canonical_player_missing'));
    assert.ok(foundCodes.has('duplicate_character_name'));
});

test('banco íntegro retorna relatório vazio mesmo sem tabelas opcionais', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT
        )
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao)
         VALUES ('ok@lid', 'Asta', 'Asta', 'Asta', 'aprovada', 'liberado', '-')`
    );

    const report = await diagnoseDatabaseIntegrity(db);

    assert.equal(report.players, 1);
    assert.equal(report.summary.total, 0);
    assert.deepEqual(report.issues, []);
});
