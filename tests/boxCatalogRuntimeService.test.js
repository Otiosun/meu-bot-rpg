'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createDraftBoxCatalogVersion,
    sourceSnapshot,
} = require('../helpers/clover/boxCatalogVersionService');
const {
    getRuntimeBoxCatalog,
} = require('../helpers/clover/boxCatalogRuntimeService');

async function makeDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

function draftFromSource(boxKey) {
    const source = sourceSnapshot(boxKey);
    return {
        boxKey,
        catalog: JSON.parse(JSON.stringify(source.catalog)),
        pityPolicy: JSON.parse(JSON.stringify(source.policy)),
    };
}

test('runtime resolver bootstraps source version 3 as persisted active snapshot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const box = await getRuntimeBoxCatalog(db, 'simples');
    assert.equal(box.key, 'simples');
    assert.equal(box.version, 3);
    assert.equal(box.runtime.persisted, true);
    assert.equal(box.runtime.source, 'source-bootstrap');
    assert.equal(box.pityPolicy.quality.hardAtOpening, 12);
    assert.equal(box.rewards.reduce((sum, reward) => sum + Math.round(reward.chance * 100), 0), 10000);
});

test('draft version never changes runtime until explicit activation exists', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const input = draftFromSource('rara');
    const draft = await createDraftBoxCatalogVersion(db, input, 'admin-1', 'não ativar ainda');
    assert.equal(draft.version, 4);
    assert.equal(draft.status, 'draft');
    const runtime = await getRuntimeBoxCatalog(db, 'rara');
    assert.equal(runtime.version, 3);
});

test('runtime fails closed when active persisted payload is corrupted', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await getRuntimeBoxCatalog(db, 'simples');
    await db.run(
        `UPDATE clover_box_catalog_versions
         SET catalog_json = json_set(catalog_json, '$.rewards[0].chance', 99)
         WHERE box_key = 'simples' AND status = 'active'`
    );
    await assert.rejects(
        () => getRuntimeBoxCatalog(db, 'simples'),
        (error) => ['box_catalog_chance_total_invalid', 'box_catalog_fingerprint_mismatch'].includes(error?.code)
    );
});

test('runtime fails closed on fingerprint mismatch even when payload remains valid', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await getRuntimeBoxCatalog(db, 'rara');
    await db.run(
        `UPDATE clover_box_catalog_versions
         SET fingerprint = 'tampered'
         WHERE box_key = 'rara' AND status = 'active'`
    );
    await assert.rejects(
        () => getRuntimeBoxCatalog(db, 'rara'),
        (error) => error?.code === 'box_catalog_fingerprint_mismatch'
    );
});
