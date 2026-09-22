'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureEconomyV1 } = require('../helpers/clover/economyService');
const {
    createShopCatalogVersionExecutors,
} = require('../helpers/clover/adminShopCatalogVersionService');
const {
    activateShopCatalogVersion,
    createDraftShopCatalogVersion,
    getActiveShopCatalogVersion,
} = require('../helpers/clover/shopCatalogVersionService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureEconomyV1(db);
    return db;
}

function context(db, action, extra = {}) {
    return {
        db,
        operation: {
            actor: { id: 'admin-1' },
            reason: 'teste administrativo',
        },
        action,
        target: { kind: 'system', systemKey: 'clover' },
        ...extra,
    };
}

function changedCatalog(active, delta = 1) {
    const catalog = JSON.parse(JSON.stringify(active.catalog));
    catalog.listings[0].unitPrice += delta;
    return catalog;
}

test('shop draft executor previews, applies exact snapshot and can undo unused draft', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const active = await getActiveShopCatalogVersion(db);
    const action = {
        type: 'system.shop.catalog.version.create',
        payload: {
            catalog: changedCatalog(active, 7),
            reason: 'ajuste de teste',
        },
    };
    const executor = createShopCatalogVersionExecutors()['system.shop.catalog.version.create'];

    const preview = await executor.preview(context(db, action));
    assert.equal(preview.after.version, active.version + 1);
    assert.equal(preview.after.status, 'draft');
    assert.equal(preview.metadata.undoSafe, true);

    const applied = await executor.apply(context(db, action, {
        before: preview.before,
        after: preview.after,
    }));
    assert.equal(applied.after.version, preview.after.version);
    assert.equal(applied.after.fingerprint, preview.after.fingerprint);

    await executor.undo(context(db, action, { after: applied.after }));
    const row = await db.get(
        'SELECT * FROM clover_shop_catalog_versions WHERE version = ?',
        [applied.after.version]
    );
    assert.equal(row, undefined);
});

test('shop draft apply fails closed when catalog version set changed after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const active = await getActiveShopCatalogVersion(db);
    const action = {
        type: 'system.shop.catalog.version.create',
        payload: { catalog: changedCatalog(active, 5) },
    };
    const executor = createShopCatalogVersionExecutors()['system.shop.catalog.version.create'];
    const preview = await executor.preview(context(db, action));

    await createDraftShopCatalogVersion(
        db,
        { catalog: changedCatalog(active, 9), reason: 'concorrente' },
        { actorId: 'other-admin' }
    );

    await assert.rejects(
        () => executor.apply(context(db, action, {
            before: preview.before,
            after: preview.after,
        })),
        (error) => error?.code === 'shop_catalog_changed_after_preview'
    );
});

test('shop activation apply fails closed when active version changed after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const active = await getActiveShopCatalogVersion(db);
    const candidate = await createDraftShopCatalogVersion(
        db,
        { catalog: changedCatalog(active, 11), reason: 'candidata' },
        { actorId: 'admin-1' }
    );
    const action = {
        type: 'system.shop.catalog.version.activate',
        payload: { version: candidate.version },
    };
    const executor = createShopCatalogVersionExecutors()['system.shop.catalog.version.activate'];
    const preview = await executor.preview(context(db, action));

    const concurrent = await createDraftShopCatalogVersion(
        db,
        { catalog: changedCatalog(active, 17), reason: 'concorrente' },
        { actorId: 'other-admin' }
    );
    await activateShopCatalogVersion(
        db,
        { version: concurrent.version },
        { actorId: 'other-admin' }
    );

    await assert.rejects(
        () => executor.apply(context(db, action, {
            before: preview.before,
            after: preview.after,
        })),
        (error) => error?.code === 'shop_catalog_active_changed_after_preview'
    );
});

test('shop catalog executors require system:clover target', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const active = await getActiveShopCatalogVersion(db);
    const action = {
        type: 'system.shop.catalog.version.create',
        payload: { catalog: changedCatalog(active, 1) },
    };
    const executor = createShopCatalogVersionExecutors()['system.shop.catalog.version.create'];

    await assert.rejects(
        () => executor.preview({
            ...context(db, action),
            target: { kind: 'player', playerId: 'player-1' },
        }),
        (error) => error?.code === 'invalid_system_target'
    );
});
