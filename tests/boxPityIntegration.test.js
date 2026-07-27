'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createDb;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    createDb = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return {
                    changes: Number(result.changes || 0),
                    lastID: Number(result.lastInsertRowid || 0),
                };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

Module._load = function loadWithStubs(request, parent, isMain) {
    const parentFile = String(parent?.filename || '');
    if (request === './phService' && parentFile.endsWith('boxService.js')) {
        return {
            ensurePhState: async () => ({ ok: true }),
            addPhInTransaction: async () => ({ ledgerId: 1 }),
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    ensureCloverInventorySchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const { addCatalogItem } = require('../helpers/clover/inventoryService');
const {
    ensureSeasonalRelicSchema,
    getBoxDashboard,
    openBox,
} = require('../helpers/clover/boxService');
const { ensureBoxPitySchema } = require('../helpers/clover/boxPityStateService');
const { RELIC_POOL } = require('../helpers/clover/seasonalEventCatalog');
Module._load = originalLoad;

const PLAYER = 'pity-player@lid';

async function setup() {
    const db = await createDb();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado'
        )
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro)
         VALUES (?, 'Player de Pity', 0)`,
        [PLAYER]
    );
    await ensureCloverInventorySchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureSeasonalRelicSchema(db);
    await ensureBoxPitySchema(db);
    return db;
}

async function seedState(db, boxKey, qualityMissStreak, relicMissStreak, lastRewardKey = null) {
    await db.run(
        `INSERT INTO clover_box_pity_state (
            player_id, box_key, catalog_version, quality_miss_streak,
            relic_miss_streak, last_reward_key, initialized_from
         ) VALUES (?, ?, 3, ?, ?, ?, 'test')`,
        [PLAYER, boxKey, qualityMissStreak, relicMissStreak, lastRewardKey]
    );
}

test('abertura avança os dois contadores e replay idempotente não avança novamente', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });

    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:advance:1',
        roll: 1,
        randomInt: (min) => min,
    });
    assert.equal(opened.pity.before.qualityMissStreak, 0);
    assert.equal(opened.pity.after.qualityMissStreak, 1);
    assert.equal(opened.pity.after.relicMissStreak, 1);

    const duplicate = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:advance:1',
        roll: 1,
        randomInt: (min) => min,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.pity.after.qualityMissStreak, 1);

    const state = await db.get(
        `SELECT quality_miss_streak, relic_miss_streak
         FROM clover_box_pity_state
         WHERE player_id = ? AND box_key = 'simples' AND catalog_version = 3`,
        [PLAYER]
    );
    assert.equal(state.quality_miss_streak, 1);
    assert.equal(state.relic_miss_streak, 1);
});

test('hard pity garante prêmio alto não-Relíquia e reinicia apenas qualidade', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await seedState(db, 'simples', 11, 4, 'ph_5_10');
    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });

    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:hard:1',
        roll: 50,
        randomInt: (min) => min,
    });
    const highRewards = new Set(['ph_10_20', 'ticket_feitico', 'caixa_rara', 'titulo_comum']);
    assert.equal(opened.pity.hardActive, true);
    assert.equal(highRewards.has(opened.rewardKey), true);
    assert.notEqual(opened.reward.type, 'relic');
    assert.equal(opened.pity.after.qualityMissStreak, 0);
    assert.equal(opened.pity.after.relicMissStreak, 5);
});

test('anti-repetição troca a mesma reward_key por uma alternativa ponderada', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await seedState(db, 'simples', 0, 0, 'yulls_1000_3000');
    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });

    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:repeat:1',
        roll: 1,
        randomInt: (min) => min,
    });
    assert.equal(opened.pity.antiRepeat.applied, true);
    assert.equal(opened.pity.antiRepeat.from, 'yulls_1000_3000');
    assert.notEqual(opened.rewardKey, 'yulls_1000_3000');
});

test('Caixa Simples e Rara mantêm estados independentes no dashboard', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await seedState(db, 'simples', 8, 12, 'kit_comum');
    await seedState(db, 'rara', 3, 4, 'ph_10_15');

    const dashboard = await getBoxDashboard(db, PLAYER);
    const simple = dashboard.boxes.find((box) => box.key === 'simples');
    const rare = dashboard.boxes.find((box) => box.key === 'rara');

    assert.equal(dashboard.pity, true);
    assert.equal(dashboard.independentRolls, false);
    assert.equal(simple.pityState.qualityMissStreak, 8);
    assert.equal(simple.pityState.relicMissStreak, 12);
    assert.equal(rare.pityState.qualityMissStreak, 3);
    assert.equal(rare.pityState.relicMissStreak, 4);
});

test('pool global esgotado converte roll de Relíquia em prêmio alto e congela relic pity', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await seedState(db, 'simples', 0, 9, null);
    for (let index = 0; index < RELIC_POOL.length; index += 1) {
        await db.run(
            `INSERT INTO clover_seasonal_relic_ownership (
                relic_key, player_id, inventory_item_id, box_opening_id,
                claimed_at, metadata_json
             ) VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP, NULL)`,
            [RELIC_POOL[index], `owner-${index}@lid`, 1000 + index]
        );
    }
    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });

    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:empty-pool:1',
        roll: 10000,
        randomInt: (min) => min,
    });
    const highRewards = new Set(['ph_10_20', 'ticket_feitico', 'caixa_rara', 'titulo_comum']);
    assert.equal(opened.pity.relicPool.frozen, true);
    assert.equal(highRewards.has(opened.rewardKey), true);
    assert.notEqual(opened.reward.type, 'relic');
    assert.equal(opened.pity.after.relicMissStreak, 9);
    assert.equal(opened.pity.after.qualityMissStreak, 0);
});
