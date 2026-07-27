'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureCloverEconomySchema } = require('../database');
const { assignAccessRole, ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    simulateAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const { reserveInventoryItemInTransaction } = require('../helpers/clover/inventoryService');
const { createItemTemplate, getItemTemplateForAdmin, grantItemCopies } = require('../helpers/clover/itemAdminService');

const ACTOR = '551199990001@s.whatsapp.net';
const PLAYER = '551199990002@s.whatsapp.net';
const actor = { id: ACTOR, role: 'admin' };

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado',
            esquadrao TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        );
    `);
    await db.run('INSERT INTO jogadores (id, personagem_nome, dinheiro, canonical_player_id) VALUES (?, ?, 1000, ?)', [ACTOR, 'Narrador', ACTOR]);
    await db.run('INSERT INTO jogadores (id, personagem_nome, dinheiro, canonical_player_id) VALUES (?, ?, 1000, ?)', [PLAYER, 'Jogador', PLAYER]);
    await ensureCloverEconomySchema(db);
    await ensureAccessControlSchema(db);
    await assignAccessRole(db, {
        subjectId: ACTOR,
        role: 'admin',
        assignedBy: ACTOR,
        reason: 'teste',
    });
    return db;
}

async function runOperation(db, action, idempotencyKey) {
    const created = await createAdminOperation(db, {
        title: `Operacao ${action.type}`,
        reason: 'Validacao de executor administrativo de item.',
        targets: [{ kind: 'player', playerId: PLAYER }],
        actions: [action],
        idempotencyKey,
    }, actor);
    await simulateAdminOperation(db, created.operation.code, actor, { executors: getAdminOperationExecutors() });
    await approveAdminOperation(db, created.operation.code, actor);
    return applyAdminOperation(db, created.operation.code, actor, { executors: getAdminOperationExecutors() });
}

async function createStackableTemplate(db, key = 'cristal_vivo') {
    return createItemTemplate(db, ACTOR, {
        templateKey: key,
        itemName: key.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '),
        description: 'Material de teste.',
        category: 'material',
        basePrice: 500,
        stackable: true,
        transferable: true,
        marketable: true,
        duplicable: true,
    });
}

async function createSeparateTemplate(db, key = 'lamina_teste') {
    return createItemTemplate(db, ACTOR, {
        templateKey: key,
        itemName: key.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' '),
        description: 'Equipamento de teste.',
        category: 'equipamento',
        basePrice: 900,
        defaultQuality: 'comum',
        defaultDurability: 5,
        stackable: false,
        transferable: true,
        marketable: true,
        duplicable: true,
        conditionDescriptions: {
            integro: 'Integro.',
            desgastado: 'Desgastado.',
            danificado: 'Danificado.',
            quebrado: 'Quebrado.',
        },
    });
}

async function inventoryRows(db, templateKey) {
    return db.all(
        'SELECT * FROM clover_inventory_items WHERE player_id = ? AND template_key = ? ORDER BY id ASC',
        [PLAYER, templateKey]
    );
}

async function runGrantOperation(db, templateKey, quantity, key) {
    return runOperation(db, {
        type: 'player.item.grant',
        payload: { templateKey, quantity },
    }, key);
}

test('OP de catalogo cria, edita, arquiva, restaura e desfaz item customizado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await runOperation(db, {
        type: 'catalog.item.create',
        payload: {
            templateKey: 'flor_lunar',
            itemName: 'Flor Lunar',
            description: 'Ingrediente colhido a noite.',
            category: 'material',
            basePrice: 1200,
            stackable: true,
            transferable: true,
            marketable: true,
            duplicable: true,
        },
    }, 'op:item:create:flor-lunar');
    assert.equal(created.operation.status, 'applied');
    assert.equal((await getItemTemplateForAdmin(db, 'custom_flor_lunar')).itemName, 'Flor Lunar');

    const updated = await runOperation(db, {
        type: 'catalog.item.update',
        payload: {
            templateKey: 'custom_flor_lunar',
            itemName: 'Flor Lunar',
            description: 'Ingrediente revisado.',
            category: 'material',
            basePrice: 1500,
            stackable: true,
            transferable: true,
            marketable: true,
            duplicable: true,
        },
    }, 'op:item:update:flor-lunar');
    assert.equal(updated.operation.status, 'applied');
    assert.equal((await getItemTemplateForAdmin(db, 'custom_flor_lunar')).catalogVersion, 2);

    const archived = await runOperation(db, {
        type: 'catalog.item.archive',
        payload: { templateKey: 'custom_flor_lunar' },
    }, 'op:item:archive:flor-lunar');
    assert.equal((await getItemTemplateForAdmin(db, 'custom_flor_lunar')).active, false);

    const restored = await runOperation(db, {
        type: 'catalog.item.restore',
        payload: { templateKey: 'custom_flor_lunar' },
    }, 'op:item:restore:flor-lunar');
    assert.equal((await getItemTemplateForAdmin(db, 'custom_flor_lunar')).active, true);

    await undoAdminOperation(db, restored.operation.code, actor, { executors: getAdminOperationExecutors() });
    assert.equal((await getItemTemplateForAdmin(db, 'custom_flor_lunar')).active, false);

    await undoAdminOperation(db, archived.operation.code, actor, { executors: getAdminOperationExecutors() });
    assert.equal((await getItemTemplateForAdmin(db, 'custom_flor_lunar')).active, true);
});

test('undo de create de modelo bloqueia edicao externa posterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const applied = await runOperation(db, {
        type: 'catalog.item.create',
        payload: {
            templateKey: 'orvalho_celeste',
            itemName: 'Orvalho Celeste',
            description: 'Ingrediente criado por operação.',
            category: 'material',
            basePrice: 600,
            stackable: true,
            transferable: true,
            marketable: true,
            duplicable: true,
        },
    }, 'op:item:create:orvalho-celeste');
    await db.run(
        "UPDATE clover_item_templates SET description = 'Edição externa posterior.', updated_at = CURRENT_TIMESTAMP WHERE template_key = ?",
        ['custom_orvalho_celeste']
    );

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_template_changed_since_apply' }
    );
    assert.equal((await getItemTemplateForAdmin(db, 'custom_orvalho_celeste')).description, 'Edição externa posterior.');
});

test('OP player.item.grant aplica dentro do motor, e repeticao nao duplica entrega', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db);

    const applied = await runGrantOperation(db, template.template.key, 3, 'op:item:grant:cristal-vivo');
    const repeated = await applyAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() });
    const row = await db.get(
        'SELECT quantity FROM clover_inventory_items WHERE player_id = ? AND template_key = ?',
        [PLAYER, template.template.key]
    );
    assert.equal(applied.operation.status, 'applied');
    assert.equal(repeated.duplicate, true);
    assert.equal(row.quantity, 3);

    await undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() });
    const remaining = await db.get(
        'SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ? AND template_key = ?',
        [PLAYER, template.template.key]
    );
    assert.equal(remaining.total, 0);
});

test('undo de concessao empilhada preexistente restaura exatamente a quantidade anterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'po_estelar');
    await grantItemCopies(db, ACTOR, PLAYER, template.template.key, 5, { idempotencyKey: 'pre:po-estelar' });
    const applied = await runGrantOperation(db, template.template.key, 3, 'op:item:grant:po-estelar');
    assert.equal((await inventoryRows(db, template.template.key))[0].quantity, 8);

    await undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() });
    const rows = await inventoryRows(db, template.template.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quantity, 5);
});

test('undo de concessao bloqueia consumo posterior e preserva quantidade atual', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'sal_arcano');
    await grantItemCopies(db, ACTOR, PLAYER, template.template.key, 5, { idempotencyKey: 'pre:sal-arcano' });
    const applied = await runGrantOperation(db, template.template.key, 3, 'op:item:grant:sal-arcano');
    const row = (await inventoryRows(db, template.template.key))[0];
    await db.run('UPDATE clover_inventory_items SET quantity = 6, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_grant_consumed' }
    );
    assert.equal((await inventoryRows(db, template.template.key))[0].quantity, 6);
});

test('undo de concessao bloqueia nova adicao posterior ao mesmo item', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'gema_solar');
    const applied = await runGrantOperation(db, template.template.key, 3, 'op:item:grant:gema-solar');
    await grantItemCopies(db, ACTOR, PLAYER, template.template.key, 2, { idempotencyKey: 'later:gema-solar' });

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_grant_history_changed' }
    );
});

test('undo de concessao bloqueia item reservado posteriormente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'semente_luz');
    const applied = await runGrantOperation(db, template.template.key, 3, 'op:item:grant:semente-luz');
    const row = (await inventoryRows(db, template.template.key))[0];
    await reserveInventoryItemInTransaction(db, PLAYER, row.id, 1, {
        reservationKey: 'reservation:semente-luz',
        sourceType: 'test',
        sourceId: 'undo-block',
        createdBy: ACTOR,
    });

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_grant_reserved' }
    );
});

test('undo de concessao bloqueia exemplar separado modificado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createSeparateTemplate(db, 'lamina_lunar');
    const applied = await runGrantOperation(db, template.template.key, 1, 'op:item:grant:lamina-lunar');
    const row = (await inventoryRows(db, template.template.key))[0];
    await db.run(
        "UPDATE clover_inventory_items SET durability_current = 4, status = 'desgastado', metadata_json = ? WHERE id = ?",
        [JSON.stringify({ altered: true }), row.id]
    );

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_grant_changed_since_apply' }
    );
});

test('undo de concessao remove somente exemplar novo intacto', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createSeparateTemplate(db, 'anel_lunar');
    await grantItemCopies(db, ACTOR, PLAYER, template.template.key, 1, { idempotencyKey: 'pre:anel-lunar' });
    const beforeRows = await inventoryRows(db, template.template.key);
    const applied = await runGrantOperation(db, template.template.key, 1, 'op:item:grant:anel-lunar');
    assert.equal((await inventoryRows(db, template.template.key)).length, 2);

    await undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() });
    const rows = await inventoryRows(db, template.template.key);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, beforeRows[0].id);
});

test('undo de update de modelo bloqueia edicao externa posterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'flor_sombra');
    const applied = await runOperation(db, {
        type: 'catalog.item.update',
        payload: {
            templateKey: template.template.key,
            itemName: 'Flor Sombra',
            description: 'Descricao revisada.',
            category: 'material',
            basePrice: 700,
            stackable: true,
            transferable: true,
            marketable: true,
            duplicable: true,
        },
    }, 'op:item:update:flor-sombra');
    await db.run(
        "UPDATE clover_item_templates SET description = 'Edicao externa.', updated_at = CURRENT_TIMESTAMP WHERE template_key = ?",
        [template.template.key]
    );

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_template_changed_since_apply' }
    );
    assert.equal((await getItemTemplateForAdmin(db, template.template.key)).description, 'Edicao externa.');
});

test('undo de archive de modelo bloqueia restauracao ou edicao externa posterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'folha_prata');
    const applied = await runOperation(db, {
        type: 'catalog.item.archive',
        payload: { templateKey: template.template.key },
    }, 'op:item:archive:folha-prata');
    await db.run(
        "UPDATE clover_item_templates SET active = 1, description = 'Restauracao externa.', archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE template_key = ?",
        [template.template.key]
    );

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_template_changed_since_apply' }
    );
    assert.equal((await getItemTemplateForAdmin(db, template.template.key)).description, 'Restauracao externa.');
});

test('undo de restore de modelo bloqueia edicao externa posterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'raiz_aurora');
    await db.run(
        "UPDATE clover_item_templates SET active = 0, requestable = 0, archived_at = CURRENT_TIMESTAMP WHERE template_key = ?",
        [template.template.key]
    );
    const applied = await runOperation(db, {
        type: 'catalog.item.restore',
        payload: { templateKey: template.template.key },
    }, 'op:item:restore:raiz-aurora');
    await db.run(
        "UPDATE clover_item_templates SET base_price = 1300, updated_at = CURRENT_TIMESTAMP WHERE template_key = ?",
        [template.template.key]
    );

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors: getAdminOperationExecutors() }),
        { code: 'item_template_changed_since_apply' }
    );
    assert.equal((await getItemTemplateForAdmin(db, template.template.key)).basePrice, 1300);
});

test('grantItemCopies standalone preserva transacao propria', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const template = await createStackableTemplate(db, 'fragmento_ceu');
    const result = await grantItemCopies(db, ACTOR, PLAYER, template.template.key, 2, {
        idempotencyKey: 'standalone:fragmento-ceu',
    });
    const duplicate = await grantItemCopies(db, ACTOR, PLAYER, template.template.key, 2, {
        idempotencyKey: 'standalone:fragmento-ceu',
    });

    assert.equal(result.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await inventoryRows(db, template.template.key))[0].quantity, 2);
});
