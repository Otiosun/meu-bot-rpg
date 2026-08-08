'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const {
    addCatalogItem,
    ensureInventoryV1,
} = require('../helpers/clover/inventoryService');
const {
    createDraftBoxCatalogVersion,
    sourceSnapshot,
} = require('../helpers/clover/boxCatalogVersionService');
const {
    getRuntimeBoxCatalog,
} = require('../helpers/clover/boxCatalogRuntimeService');
const {
    openBox,
    getBoxDashboard,
} = require('../helpers/clover/boxService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            dinheiro INTEGER NOT NULL DEFAULT 0
        );
    `);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureInventoryV1(db);
    return db;
}

async function seedPlayerWithSimpleBoxes(db, quantity = 1) {
    const playerId = 'player-1';
    await db.run(
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome, dinheiro)
         VALUES (?, 'Conta Aster', 'Aster', 'Aster', 0)`,
        [playerId]
    );
    await addCatalogItem(db, playerId, 'box_simple_v1', quantity, {
        source: 'test',
        createdBy: 'test',
    });
    return playerId;
}

async function simpleBoxQuantity(db, playerId) {
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_inventory_items
         WHERE player_id = ? AND template_key = 'box_simple_v1'`,
        [playerId]
    );
    return Number(row?.total || 0);
}

async function playerYulls(db, playerId) {
    const row = await db.get('SELECT dinheiro FROM jogadores WHERE id = ?', [playerId]);
    return Number(row?.dinheiro || 0);
}

async function openingCount(db, playerId) {
    const row = await db.get('SELECT COUNT(*) AS total FROM clover_box_openings WHERE player_id = ?', [playerId]);
    return Number(row?.total || 0);
}

function minRandom(min) {
    return min;
}

function cloneSource(boxKey) {
    const source = sourceSnapshot(boxKey);
    return {
        boxKey,
        catalog: JSON.parse(JSON.stringify(source.catalog)),
        pityPolicy: JSON.parse(JSON.stringify(source.policy)),
    };
}

async function activateDraftForTestOnly(db, draft) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_box_catalog_versions
             SET status = 'archived', archived_at = CURRENT_TIMESTAMP
             WHERE box_key = ? AND status = 'active'`,
            [draft.boxKey]
        );
        await db.run(
            `UPDATE clover_box_catalog_versions
             SET status = 'active', activated_at = CURRENT_TIMESTAMP, activated_by = 'test-only'
             WHERE box_key = ? AND version = ? AND status = 'draft'`,
            [draft.boxKey, draft.version]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

test('real openBox uses persisted source-bootstrap v3, spends once and rewards once', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await seedPlayerWithSimpleBoxes(db, 2);

    const runtime = await getRuntimeBoxCatalog(db, 'simples');
    assert.equal(runtime.version, 3);
    assert.equal(runtime.runtime.persisted, true);
    assert.equal(runtime.runtime.source, 'source-bootstrap');

    const first = await openBox(db, playerId, 'simples', {
        idempotencyKey: 'persisted-open:v3:1',
        roll: 1,
        randomInt: minRandom,
        source: 'test',
    });

    assert.equal(first.catalogVersion, 3);
    assert.equal(first.boxKey, 'simples');
    assert.equal(first.rewardKey, 'yulls_1000_3000');
    assert.equal(await simpleBoxQuantity(db, playerId), 1);
    assert.equal(await playerYulls(db, playerId), 1000);
    assert.equal(await openingCount(db, playerId), 1);

    const row = await db.get('SELECT metadata_json FROM clover_box_openings WHERE id = ?', [first.openingId]);
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(metadata.catalog.version, 3);
    assert.equal(metadata.catalog.source, 'source-bootstrap');
    assert.equal(metadata.catalog.fingerprint, runtime.runtime.fingerprint);

    const replay = await openBox(db, playerId, 'simples', {
        idempotencyKey: 'persisted-open:v3:1',
        roll: 1,
        randomInt: minRandom,
        source: 'test',
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.openingId, first.openingId);
    assert.equal(await simpleBoxQuantity(db, playerId), 1);
    assert.equal(await playerYulls(db, playerId), 1000);
    assert.equal(await openingCount(db, playerId), 1);
});

test('test-only activated v4 is the catalog actually used by openBox and dashboard', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await seedPlayerWithSimpleBoxes(db, 1);

    const input = cloneSource('simples');
    input.pityPolicy.quality.hardAtOpening = 13;
    const draft = await createDraftBoxCatalogVersion(db, input, 'test', 'provar runtime v4');
    assert.equal(draft.version, 4);
    await activateDraftForTestOnly(db, draft);

    const runtime = await getRuntimeBoxCatalog(db, 'simples');
    assert.equal(runtime.version, 4);
    assert.equal(runtime.pityPolicy.quality.hardAtOpening, 13);

    const opening = await openBox(db, playerId, 'simples', {
        idempotencyKey: 'persisted-open:v4:1',
        roll: 1,
        randomInt: minRandom,
        source: 'test',
    });
    assert.equal(opening.catalogVersion, 4);

    const row = await db.get('SELECT catalog_version, metadata_json FROM clover_box_openings WHERE id = ?', [opening.openingId]);
    assert.equal(Number(row.catalog_version), 4);
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(metadata.catalog.version, 4);
    assert.equal(metadata.catalog.fingerprint, runtime.runtime.fingerprint);

    const dashboard = await getBoxDashboard(db, playerId);
    const simple = dashboard.boxes.find((box) => box.key === 'simples');
    assert.equal(simple.version, 4);
    assert.equal(simple.pityPolicy.quality.hardAtOpening, 13);
});

test('corrupted active catalog fails before box spend, reward or opening insert', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = await seedPlayerWithSimpleBoxes(db, 1);
    await getRuntimeBoxCatalog(db, 'simples');

    await db.run(
        `UPDATE clover_box_catalog_versions
         SET fingerprint = 'tampered'
         WHERE box_key = 'simples' AND status = 'active'`
    );

    const beforeBox = await simpleBoxQuantity(db, playerId);
    const beforeYulls = await playerYulls(db, playerId);
    const beforeOpenings = await openingCount(db, playerId);

    await assert.rejects(
        () => openBox(db, playerId, 'simples', {
            idempotencyKey: 'persisted-open:corrupt:1',
            roll: 1,
            randomInt: minRandom,
            source: 'test',
        }),
        (error) => error?.code === 'box_catalog_fingerprint_mismatch'
    );

    assert.equal(await simpleBoxQuantity(db, playerId), beforeBox);
    assert.equal(await playerYulls(db, playerId), beforeYulls);
    assert.equal(await openingCount(db, playerId), beforeOpenings);
});
