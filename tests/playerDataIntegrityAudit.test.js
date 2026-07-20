'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    auditPlayerDataIntegrity,
    hasEncodingDamage,
    isPlaceholder,
    parseJson,
} = require('../helpers/clover/playerDataIntegrityAudit');
const { listTrees } = require('../helpers/clover/treeLoader');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-',
            gancho_narrativo TEXT DEFAULT '-',
            historias_extras TEXT DEFAULT '[]',
            aptidao_comum TEXT DEFAULT '-',
            aptidao_comum_key TEXT DEFAULT NULL,
            aptidao_rara TEXT DEFAULT '-',
            aptidao_rara_key TEXT DEFAULT NULL,
            marca_comum TEXT DEFAULT '-',
            marca_comum_key TEXT DEFAULT NULL,
            marca_rara TEXT DEFAULT '-',
            marca_rara_key TEXT DEFAULT NULL,
            anomalia TEXT DEFAULT '-',
            anomalia_key TEXT DEFAULT NULL,
            tentativas_especiais TEXT DEFAULT '[]',
            ficha_status TEXT DEFAULT 'incompleta',
            jogo_status TEXT DEFAULT 'bloqueado'
        );
        CREATE TABLE clover_trait_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            category TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT NOT NULL,
            chosen_key TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_item_templates (
            template_key TEXT PRIMARY KEY,
            item_name TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            duplicable INTEGER DEFAULT 1,
            properties_json TEXT DEFAULT NULL,
            effects_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            quantity INTEGER DEFAULT 1,
            kind TEXT DEFAULT 'narrativo',
            category TEXT DEFAULT 'material',
            status TEXT DEFAULT 'disponivel',
            template_key TEXT DEFAULT NULL,
            durability_current INTEGER DEFAULT NULL,
            durability_max INTEGER DEFAULT NULL,
            properties_json TEXT DEFAULT NULL,
            effects_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_skill_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            tree_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE player_skill_trees (
            player_id TEXT NOT NULL,
            tree TEXT NOT NULL,
            unlocked_node_ids TEXT DEFAULT '[]',
            narrative_flags TEXT DEFAULT '[]',
            last_prox_options TEXT DEFAULT '[]',
            purchase_history TEXT DEFAULT '[]'
        );
    `);

    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, raca, classe, grimorio, magia,
          gancho_narrativo, historias_extras, aptidao_comum,
          ficha_status, jogo_status)
         VALUES ('p1', 'Conta', 'Herói', 'Humano', '-', 'Trevo', 'Magia de Fogo',
                 '-', '{quebrado', 'Grande Reserva', 'aprovada', 'liberado')`
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, raca, classe, grimorio, magia,
          gancho_narrativo, aptidao_rara, aptidao_rara_key,
          ficha_status, jogo_status)
         VALUES ('p2', 'Texto Corromp?do', 'Humano', 'Mago', 'Trevo', 'Água',
                 'Gancho válido', '-', NULL, 'aprovada', 'liberado')`
    );
    await db.run(
        `INSERT INTO clover_trait_attempts
         (player_id, attempt_number, category, status, result)
         VALUES ('p2', 1, 'rare_aptitude', 'completed', 'success')`
    );
    await db.run(
        `INSERT INTO clover_item_templates
         (template_key, item_name, description, duplicable, properties_json)
         VALUES ('unico', 'Relíquia Única', 'Descrição suficiente', 0, '{}')`
    );
    await db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, quantity, kind, category, status, template_key,
          durability_current, durability_max, properties_json)
         VALUES
         ('p1', 'Nome personalizado', 1, 'equipamento', 'arma', 'disponivel', 'unico', 12, 10, '{}'),
         ('p1', 'Relíquia Única', 1, 'equipamento', 'arma', 'disponivel', 'unico', 10, 10, '{}'),
         ('fantasma', 'Item órfão', 1, 'material', 'material', 'disponivel', NULL, NULL, NULL, '{ruim')`
    );

    const tree = listTrees()[0];
    const node = tree.nodes[0];
    await db.run(
        `INSERT INTO clover_skill_nodes
         (player_id, tree_id, node_id, metadata_json)
         VALUES ('p1', ?, ?, '{}'), ('p1', ?, 'no_inexistente', '{}')`,
        [tree.id, node.id, tree.id]
    );
    await db.run(
        `INSERT INTO player_skill_trees
         (player_id, tree, unlocked_node_ids, narrative_flags, last_prox_options, purchase_history)
         VALUES ('p1', ?, '["no_inexistente"]', '[]', '{ruim', '[]')`,
        [tree.id]
    );
    return db;
}

test('utilitários reconhecem placeholders, JSON quebrado e codificação danificada', () => {
    assert.equal(isPlaceholder('-'), true);
    assert.equal(isPlaceholder('Magia de Fogo'), false);
    assert.equal(parseJson('{ruim').ok, false);
    assert.equal(parseJson('[]').ok, true);
    assert.equal(hasEncodingDamage('Corromp?do'), true);
});

test('auditoria encontra inconsistências sem alterar o banco', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const beforePlayers = await db.get('SELECT COUNT(*) AS total FROM jogadores');
    const beforeItems = await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items');
    const report = await auditPlayerDataIntegrity(db, { databaseLabel: ':memory:' });
    const afterPlayers = await db.get('SELECT COUNT(*) AS total FROM jogadores');
    const afterItems = await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items');

    assert.equal(report.ok, true);
    assert.equal(report.readOnly, true);
    assert.equal(beforePlayers.total, afterPlayers.total);
    assert.equal(beforeItems.total, afterItems.total);

    const codes = new Set(report.issues.map((item) => item.code));
    for (const code of [
        'profile_required_missing',
        'hook_missing',
        'extra_stories_invalid_json',
        'trait_label_key_mismatch',
        'successful_trait_not_chosen',
        'profile_text_encoding',
        'item_durability_above_max',
        'nonduplicable_item_duplicated',
        'orphan_inventory_item',
        'item_properties_json_invalid',
        'owned_node_unknown',
        'legacy_node_unknown',
        'legacy_last_prox_options_invalid',
    ]) {
        assert.equal(codes.has(code), true, `Código ausente: ${code}`);
    }
    assert.ok(report.summary.bySeverity.critical >= 3);
    assert.ok(report.summary.playersWithIssues >= 2);
});

test('jogador arquivado fica fora por padrão e pode ser incluído explicitamente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, ficha_status, jogo_status)
         VALUES ('arquivado', 'Antigo', 'aprovada', 'arquivado')`
    );

    const defaultReport = await auditPlayerDataIntegrity(db);
    const fullReport = await auditPlayerDataIntegrity(db, { includeArchived: true });
    assert.equal(defaultReport.summary.playersScanned, 2);
    assert.equal(fullReport.summary.playersScanned, 3);
});
