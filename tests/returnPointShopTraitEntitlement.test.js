'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { loadCloverConfigs } = require('../helpers/clover/configLoader');
const {
    applyReturnPointTraitEntitlements,
    getReturnPointTraitEntitlements,
} = require('../helpers/clover/returnPointShopTraitEntitlement');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_prereset_purchases (
            id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed'
        );
        CREATE TABLE clover_prereset_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            purchase_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
    `);
    return db;
}

async function seedRight(db, playerId, rollNumber, effectKind) {
    const purchase = await db.run(
        `INSERT INTO clover_prereset_purchases (player_id,status) VALUES (?,'completed')`,
        [playerId]
    );
    await db.run(
        `INSERT INTO clover_prereset_entitlements (player_id,purchase_id,status,metadata_json)
         VALUES (?,?,'active',?)`,
        [playerId, purchase.lastID, JSON.stringify({ targetRollNumber: rollNumber, effectKind })]
    );
}

test('direito de Traço Raro comprado vale somente para o roll alvo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const playerId = 'RESET-TRAIT-01';
    await seedRight(db, playerId, 2, 'rare_aptitude_entitlement');

    const rights2 = await getReturnPointTraitEntitlements(db, playerId, 2);
    const rights3 = await getReturnPointTraitEntitlements(db, playerId, 3);
    assert.equal(rights2.rare_aptitude, true);
    assert.equal(rights3.rare_aptitude, false);

    const rare = loadCloverConfigs().lists.rareAptitudes[0];
    assert.ok(rare?.name);
    const base = {
        ok: false,
        errors: ['Aptidao rara so pode ficar na ficha se uma tentativa especial de Aptidao Rara passou.'],
        payload: { commonAptitude: null, rareAptitude: null, commonMark: null, rareMark: null, anomaly: null, attempts: [] },
    };

    const accepted = await applyReturnPointTraitEntitlements(
        db,
        playerId,
        2,
        { aptidao_comum: rare.name, aptidao_rara: '', marca_comum: '', marca_rara: '', anomalia: '' },
        base
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.errors.length, 0);
    assert.equal(accepted.payload.rareAptitude.key, rare.key);

    const wrongRoll = await applyReturnPointTraitEntitlements(
        db,
        playerId,
        3,
        { aptidao_comum: rare.name, aptidao_rara: '', marca_comum: '', marca_rara: '', anomalia: '' },
        base
    );
    assert.equal(wrongRoll.ok, false);
    assert.equal(wrongRoll.payload.rareAptitude, null);
});

test('Marca Rara e Anomalia compradas removem somente a exigencia aleatoria correspondente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const playerId = 'RESET-TRAIT-02';
    await seedRight(db, playerId, 6, 'rare_mark_entitlement');
    await seedRight(db, playerId, 6, 'anomaly_entitlement');

    const lists = loadCloverConfigs().lists;
    const mark = lists.rareMarks[0];
    const anomaly = lists.anomalies[0];
    assert.ok(mark?.name);
    assert.ok(anomaly?.name);

    const validation = await applyReturnPointTraitEntitlements(
        db,
        playerId,
        6,
        { aptidao_comum: '', aptidao_rara: '', marca_comum: mark.name, marca_rara: '', anomalia: anomaly.name },
        {
            ok: false,
            errors: [
                'Marca rara so pode ser usada se uma tentativa especial de Marca passou.',
                'Anomalia so pode ficar na ficha se uma tentativa especial de Anomalia passou.',
                'erro independente',
            ],
            payload: { commonAptitude: null, rareAptitude: null, commonMark: null, rareMark: null, anomaly: null, attempts: [] },
        }
    );

    assert.deepEqual(validation.errors, ['erro independente']);
    assert.equal(validation.payload.rareMark.key, mark.key);
    assert.equal(validation.payload.anomaly.key, anomaly.key);
});
