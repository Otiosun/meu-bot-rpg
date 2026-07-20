'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    auditCanonicalPlayerBatch,
    normalizeText,
    resolvePlayer,
    textPresence,
} = require('../helpers/clover/playerCanonicalAuditService');

async function createFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            canonical_player_id TEXT,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            historia_status TEXT,
            esquadrao TEXT,
            raca TEXT,
            classe TEXT,
            grimorio TEXT,
            magia TEXT,
            aptidao_comum TEXT,
            aptidao_comum_key TEXT,
            aptidao_rara TEXT,
            aptidao_rara_key TEXT,
            marca_comum TEXT,
            marca_comum_key TEXT,
            marca_rara TEXT,
            marca_rara_key TEXT,
            anomalia TEXT,
            anomalia_key TEXT,
            gancho_narrativo TEXT,
            historias_extras TEXT
        );
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            template_key TEXT,
            item_name TEXT,
            description TEXT,
            category TEXT,
            kind TEXT,
            quantity INTEGER,
            status TEXT
        );
        CREATE TABLE clover_trait_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            category TEXT,
            result TEXT,
            chosen_key TEXT,
            attempt_number INTEGER
        );
        CREATE TABLE clover_skill_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            tree_id TEXT,
            node_id TEXT,
            purchased_at TEXT
        );
        CREATE TABLE player_skill_trees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            tree TEXT,
            unlocked_node_ids TEXT
        );
    `);

    await db.run(
        `INSERT INTO jogadores (
            id, canonical_player_id, nome, personagem_nome, ficha_status, jogo_status,
            historia_status, esquadrao, raca, classe, grimorio, magia,
            aptidao_comum, aptidao_comum_key, gancho_narrativo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            '551199992280@s.whatsapp.net',
            '551199992280@s.whatsapp.net',
            'Player A',
            'Artorius',
            'aprovada',
            'liberado',
            'aprovada',
            'lobos_cinzentos',
            'Humano',
            'Plebe',
            'Grimório de 3 Folhas',
            'Magia de Runas',
            'Corpo de Rotina',
            'corpo_de_rotina',
            null,
        ]
    );
    await db.run(
        `INSERT INTO jogadores (
            id, canonical_player_id, nome, personagem_nome, ficha_status, jogo_status,
            aptidao_comum, aptidao_comum_key, gancho_narrativo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            '551188881111@s.whatsapp.net',
            '551188881111@s.whatsapp.net',
            'Player L',
            'Lucien',
            'aprovada',
            'liberado',
            null,
            null,
            'Melodia de Terra Distante — uma canção de origem desconhecida.',
        ]
    );
    await db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, description, category, kind, quantity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            '551199992280@s.whatsapp.net',
            'A Espada Cega',
            'Espada resistente e completamente cega deixada no caminho.',
            'narrativo',
            'gancho',
            1,
            'disponivel',
        ]
    );
    await db.run(
        `INSERT INTO clover_skill_nodes (player_id, tree_id, node_id, purchased_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        ['551199992280@s.whatsapp.net', 'fisico', 'fisico']
    );
    return db;
}

const manifest = {
    version: 1,
    batch: 'fixture',
    source: 'teste',
    readOnly: true,
    players: [
        {
            referenceName: 'Artorius',
            identityHints: { phoneSuffix: '2280', aliases: ['Artorius'] },
            systemTraits: ['Corpo de Rotina'],
            customTraits: [],
            narrativeHooks: [],
            narrativeItems: [{ title: 'A Espada Cega', description: 'Espada resistente e cega.' }],
            notes: [],
        },
        {
            referenceName: 'Lucien',
            identityHints: { phoneSuffix: null, aliases: ['Lucien'] },
            systemTraits: [],
            customTraits: [{ title: 'Aqueles que Lutam por Amor', text: 'Recebe +10% quando sua música toca algo real.', review: 'activation_scope' }],
            narrativeHooks: [{ title: 'Melodia de Terra Distante', text: 'Uma canção de origem desconhecida.' }],
            narrativeItems: [],
            notes: [],
        },
    ],
};

test('normalização e presença textual ignoram acentos e pontuação', () => {
    assert.equal(normalizeText('Olhar Analítico.'), 'olhar analitico');
    assert.equal(
        textPresence('gancho melodia de terra distante uma cancao', 'Melodia de Terra Distante'),
        'title_present'
    );
});

test('resolução prioriza sufixo do telefone e nome exato', () => {
    const players = [
        { id: '551199992280@s.whatsapp.net', personagem_nome: 'Artorius', jogo_status: 'liberado', ficha_status: 'aprovada' },
        { id: '551177772280@s.whatsapp.net', personagem_nome: 'Outro', jogo_status: 'liberado', ficha_status: 'aprovada' },
    ];
    const resolution = resolvePlayer(players, manifest.players[0]);
    assert.equal(resolution.status, 'resolved');
    assert.equal(resolution.selected.personagem_nome, 'Artorius');
    assert.equal(resolution.confidence, 'high');
});

test('auditoria organiza o lote e não altera nenhuma tabela', async (t) => {
    const db = await createFixture();
    t.after(() => db.close());

    const before = {
        players: (await db.get('SELECT COUNT(*) AS total FROM jogadores')).total,
        inventory: (await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items')).total,
        skills: (await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes')).total,
    };

    const report = await auditCanonicalPlayerBatch(db, manifest);

    assert.equal(report.readOnly, true);
    assert.equal(report.summary.requestedPlayers, 2);
    assert.equal(report.summary.resolved, 2);
    assert.equal(report.summary.activeResolved, 2);

    const artorius = report.players.find((item) => item.referenceName === 'Artorius');
    assert.equal(artorius.intended.systemTrait.status, 'present');
    assert.equal(artorius.intended.narrativeItems[0].presence, 'title_present');
    assert.equal(artorius.snapshot.inventory.length, 1);
    assert.equal(artorius.snapshot.skills.length, 1);

    const lucien = report.players.find((item) => item.referenceName === 'Lucien');
    assert.equal(lucien.intended.narrativeHooks[0].presence, 'title_present');
    assert.equal(lucien.intended.customTraits[0].presence, 'missing');
    assert.ok(lucien.recommendations.some((item) => item.action === 'register_custom_trait'));

    const after = {
        players: (await db.get('SELECT COUNT(*) AS total FROM jogadores')).total,
        inventory: (await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items')).total,
        skills: (await db.get('SELECT COUNT(*) AS total FROM clover_skill_nodes')).total,
    };
    assert.deepEqual(after, before);
});

test('manifesto sem readOnly é recusado', async (t) => {
    const db = await createFixture();
    t.after(() => db.close());
    await assert.rejects(
        () => auditCanonicalPlayerBatch(db, { ...manifest, readOnly: false }),
        /readOnly/
    );
});
