'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createBoxCatalogVersionExecutors,
} = require('../helpers/clover/adminBoxCatalogVersionService');
const {
    createDraftBoxCatalogVersion,
    getActiveBoxCatalogVersion,
    sourceSnapshot,
} = require('../helpers/clover/boxCatalogVersionService');
const { ensureBoxPitySchema } = require('../helpers/clover/boxPityStateService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_box_openings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            box_key TEXT NOT NULL,
            catalog_version INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed'
        );
        CREATE TABLE clover_seasonal_relic_ownership (
            relic_key TEXT PRIMARY KEY,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER,
            box_opening_id INTEGER NOT NULL UNIQUE,
            claimed_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT
        );
    `);
    await ensureBoxPitySchema(db);
    return db;
}

function sourceInput(boxKey) {
    const source = sourceSnapshot(boxKey);
    return {
        boxKey,
        catalog: JSON.parse(JSON.stringify(source.catalog)),
        pityPolicy: JSON.parse(JSON.stringify(source.policy)),
    };
}

function ctx(db, action, before, after) {
    return {
        db,
        operation: { actor: { id: 'admin-1' }, reason: 'teste de catálogo' },
        action,
        target: { kind: 'system', systemKey: 'clover' },
        before,
        after,
    };
}

test('create executor previews, creates immutable draft and undo removes unused draft', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const input = sourceInput('simples');
    input.pityPolicy.quality.hardAtOpening = 13;
    const executor = createBoxCatalogVersionExecutors()['system.box.catalog.version.create'];
    const action = { type: 'system.box.catalog.version.create', payload: input };
    const preview = await executor.preview(ctx(db, action));
    assert.equal(preview.after.version, 4);
    assert.equal(preview.after.status, 'draft');

    const applied = await executor.apply(ctx(db, action, preview.before, preview.after));
    assert.equal(applied.after.version, 4);
    assert.equal(applied.after.status, 'draft');
    assert.equal((await getActiveBoxCatalogVersion(db, 'simples')).version, 3);

    await executor.undo(ctx(db, action, preview.before, applied.after));
    const row = await db.get("SELECT * FROM clover_box_catalog_versions WHERE box_key='simples' AND version=4");
    assert.equal(row, undefined);
});

test('activate executor switches runtime version and undo restores previous version while unused', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const input = sourceInput('simples');
    input.pityPolicy.quality.hardAtOpening = 13;
    const draft = await createDraftBoxCatalogVersion(db, input, 'admin-1', 'teste');
    const executor = createBoxCatalogVersionExecutors()['system.box.catalog.version.activate'];
    const action = { type: 'system.box.catalog.version.activate', payload: { boxKey: 'simples', version: draft.version } };
    const preview = await executor.preview(ctx(db, action));
    const applied = await executor.apply(ctx(db, action, preview.before, preview.after));
    assert.equal((await getActiveBoxCatalogVersion(db, 'simples')).version, 4);

    await executor.undo(ctx(db, action, preview.before, applied.after));
    assert.equal((await getActiveBoxCatalogVersion(db, 'simples')).version, 3);
    const candidate = await db.get("SELECT status FROM clover_box_catalog_versions WHERE box_key='simples' AND version=4");
    assert.equal(candidate.status, 'draft');
});

test('activation undo is blocked after candidate version is used by an opening', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const draft = await createDraftBoxCatalogVersion(db, sourceInput('rara'), 'admin-1', 'teste');
    const executor = createBoxCatalogVersionExecutors()['system.box.catalog.version.activate'];
    const action = { type: 'system.box.catalog.version.activate', payload: { boxKey: 'rara', version: draft.version } };
    const preview = await executor.preview(ctx(db, action));
    const applied = await executor.apply(ctx(db, action, preview.before, preview.after));
    await db.run(
        `INSERT INTO clover_box_openings (player_id, box_key, catalog_version, status)
         VALUES ('player-1', 'rara', ?, 'completed')`,
        [draft.version]
    );
    await assert.rejects(
        () => executor.undo(ctx(db, action, preview.before, applied.after)),
        (error) => error?.code === 'box_catalog_activation_already_used'
    );
    assert.equal((await getActiveBoxCatalogVersion(db, 'rara')).version, draft.version);
});

test('activation blocks changing physical box template', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const input = sourceInput('simples');
    input.catalog.templateKey = 'box_rare_v1';
    const draft = await createDraftBoxCatalogVersion(db, input, 'admin-1', 'template inválido');
    const executor = createBoxCatalogVersionExecutors()['system.box.catalog.version.activate'];
    await assert.rejects(
        () => executor.preview(ctx(db, {
            type: 'system.box.catalog.version.activate',
            payload: { boxKey: 'simples', version: draft.version },
        })),
        (error) => error?.code === 'box_catalog_template_change_blocked'
    );
});

test('activation blocks changing the canonical global relic pool', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const input = sourceInput('simples');
    const relic = input.catalog.rewards.find((reward) => reward.pityTier === 'ultra_relic');
    relic.pool = relic.pool.slice(1);
    const draft = await createDraftBoxCatalogVersion(db, input, 'admin-1', 'pool inválido');
    const executor = createBoxCatalogVersionExecutors()['system.box.catalog.version.activate'];
    await assert.rejects(
        () => executor.preview(ctx(db, {
            type: 'system.box.catalog.version.activate',
            payload: { boxKey: 'simples', version: draft.version },
        })),
        (error) => error?.code === 'box_catalog_relic_pool_change_blocked'
    );
});
