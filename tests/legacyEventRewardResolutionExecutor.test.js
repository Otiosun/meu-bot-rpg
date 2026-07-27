'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    buildResolutionPlan,
} = require('../helpers/clover/legacyEventRewardResolutionService');
const {
    applyResolutionPlan,
    previewResolutionPlan,
    undoResolutionBatch,
    verifyResolvedPlan,
} = require('../helpers/clover/legacyEventRewardResolutionExecutor');
const {
    isPendingReward,
    specialCategory,
} = require('../helpers/clover/possessionsService');

const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'inventory', 'legacy-event-reward-resolutions-v1.json'),
    'utf8'
));
const source = 'eventos_acumulados_20260618';
const examDescription = 'Recompensa do exame completo.';
const navalDescription = 'Recompensa de evento separado / Batalha Naval.';

function fixtureItem(id, playerId, characterName, relatedId, itemName, description, quantity = 1) {
    return {
        id,
        playerId,
        characterName,
        relatedId,
        source,
        templateKey: null,
        itemName,
        description,
        quantity,
        category: 'material',
        kind: 'evento',
        origin: 'Clover',
        status: 'disponivel',
        transferable: 1,
        properties: {},
        effects: {},
    };
}

function fixtureItems() {
    return [
        fixtureItem(5, 'p-emil', 'Emil', `${source}:emil:item:1`, 'Feitiço', examDescription),
        fixtureItem(4, 'p-maksim', 'Maksim Faust', `${source}:maksim:item:1`, 'Feitiço', examDescription),
        fixtureItem(2, 'p-caelus', 'Caelus Apicius', `${source}:caelus:item:1`, 'Dungeon exclusiva', examDescription, 2),
        fixtureItem(6, 'p-zahir', 'Zahir Al-Nur', `${source}:zahir:item:1`, 'Dungeon exclusiva', examDescription),
        fixtureItem(8, 'p-nero', 'Nero Shirasagi', `${source}:nero:item:1`, 'Dungeon exclusiva', navalDescription),
        fixtureItem(3, 'p-caelus', 'Caelus Apicius', `${source}:caelus:item:2`, 'Item mágico', examDescription),
        fixtureItem(9, 'p-nero', 'Nero Shirasagi', `${source}:nero:item:2`, 'Item mágico', navalDescription),
        fixtureItem(7, 'p-zahir', 'Zahir Al-Nur', `${source}:zahir:item:2`, 'Pedra misteriosa de 12cm', examDescription),
    ];
}

function dungeonTemplateObject() {
    return {
        templateKey: 'acesso_dungeon_exclusiva',
        itemName: 'Passe da Dungeon Exclusiva',
        description: 'Passe pessoal guardado no inventário. Garante uma vaga na Dungeon Exclusiva do evento e não pode ser vendido, anunciado, trocado ou transferido.',
        category: 'missao',
        kind: 'acesso_dungeon',
        origin: 'Clover',
        transferable: 0,
        properties: {
            eventAccess: 'dungeon_exclusiva',
            bound: true,
            sellable: false,
            tradable: false,
        },
        effects: {},
    };
}

function buildPlan() {
    return buildResolutionPlan(manifest, fixtureItems(), [dungeonTemplateObject()]);
}

async function createDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-event-rewards-'));
    const filename = path.join(directory, 'test.sqlite');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            display_name TEXT
        );
        CREATE TABLE clover_item_templates (
            template_key TEXT PRIMARY KEY,
            catalog_version INTEGER,
            item_name TEXT,
            description TEXT,
            category TEXT,
            kind TEXT,
            origin TEXT,
            base_price INTEGER,
            default_quality TEXT,
            default_durability INTEGER,
            stackable INTEGER,
            transferable INTEGER,
            properties_json TEXT,
            effects_json TEXT,
            metadata_json TEXT,
            active INTEGER,
            is_custom INTEGER,
            requestable INTEGER,
            marketable INTEGER,
            duplicable INTEGER,
            created_by TEXT,
            updated_by TEXT,
            created_at TEXT,
            updated_at TEXT,
            archived_at TEXT
        );
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            item_name TEXT,
            description TEXT,
            quantity INTEGER,
            kind TEXT,
            source TEXT,
            related_id TEXT,
            created_by TEXT,
            created_at TEXT,
            metadata_json TEXT,
            template_key TEXT,
            catalog_version INTEGER,
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
        CREATE TABLE clover_inventory_item_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id INTEGER,
            player_id TEXT,
            action TEXT,
            quantity_delta INTEGER,
            durability_delta INTEGER,
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
            inventory_item_id INTEGER,
            status TEXT
        );
    `);

    for (const item of fixtureItems()) {
        await db.run(
            'INSERT INTO jogadores (id, personagem_nome, nome, display_name) VALUES (?, ?, ?, ?)',
            [item.playerId, item.characterName, item.characterName, item.characterName]
        ).catch(() => null);
        await db.run(
            `INSERT INTO clover_inventory_items (
                id, player_id, item_name, description, quantity, kind, source, related_id,
                created_by, created_at, metadata_json, template_key, catalog_version,
                category, origin, status, quality, base_price, reference_price,
                durability_current, durability_max, bound, transferable, equipped_slot,
                expires_at, updated_at, properties_json, effects_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy-import', '2026-06-18 06:59:27', ?, NULL, 1,
                       ?, ?, ?, 'comum', 0, 0, NULL, NULL, 0, ?, NULL, NULL,
                       '2026-06-18 06:59:27', '{}', '{}')`,
            [
                item.id,
                item.playerId,
                item.itemName,
                item.description,
                item.quantity,
                item.kind,
                item.source,
                item.relatedId,
                JSON.stringify({ imported: true }),
                item.category,
                item.origin,
                item.status,
                item.transferable,
            ]
        );
    }

    const dungeon = dungeonTemplateObject();
    await db.run(
        `INSERT INTO clover_item_templates (
            template_key, catalog_version, item_name, description, category, kind, origin,
            base_price, default_quality, default_durability, stackable, transferable,
            properties_json, effects_json, metadata_json, active, is_custom, requestable,
            marketable, duplicable, created_by, updated_by, created_at, updated_at, archived_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, 0, 'comum', NULL, 1, ?, ?, '{}', '{}',
                   1, 0, 0, 0, 1, 'system', 'system', '2026-07-01', '2026-07-01', NULL)`,
        [
            dungeon.templateKey,
            dungeon.itemName,
            dungeon.description,
            dungeon.category,
            dungeon.kind,
            dungeon.origin,
            dungeon.transferable,
            JSON.stringify(dungeon.properties),
        ]
    );
    return { db, directory, filename };
}

async function rawInventoryRows(db) {
    return db.all('SELECT * FROM clover_inventory_items ORDER BY id ASC');
}

async function closeFixture(fixture) {
    await fixture.db.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test('preview valida oito linhas sem criar schema ou escrever', async () => {
    const fixture = await createDatabase();
    try {
        const before = await rawInventoryRows(fixture.db);
        const result = await previewResolutionPlan(fixture.db, buildPlan());
        const after = await rawInventoryRows(fixture.db);
        const schema = await fixture.db.get(
            "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name='clover_legacy_event_reward_batches'"
        );
        assert.equal(result.summary.actions, 8);
        assert.equal(result.summary.inventoryUnits, 9);
        assert.equal(result.summary.dungeonAccessUnits, 4);
        assert.equal(result.summary.pendingRewards, 5);
        assert.equal(result.summary.templatesToCreate, 4);
        assert.deepEqual(after, before);
        assert.equal(Number(schema.total), 0);
    } finally {
        await closeFixture(fixture);
    }
});

test('apply atualiza oito linhas, cria quatro modelos e verify confirma nove unidades', async () => {
    const fixture = await createDatabase();
    try {
        const result = await applyResolutionPlan(fixture.db, buildPlan(), {
            confirm: 'APPLY-LEGACY-EVENT-REWARDS',
            resolutionCode: 'LER-TEST-APPLY',
            actorId: 'test',
            timestamp: '2026-07-27T03:00:00.000Z',
        });
        assert.equal(result.updatedRows, 8);
        assert.equal(result.updatedUnits, 9);
        assert.equal(result.createdTemplates.length, 4);

        const verified = await verifyResolvedPlan(fixture.db, buildPlan());
        assert.equal(verified.verifiedRows, 8);
        assert.equal(verified.verifiedUnits, 9);
        assert.equal(verified.dungeonAccessUnits, 4);
        assert.equal(verified.pendingRewardRows, 5);

        const caelus = await fixture.db.get('SELECT * FROM clover_inventory_items WHERE id = 2');
        assert.equal(caelus.quantity, 2);
        assert.equal(caelus.template_key, 'acesso_dungeon_exclusiva');
        assert.equal(caelus.item_name, 'Passe da Dungeon Exclusiva');
        assert.equal(caelus.kind, 'acesso_dungeon');
        assert.equal(caelus.bound, 1);
        assert.equal(caelus.transferable, 0);

        const spell = await fixture.db.get('SELECT * FROM clover_inventory_items WHERE id = 5');
        assert.equal(spell.kind, 'direito_feitico_pendente');
        assert.equal(JSON.parse(spell.properties_json).automaticEffect, false);
        assert.deepEqual(JSON.parse(spell.effects_json), {});
        assert.match(spell.description, /não equivale a Ticket de Feitiço/i);
    } finally {
        await closeFixture(fixture);
    }
});

test('recompensas pendentes aparecem como pendentes e não como item utilizável', () => {
    const item = {
        category: 'recompensa',
        kind: 'direito_item_magico_pendente',
        properties: { specificationStatus: 'pending' },
        useAction: null,
    };
    assert.equal(isPendingReward(item), true);
    assert.equal(specialCategory(item), 'pending_reward');
});

test('undo restaura exatamente as oito linhas e remove os quatro modelos criados', async () => {
    const fixture = await createDatabase();
    try {
        const beforeRows = await rawInventoryRows(fixture.db);
        const dungeonBefore = await fixture.db.get(
            "SELECT * FROM clover_item_templates WHERE template_key='acesso_dungeon_exclusiva'"
        );
        await applyResolutionPlan(fixture.db, buildPlan(), {
            confirm: 'APPLY-LEGACY-EVENT-REWARDS',
            resolutionCode: 'LER-TEST-UNDO',
            actorId: 'test',
            timestamp: '2026-07-27T03:00:00.000Z',
        });
        const undone = await undoResolutionBatch(fixture.db, {
            confirm: 'UNDO-LEGACY-EVENT-REWARDS',
            resolutionCode: 'LER-TEST-UNDO',
            actorId: 'test',
            timestamp: '2026-07-27T03:05:00.000Z',
        });
        assert.equal(undone.restoredRows, 8);
        assert.equal(undone.removedTemplates, 4);
        assert.deepEqual(await rawInventoryRows(fixture.db), beforeRows);
        assert.deepEqual(
            await fixture.db.get("SELECT * FROM clover_item_templates WHERE template_key='acesso_dungeon_exclusiva'"),
            dungeonBefore
        );
        const customTemplates = await fixture.db.get(
            "SELECT COUNT(*) AS total FROM clover_item_templates WHERE created_by='legacy_event_reward_resolution'"
        );
        assert.equal(Number(customTemplates.total), 0);
    } finally {
        await closeFixture(fixture);
    }
});

test('divergência ou dependência ativa bloqueia todo o lote antes de escrever', async () => {
    const staleFixture = await createDatabase();
    try {
        await staleFixture.db.run('UPDATE clover_inventory_items SET quantity = 2 WHERE id = 5');
        await assert.rejects(
            applyResolutionPlan(staleFixture.db, buildPlan(), {
                confirm: 'APPLY-LEGACY-EVENT-REWARDS',
                resolutionCode: 'LER-TEST-STALE',
            }),
            (error) => error?.code === 'stale_resolution_item'
        );
        const templates = await staleFixture.db.get(
            "SELECT COUNT(*) AS total FROM clover_item_templates WHERE created_by='legacy_event_reward_resolution'"
        );
        assert.equal(Number(templates.total), 0);
    } finally {
        await closeFixture(staleFixture);
    }

    const dependencyFixture = await createDatabase();
    try {
        await dependencyFixture.db.run(
            "INSERT INTO clover_inventory_reservations (inventory_item_id, status) VALUES (5, 'active')"
        );
        await assert.rejects(
            applyResolutionPlan(dependencyFixture.db, buildPlan(), {
                confirm: 'APPLY-LEGACY-EVENT-REWARDS',
                resolutionCode: 'LER-TEST-DEPENDENCY',
            }),
            (error) => error?.code === 'active_item_dependency'
        );
        assert.equal(
            (await dependencyFixture.db.get('SELECT template_key FROM clover_inventory_items WHERE id = 5')).template_key,
            null
        );
    } finally {
        await closeFixture(dependencyFixture);
    }
});

test('segunda aplicação idêntica é idempotente e não cria novo histórico', async () => {
    const fixture = await createDatabase();
    try {
        const options = {
            confirm: 'APPLY-LEGACY-EVENT-REWARDS',
            resolutionCode: 'LER-TEST-IDEMPOTENT',
            actorId: 'test',
            timestamp: '2026-07-27T03:00:00.000Z',
        };
        await applyResolutionPlan(fixture.db, buildPlan(), options);
        const historyBefore = Number((await fixture.db.get(
            "SELECT COUNT(*) AS total FROM clover_inventory_item_history WHERE related_id='LER-TEST-IDEMPOTENT'"
        )).total);
        const duplicate = await applyResolutionPlan(fixture.db, buildPlan(), options);
        const historyAfter = Number((await fixture.db.get(
            "SELECT COUNT(*) AS total FROM clover_inventory_item_history WHERE related_id='LER-TEST-IDEMPOTENT'"
        )).total);
        assert.equal(duplicate.duplicate, true);
        assert.equal(historyAfter, historyBefore);
    } finally {
        await closeFixture(fixture);
    }
});

test('undo é bloqueado se uma linha resolvida mudar depois da aplicação', async () => {
    const fixture = await createDatabase();
    try {
        await applyResolutionPlan(fixture.db, buildPlan(), {
            confirm: 'APPLY-LEGACY-EVENT-REWARDS',
            resolutionCode: 'LER-TEST-UNDO-STALE',
            actorId: 'test',
            timestamp: '2026-07-27T03:00:00.000Z',
        });
        await fixture.db.run('UPDATE clover_inventory_items SET quantity = 3 WHERE id = 2');
        await assert.rejects(
            undoResolutionBatch(fixture.db, {
                confirm: 'UNDO-LEGACY-EVENT-REWARDS',
                resolutionCode: 'LER-TEST-UNDO-STALE',
            }),
            (error) => error?.code === 'resolved_item_changed_before_undo'
        );
        const batch = await fixture.db.get(
            "SELECT status FROM clover_legacy_event_reward_batches WHERE resolution_code='LER-TEST-UNDO-STALE'"
        );
        assert.equal(batch.status, 'applied');
        assert.equal(
            (await fixture.db.get('SELECT quantity FROM clover_inventory_items WHERE id = 2')).quantity,
            3
        );
    } finally {
        await closeFixture(fixture);
    }
});
