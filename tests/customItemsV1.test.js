'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createAsyncAdapter;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createAsyncAdapter = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    Module._load = function loadSqliteFallback(request, parent, isMain) {
        if (request === 'sqlite3') return { verbose: () => ({ Database: class TestDriver {} }) };
        if (request === 'sqlite') return { open: async () => { throw new Error('open() não deve ser usado'); } };
        return originalLoad.call(this, request, parent, isMain);
    };
    createAsyncAdapter = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return { changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const { ensureCloverEconomySchema } = require('../database');
Module._load = originalLoad;

const { assignAccessRole, ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const { applyDurabilityLoss, getStructuredInventory } = require('../helpers/clover/inventoryService');
const {
    ItemAdminServiceError,
    createItemTemplate,
    grantItemCopies,
    updateItemTemplate,
} = require('../helpers/clover/itemAdminService');
const {
    cancelWeeklyNpcRequest,
    createWeeklyNpcRequest,
    listWeeklyNpcRequests,
    updateWeeklyNpcRequest,
} = require('../helpers/clover/marketService');

const NARRATOR = '551199990001@s.whatsapp.net';
const PLAYER = '551199990002@s.whatsapp.net';

async function createTestDb() {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-', personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado', esquadrao TEXT DEFAULT '-', patente TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores (id, personagem_nome, dinheiro) VALUES
            ('${NARRATOR}', 'Narrador', 10000),
            ('${PLAYER}', 'Jogador', 10000);
    `);
    await ensureCloverEconomySchema(db);
    await ensureAccessControlSchema(db);
    await assignAccessRole(db, {
        subjectId: NARRATOR,
        role: 'narrator',
        assignedBy: NARRATOR,
        reason: 'teste',
    });
    return db;
}

test('modelo empilhável gera várias unidades sem confundir modelo com exemplar', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createItemTemplate(db, NARRATOR, {
        itemName: 'Erva Solar',
        description: 'Material alquímico colhido sob mana natural.',
        category: 'material',
        basePrice: 2000,
        stackable: true,
        transferable: true,
        marketable: true,
        duplicable: true,
        requestable: true,
    });
    const granted = await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 5, { idempotencyKey: 'grant-herb-1' });
    const duplicate = await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 5, { idempotencyKey: 'grant-herb-1' });
    assert.equal(granted.items.length, 1);
    assert.equal(granted.items[0].quantity, 5);
    assert.equal(duplicate.duplicate, true);
    const rows = await db.all('SELECT * FROM clover_inventory_items WHERE player_id = ? AND template_key = ?', [PLAYER, created.template.key]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quantity, 5);
});

test('equipamento personalizado gera cópias individuais com descrição por estado', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createItemTemplate(db, NARRATOR, {
        itemName: 'Espada do Guarda',
        description: 'Espada padronizada da guarda da Capital.',
        category: 'equipamento',
        kind: 'equipamento',
        basePrice: 4000,
        defaultDurability: 5,
        stackable: false,
        transferable: true,
        marketable: true,
        duplicable: true,
        requestable: false,
        conditionDescriptions: {
            integro: 'Lâmina alinhada e pronta para uso.',
            desgastado: 'O fio apresenta marcas visíveis.',
            danificado: 'A lâmina perdeu estabilidade.',
            quebrado: 'A arma não pode ser usada até reparo.',
        },
    });
    const granted = await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 2, { idempotencyKey: 'grant-swords-1' });
    assert.equal(granted.items.length, 2);
    assert.notEqual(granted.items[0].id, granted.items[1].id);
    await applyDurabilityLoss(db, PLAYER, granted.items[0].id, 3, 'Choque direto', NARRATOR);
    await applyDurabilityLoss(db, PLAYER, granted.items[0].id, 1, 'Novo impacto', NARRATOR);
    const inventory = await getStructuredInventory(db, PLAYER);
    const damaged = inventory.find((item) => item.id === granted.items[0].id);
    assert.equal(damaged.condition, 'danificado');
    assert.equal(damaged.condition_description, 'A lâmina perdeu estabilidade.');
});

test('item único impede uma segunda cópia ativa', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createItemTemplate(db, NARRATOR, {
        itemName: 'Relíquia de Lumière',
        description: 'Relíquia narrativa de exemplar único.',
        category: 'narrativo',
        basePrice: 0,
        stackable: false,
        transferable: false,
        marketable: false,
        duplicable: false,
        requestable: false,
    });
    await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 1, { idempotencyKey: 'unique-1' });
    await assert.rejects(
        () => grantItemCopies(db, NARRATOR, NARRATOR, created.template.key, 1, { idempotencyKey: 'unique-2' }),
        (error) => error instanceof ItemAdminServiceError && error.code === 'unique_item_exists'
    );
});

test('pedido semanal usa catálogo dinâmico e permanece configurável pelo narrador', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createItemTemplate(db, NARRATOR, {
        itemName: 'Cristal de Névoa',
        description: 'Saque obtido em regiões de mana condensada.',
        category: 'material',
        basePrice: 2500,
        stackable: true,
        transferable: true,
        marketable: true,
        duplicable: true,
        requestable: true,
    });
    await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 4, { idempotencyKey: 'grant-crystal-1', source: 'raid' });
    const automatic = await listWeeklyNpcRequests(db, PLAYER, { now: new Date('2026-07-17T12:00:00Z') });
    assert.ok(automatic.some((request) => request.templateKey === created.template.key));

    await db.run('DELETE FROM clover_weekly_npc_requests');
    const manual = await createWeeklyNpcRequest(db, NARRATOR, {
        templateKey: created.template.key,
        npcName: 'Pesquisadora de Heart',
        pricePercent: 120,
        globalQuantity: 20,
        personalLimit: 5,
    }, { now: new Date('2026-07-17T12:00:00Z') });
    assert.equal(manual.request.unitPrice, 3000);
    const updated = await updateWeeklyNpcRequest(db, NARRATOR, manual.request.key, { globalQuantity: 15, personalLimit: 3, pricePercent: 100 });
    assert.equal(updated.request.globalQuantity, 15);
    assert.equal(updated.request.personalLimit, 3);
    assert.equal(updated.request.unitPrice, 2500);
    const cancelled = await cancelWeeklyNpcRequest(db, NARRATOR, manual.request.key);
    assert.equal(cancelled.request.status, 'cancelled');
});

test('editar modelo incrementa versão sem reescrever cópias já entregues', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createItemTemplate(db, NARRATOR, {
        itemName: 'Mapa Antigo', description: 'Primeira descrição.', category: 'material',
        basePrice: 1000, stackable: true, transferable: true, marketable: true, duplicable: true,
    });
    const granted = await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 1, { idempotencyKey: 'map-1' });
    const updated = await updateItemTemplate(db, NARRATOR, created.template.key, { description: 'Descrição revisada.' });
    assert.equal(updated.template.catalogVersion, 2);
    const oldCopy = await db.get('SELECT description, catalog_version FROM clover_inventory_items WHERE id = ?', [granted.items[0].id]);
    assert.equal(oldCopy.description, 'Primeira descrição.');
    assert.equal(oldCopy.catalog_version, 1);
});

test('obra-prima usa preço e durabilidade próprios sem multiplicador genérico', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createItemTemplate(db, NARRATOR, {
        itemName: 'Lâmina Única do Ferreiro',
        description: 'Obra-prima com avaliação e vida útil definidas pelo criador.',
        category: 'equipamento', kind: 'equipamento', basePrice: 12345,
        defaultQuality: 'obra-prima', defaultDurability: 11,
        stackable: false, transferable: true, marketable: true, duplicable: true,
        conditionDescriptions: {
            integro: 'Acabamento impecável.', desgastado: 'Marcas de uso.',
            danificado: 'Estrutura comprometida.', quebrado: 'Exige restauração completa.',
        },
    });
    const granted = await grantItemCopies(db, NARRATOR, PLAYER, created.template.key, 1, { idempotencyKey: 'masterpiece-1' });
    assert.equal(granted.items[0].quality, 'obra_prima');
    assert.equal(granted.items[0].reference_price, 12345);
    assert.equal(granted.items[0].durability_max, 11);
});

test('migração acrescenta o catálogo dinâmico sobre a estrutura anterior da V1', async (t) => {
    const db = await createAsyncAdapter();
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, dinheiro INTEGER DEFAULT 0);
        CREATE TABLE clover_item_templates (
            template_key TEXT PRIMARY KEY,
            catalog_version INTEGER NOT NULL DEFAULT 1,
            item_name TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            category TEXT NOT NULL,
            kind TEXT NOT NULL,
            origin TEXT DEFAULT 'Clover',
            base_price INTEGER NOT NULL DEFAULT 0,
            default_quality TEXT DEFAULT 'comum',
            default_durability INTEGER DEFAULT NULL,
            stackable INTEGER NOT NULL DEFAULT 0,
            transferable INTEGER NOT NULL DEFAULT 1,
            properties_json TEXT DEFAULT NULL,
            effects_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await ensureCloverEconomySchema(db);
    const columns = await db.all('PRAGMA table_info(clover_item_templates)');
    const names = new Set(columns.map((column) => column.name));
    for (const name of ['is_custom', 'requestable', 'marketable', 'duplicable', 'created_by', 'updated_by', 'archived_at']) {
        assert.ok(names.has(name), `coluna ausente: ${name}`);
    }
    const grants = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clover_item_grants'");
    assert.equal(grants.name, 'clover_item_grants');
});
