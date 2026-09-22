'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    ensureEconomyV1,
    getShopCatalog,
    seedEconomyCatalog,
} = require('../helpers/clover/economyService');
const {
    activateShopCatalogVersion,
    createDraftShopCatalogVersion,
    ensureRuntimeShopCatalogVersion,
    getActiveShopCatalogVersion,
    listShopCatalogVersions,
    previewShopCatalogActivation,
} = require('../helpers/clover/shopCatalogVersionService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureEconomyV1(db);
    return db;
}

test('shop catalog bootstraps one persisted active version from Economy V1', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const versions = await listShopCatalogVersions(db);
    const active = await getActiveShopCatalogVersion(db);

    assert.equal(versions.length, 1);
    assert.equal(active.version, 1);
    assert.equal(active.status, 'active');
    assert.ok(active.catalog.shops.length > 0);
    assert.ok(active.catalog.listings.length > 0);
});

test('activating a draft changes runtime price and survives the static seed', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const active = await getActiveShopCatalogVersion(db);
    const catalog = JSON.parse(JSON.stringify(active.catalog));
    const listing = catalog.listings[0];
    const originalPrice = listing.unitPrice;
    listing.unitPrice = originalPrice + 123;

    const draft = await createDraftShopCatalogVersion(
        db,
        { catalog, reason: 'ajuste administrativo de teste' },
        { actorId: 'admin-1' }
    );
    const preview = await previewShopCatalogActivation(db, draft.version);
    assert.equal(preview.pendingPurchaseCount, 0);

    await activateShopCatalogVersion(
        db,
        { version: draft.version },
        { actorId: 'admin-1' }
    );

    let runtime = await getShopCatalog(db, listing.shopKey);
    assert.equal(
        runtime.listings.find((entry) => entry.key === listing.listingKey).unitPrice,
        originalPrice + 123
    );

    await seedEconomyCatalog(db);
    runtime = await getShopCatalog(db, listing.shopKey);
    assert.equal(
        runtime.listings.find((entry) => entry.key === listing.listingKey).unitPrice,
        originalPrice
    );

    await ensureRuntimeShopCatalogVersion(db);
    runtime = await getShopCatalog(db, listing.shopKey);
    assert.equal(
        runtime.listings.find((entry) => entry.key === listing.listingKey).unitPrice,
        originalPrice + 123
    );
});

test('shop catalog activation fails closed while a purchase is pending', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const active = await getActiveShopCatalogVersion(db);
    const catalog = JSON.parse(JSON.stringify(active.catalog));
    catalog.listings[0].unitPrice += 1;
    const draft = await createDraftShopCatalogVersion(
        db,
        { catalog, reason: 'teste de compra pendente' },
        { actorId: 'admin-1' }
    );

    const listing = catalog.listings[0];
    await db.run(
        `INSERT INTO clover_economy_purchase_intents
         (intent_key, player_id, listing_key, quantity, unit_price, subtotal, total, status, expires_at)
         VALUES ('shop-pending-test', 'player-1', ?, 1, ?, ?, ?, 'pending', datetime('now', '+2 minutes'))`,
        [listing.listingKey, listing.unitPrice, listing.unitPrice, listing.unitPrice]
    );

    const preview = await previewShopCatalogActivation(db, draft.version);
    assert.equal(preview.pendingPurchaseCount, 1);

    await assert.rejects(
        () => activateShopCatalogVersion(
            db,
            { version: draft.version },
            { actorId: 'admin-1' }
        ),
        (error) => error?.code === 'shop_catalog_pending_purchases'
    );

    assert.equal((await getActiveShopCatalogVersion(db)).version, active.version);
});
