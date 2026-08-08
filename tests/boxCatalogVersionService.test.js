'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createDraftBoxCatalogVersion,
    deleteUnusedDraftBoxCatalogVersion,
    getActiveBoxCatalogVersion,
    listBoxCatalogVersions,
    seedSourceBoxCatalogVersions,
    sourceSnapshot,
    validateBoxCatalogDefinition,
    validateBoxPityPolicy,
} = require('../helpers/clover/boxCatalogVersionService');

async function makeDb(filename = ':memory:') {
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_box_openings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            box_key TEXT NOT NULL,
            catalog_version INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed'
        );
    `);
    return db;
}

function draftFromSource(boxKey) {
    const source = sourceSnapshot(boxKey);
    return {
        boxKey,
        catalog: JSON.parse(JSON.stringify(source.catalog)),
        pityPolicy: JSON.parse(JSON.stringify(source.policy)),
    };
}

test('source bootstrap persists exactly one active version per box', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedSourceBoxCatalogVersions(db);
    await seedSourceBoxCatalogVersions(db);
    const versions = await listBoxCatalogVersions(db);
    assert.equal(versions.length, 2);
    for (const version of versions) {
        assert.equal(version.version, 3);
        assert.equal(version.status, 'active');
        assert.equal(version.source, 'source-bootstrap');
        assert.equal(version.catalog.rewards.reduce((sum, reward) => sum + Math.round(reward.chance * 100), 0), 10000);
        assert.ok(version.fingerprint);
    }
    assert.equal((await getActiveBoxCatalogVersion(db, 'simples')).version, 3);
    assert.equal((await getActiveBoxCatalogVersion(db, 'rara')).version, 3);
});

test('source bootstrap tolerates concurrent first callers on the same database', async (t) => {
    const tempRoot = process.env.CLOVER_TEST_TEMP_DIR || process.cwd();
    const filename = require('path').join(tempRoot, `box-catalog-concurrency-${process.pid}-${Date.now()}.sqlite`);
    const dbA = await makeDb(filename);
    const dbB = await makeDb(filename);
    t.after(async () => {
        await dbA.close();
        await dbB.close();
        require('fs').rmSync(filename, { force: true });
    });
    await Promise.all([
        seedSourceBoxCatalogVersions(dbA),
        seedSourceBoxCatalogVersions(dbB),
    ]);
    const versions = await listBoxCatalogVersions(dbA);
    assert.equal(versions.length, 2);
    assert.equal(versions.filter((entry) => entry.status === 'active').length, 2);
    assert.equal(new Set(versions.map((entry) => `${entry.boxKey}:${entry.version}`)).size, 2);
});

test('new catalog version is immutable draft with next version and validated policy', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const input = draftFromSource('simples');
    const draft = await createDraftBoxCatalogVersion(db, input, 'admin-1', 'Ajuste planejado de balanceamento');
    assert.equal(draft.boxKey, 'simples');
    assert.equal(draft.version, 4);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.catalog.version, 4);
    assert.equal(draft.createdBy, 'admin-1');
    assert.match(draft.reason, /balanceamento/i);
    assert.equal((await getActiveBoxCatalogVersion(db, 'simples')).version, 3);
});

test('catalog validation rejects totals different from exactly 100 percent', () => {
    const source = sourceSnapshot('simples');
    const catalog = JSON.parse(JSON.stringify(source.catalog));
    catalog.version = 4;
    catalog.rewards[0].chance += 0.01;
    assert.throws(
        () => validateBoxCatalogDefinition(catalog),
        (error) => error?.code === 'box_catalog_chance_total_invalid'
    );
});

test('catalog validation rejects missing referenced item', () => {
    const source = sourceSnapshot('rara');
    const catalog = JSON.parse(JSON.stringify(source.catalog));
    catalog.version = 4;
    const item = catalog.rewards.find((reward) => reward.type === 'item');
    item.templateKey = 'item_que_nao_existe';
    assert.throws(
        () => validateBoxCatalogDefinition(catalog),
        (error) => error?.code === 'box_reward_template_not_found'
    );
});

test('pity policy requires hard pity after soft pity', () => {
    const source = sourceSnapshot('simples');
    const policy = JSON.parse(JSON.stringify(source.policy));
    policy.quality.hardAtOpening = policy.quality.softAfterMisses;
    assert.throws(
        () => validateBoxPityPolicy(policy, 'simples'),
        (error) => error?.code === 'invalid_quality_pity_order'
    );
});

test('unused draft can be removed, but a used version cannot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    let draft = await createDraftBoxCatalogVersion(db, draftFromSource('simples'), 'admin-1', 'teste');
    let removed = await deleteUnusedDraftBoxCatalogVersion(db, draft.boxKey, draft.version);
    assert.equal(removed.deleted, true);

    draft = await createDraftBoxCatalogVersion(db, draftFromSource('simples'), 'admin-1', 'teste usado');
    await db.run(
        `INSERT INTO clover_box_openings (player_id, box_key, catalog_version, status)
         VALUES ('player-1', 'simples', ?, 'completed')`,
        [draft.version]
    );
    await assert.rejects(
        () => deleteUnusedDraftBoxCatalogVersion(db, draft.boxKey, draft.version),
        (error) => error?.code === 'box_catalog_version_already_used'
    );
});
