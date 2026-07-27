'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    applyRepairPlan,
    previewRepairPlan,
    undoRepairBatch,
} = require('../helpers/clover/legacyInventoryRepairExecutor');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            description TEXT,
            quantity INTEGER DEFAULT 1 CHECK (quantity > 0),
            kind TEXT,
            source TEXT,
            related_id TEXT,
            created_by TEXT,
            created_at TEXT,
            metadata_json TEXT,
            template_key TEXT,
            catalog_version INTEGER DEFAULT 1,
            category TEXT,
            origin TEXT,
            status TEXT,
            quality TEXT,
            base_price INTEGER,
            reference_price INTEGER,
            durability_current INTEGER,
            durability_max INTEGER,
            bound INTEGER,
            transferable INTEGER,
            equipped_slot TEXT,
            expires_at TEXT,
            updated_at TEXT,
            properties_json TEXT,
            effects_json TEXT
        );
        CREATE TABLE clover_item_templates (
            template_key TEXT PRIMARY KEY,
            catalog_version INTEGER NOT NULL DEFAULT 1,
            item_name TEXT NOT NULL,
            description TEXT,
            category TEXT NOT NULL,
            kind TEXT NOT NULL,
            origin TEXT DEFAULT 'Clover',
            base_price INTEGER NOT NULL DEFAULT 0,
            default_quality TEXT DEFAULT 'comum',
            default_durability INTEGER,
            stackable INTEGER NOT NULL DEFAULT 0,
            transferable INTEGER NOT NULL DEFAULT 1,
            properties_json TEXT,
            effects_json TEXT,
            metadata_json TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            is_custom INTEGER NOT NULL DEFAULT 0,
            requestable INTEGER NOT NULL DEFAULT 0,
            marketable INTEGER NOT NULL DEFAULT 1,
            duplicable INTEGER NOT NULL DEFAULT 1,
            created_by TEXT,
            updated_by TEXT,
            archived_at TEXT
        );
        CREATE TABLE clover_inventory_item_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER,
            player_id TEXT NOT NULL,
            action TEXT NOT NULL,
            quantity_delta INTEGER DEFAULT 0,
            durability_delta INTEGER DEFAULT 0,
            before_json TEXT,
            after_json TEXT,
            source TEXT,
            related_id TEXT,
            idempotency_key TEXT UNIQUE,
            created_by TEXT,
            created_at TEXT,
            metadata_json TEXT
        );
        CREATE TABLE clover_inventory_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_item_id INTEGER NOT NULL,
            status TEXT
        );
    `);

    const insert = async ({ id, player, name, description, category, kind, source, related, created }) => {
        await db.run(
            `INSERT INTO clover_inventory_items
             (id, player_id, item_name, description, quantity, category, kind, source, related_id,
              created_at, origin, status, quality, transferable, template_key, catalog_version,
              properties_json, effects_json)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'Clover', 'disponivel', 'comum', 1, NULL, 1, '{}', '{}')`,
            [id, player, name, description, category, kind, source, related, created]
        );
    };

    await insert({ id: 10, player: 'P1', name: 'Pergaminho do Ferreiro (Está lacrado, e, ao abri-lo', description: null, category: 'material', kind: 'narrativo', source: 'ficha_avaliacao', related: 'quick_eval:46', created: '2026-06-23 05:03:44' });
    await insert({ id: 11, player: 'P1', name: 'o personagem ficará indisponível para qualquer outra missão ou treino que queira realizar em paralelo.)', description: null, category: 'material', kind: 'narrativo', source: 'ficha_avaliacao', related: 'quick_eval:46', created: '2026-06-23 05:03:44' });
    for (const id of [32, 34, 33, 35, 37, 36]) {
        await insert({ id, player: `R${id}`, name: 'Anel Ampliador', description: 'Ao ativar o efeito do Anel Ampliador com a própria mana, o usuário recebe +10% em Poder Mágico durante 2 turnos.\nApós os 2 turnos, é necessário esperar +2 turnos para usar o efeito novamente.', category: 'material', kind: 'acessorio', source: 'cloverscript', related: 'cloverscript:18', created: '2026-07-06 06:31:06' });
    }
    await insert({ id: 57, player: 'P2', name: 'Poção de Mana Simples', description: 'Consumível comum. Ajuda na recuperação leve de mana fora de combate; não restaura tudo nem substitui descanso.', category: 'consumivel', kind: 'consumivel_comum', source: 'pa_box', related: 'pa_box:1', created: '2026-07-21 19:01:03' });
    await insert({ id: 293, player: 'P3', name: 'Caixa Simples de Serviço', description: 'Caixa selada adquirida na Loja de PA. Contém recompensa narrativa leve ou consumível comum, definida no momento da abertura.', category: 'caixa', kind: 'caixa_pa', source: 'pa_shop', related: 'pa_shop:9', created: '2026-07-25 20:13:03' });
    return db;
}

function template(templateKey, itemName, description, category, kind) {
    return {
        templateKey,
        itemName,
        description,
        category,
        kind,
        origin: 'Clover',
        transferable: 1,
        properties: {},
        effects: {},
    };
}

function repairPlan() {
    return {
        generatedAt: 'ignored-by-semantic-hash',
        mode: 'dry-run',
        writesPerformed: false,
        readyForManualApproval: [
            {
                operation: 'inventory.legacy.merge_fragments.propose',
                confidence: 'high',
                inventoryItemIds: [10, 11],
                keepInventoryItemId: 10,
                removeInventoryItemId: 11,
                proposedItemName: 'Pergaminho do Ferreiro',
                proposedDescription: 'Está lacrado, e, ao abri-lo o personagem ficará indisponível para qualquer outra missão ou treino que queira realizar em paralelo.',
                proposedTemplate: template('pergaminho_do_ferreiro', 'Pergaminho do Ferreiro', 'Está lacrado, e, ao abri-lo o personagem ficará indisponível para qualquer outra missão ou treino que queira realizar em paralelo.', 'material', 'narrativo'),
                requiresManualApproval: true,
            },
            {
                operation: 'inventory.template.create_and_link.propose',
                confidence: 'high',
                inventoryItemIds: [32, 34, 33, 35, 37, 36],
                proposedTemplate: template('anel_ampliador', 'Anel Ampliador', 'Ao ativar o efeito do Anel Ampliador com a própria mana, o usuário recebe +10% em Poder Mágico durante 2 turnos.\nApós os 2 turnos, é necessário esperar +2 turnos para usar o efeito novamente.', 'material', 'acessorio'),
                requiresManualApproval: true,
            },
            {
                operation: 'inventory.template.create_and_link.propose',
                confidence: 'high',
                inventoryItemIds: [57],
                proposedTemplate: template('pocao_de_mana_simples', 'Poção de Mana Simples', 'Consumível comum. Ajuda na recuperação leve de mana fora de combate; não restaura tudo nem substitui descanso.', 'consumivel', 'consumivel_comum'),
                requiresManualApproval: true,
            },
            {
                operation: 'inventory.template.create_and_link.propose',
                confidence: 'high',
                inventoryItemIds: [293],
                proposedTemplate: template('caixa_simples_de_servico', 'Caixa Simples de Serviço', 'Caixa selada adquirida na Loja de PA. Contém recompensa narrativa leve ou consumível comum, definida no momento da abertura.', 'caixa', 'caixa_pa'),
                requiresManualApproval: true,
            },
        ],
    };
}

async function targetSnapshot(db) {
    const items = await db.all('SELECT * FROM clover_inventory_items ORDER BY id');
    const templates = await db.all('SELECT * FROM clover_item_templates ORDER BY template_key');
    return { items, templates };
}

test('pré-visualiza, aplica atomicamente e desfaz restaurando os dados', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = repairPlan();
    const before = await targetSnapshot(db);

    const preview = await previewRepairPlan(db, plan);
    assert.equal(preview.writesPerformed, false);
    assert.deepEqual(preview.summary, {
        proposals: 4,
        inventoryItemsCovered: 10,
        templatesToCreate: 4,
    });
    assert.deepEqual(await targetSnapshot(db), before);

    const applied = await applyRepairPlan(db, plan, {
        confirm: 'APPLY',
        repairCode: 'LIR-TEST-01',
        actorId: 'test',
        timestamp: '2026-07-26T18:00:00.000Z',
    });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.units.length, 4);
    assert.equal(await db.get('SELECT id FROM clover_inventory_items WHERE id = 11'), undefined);
    assert.equal((await db.get('SELECT template_key FROM clover_inventory_items WHERE id = 10')).template_key, 'pergaminho_do_ferreiro');
    assert.equal(Number((await db.get("SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key IS NULL OR TRIM(template_key) = ''")).total), 0);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_item_templates')).total), 4);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_item_history')).total), 10);

    const duplicate = await applyRepairPlan(db, { ...plan, generatedAt: 'another-time' }, {
        confirm: 'APPLY',
        repairCode: 'LIR-TEST-01',
        actorId: 'test',
    });
    assert.equal(duplicate.duplicate, true);

    const undone = await undoRepairBatch(db, {
        confirm: 'UNDO',
        repairCode: 'LIR-TEST-01',
        actorId: 'test',
        timestamp: '2026-07-26T18:01:00.000Z',
    });
    assert.equal(undone.status, 'undone');
    assert.deepEqual(await targetSnapshot(db), before);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_item_history')).total), 20);
    assert.equal((await db.get('SELECT status FROM clover_legacy_inventory_repair_batches WHERE repair_code = ?', ['LIR-TEST-01'])).status, 'undone');
});

test('exige confirmações literais', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await assert.rejects(() => applyRepairPlan(db, repairPlan(), {}), { code: 'apply_confirmation_required' });
    await assert.rejects(() => undoRepairBatch(db, { repairCode: 'LIR-NOT-THERE' }), { code: 'undo_confirmation_required' });
});

test('bloqueia remoção de fragmento com dependência', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await db.run('INSERT INTO clover_inventory_reservations (inventory_item_id, status) VALUES (11, ?)', ['active']);
    await assert.rejects(() => previewRepairPlan(db, repairPlan()), { code: 'fragment_has_dependencies' });
    assert.ok(await db.get('SELECT id FROM clover_inventory_items WHERE id = 11'));
});
