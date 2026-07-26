'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditLegacyInventoryItems } = require('../helpers/clover/legacyInventoryAuditService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT
        );
        CREATE TABLE clover_item_templates (
            template_key TEXT PRIMARY KEY,
            item_name TEXT NOT NULL,
            description TEXT,
            category TEXT,
            kind TEXT,
            active INTEGER DEFAULT 1,
            stackable INTEGER DEFAULT 0,
            transferable INTEGER DEFAULT 0,
            properties_json TEXT DEFAULT '{}',
            effects_json TEXT DEFAULT '{}'
        );
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            description TEXT,
            quantity INTEGER DEFAULT 1,
            category TEXT,
            kind TEXT,
            source TEXT,
            related_id TEXT,
            status TEXT,
            created_at TEXT,
            origin TEXT,
            transferable INTEGER,
            template_key TEXT,
            properties_json TEXT,
            effects_json TEXT
        );
    `);
    await db.run('INSERT INTO jogadores (id, personagem_nome) VALUES (?, ?)', ['5511999999999@lid', 'Killian']);
    await db.run(
        `INSERT INTO clover_item_templates
         (template_key, item_name, description, category, kind, active, stackable, transferable)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1)`,
        ['anel_oficial', 'Anel Oficial', 'Modelo exato.', 'material', 'acessorio']
    );
    await db.run(
        `INSERT INTO clover_item_templates
         (template_key, item_name, description, category, kind, active, stackable, transferable)
         VALUES (?, ?, ?, ?, ?, 1, 1, 1)`,
        ['pocao_mana', 'Poção de Mana', 'Modelo diferente.', 'consumivel', 'consumivel_comum']
    );

    const insert = (name, description, source, relatedId, category = 'material', kind = 'acessorio') => db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, description, quantity, category, kind, source, related_id,
          status, created_at, origin, transferable, template_key, properties_json, effects_json)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'disponivel', '2026-07-26 10:00:00', 'Clover', 1, NULL, '{}', '{}')`,
        ['5511999999999@lid', name, description, category, kind, source, relatedId]
    );

    await insert('Pergaminho (parte inicial', null, 'ficha', 'same', 'material', 'narrativo');
    await insert('continuação final)', null, 'ficha', 'same', 'material', 'narrativo');
    await insert('Anel Ampliador', 'Descrição igual.', 'cloverscript', 'anel:1');
    await insert('Anel Ampliador', 'Descrição igual.', 'cloverscript', 'anel:2');
    await insert('Anel Ampliador', 'Descrição igual.', 'cloverscript', 'anel:3');
    await insert('Feitiço', 'Nome genérico.', 'evento', 'generico', 'material', 'evento');
    await insert('Poção de Mana Simples', 'Regra diferente.', 'pa_box', 'pocao', 'consumivel', 'consumivel_comum');
    await insert('Anel Oficial', 'Modelo exato.', 'evento', 'exact');
    return db;
}

test('classifica fragmentos, repetidos, genéricos e modelos existentes sem escrever', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.exec('PRAGMA query_only = ON');

    const report = await auditLegacyInventoryItems(db);

    assert.equal(report.readOnly, true);
    assert.equal(report.summary.legacyInventoryItems, 8);
    assert.equal(report.summary.fragmentPairs, 1);
    assert.equal(report.fragmentPairs[0].proposedItemName, 'Pergaminho (parte inicial continuação final)');
    assert.equal(report.repeatedGroups.some((group) => group.itemName === 'Anel Ampliador' && group.count === 3), true);

    const generic = report.items.find((item) => item.itemName === 'Feitiço');
    assert.equal(generic.classification, 'manual_specification');

    const alias = report.items.find((item) => item.itemName === 'Poção de Mana Simples');
    assert.equal(alias.classification, 'existing_template_review');
    assert.equal(alias.candidates[0].templateKey, 'pocao_mana');

    const exact = report.items.find((item) => item.itemName === 'Anel Oficial');
    assert.equal(exact.classification, 'existing_template_high');
    assert.equal(exact.candidates[0].confidence, 'high');

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('5511999999999'), false);
    assert.match(report.items[0].playerKey, /^P-[A-F0-9]{12}$/);
    await assert.rejects(
        db.run("UPDATE clover_inventory_items SET item_name = 'não pode' WHERE id = 1"),
        /readonly|read-only|attempt to write/i
    );
});
