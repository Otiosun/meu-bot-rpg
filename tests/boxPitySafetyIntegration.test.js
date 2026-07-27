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
    openBox,
} = require('../helpers/clover/boxService');
const { ensureBoxPitySchema } = require('../helpers/clover/boxPityStateService');
const { RELIC_POOL } = require('../helpers/clover/seasonalEventCatalog');
const { grantPlayerTitle } = require('../helpers/clover/titleService');
Module._load = originalLoad;

const PLAYER = 'pity-safety-player@lid';

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
         VALUES (?, 'Player de Segurança do Pity', 0)`,
        [PLAYER]
    );
    await ensureCloverInventorySchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureSeasonalRelicSchema(db);
    await ensureBoxPitySchema(db);
    return db;
}

async function seedState(
    db,
    boxKey,
    qualityMissStreak,
    relicMissStreak,
    lastRewardKey = null
) {
    await db.run(
        `INSERT INTO clover_box_pity_state (
            player_id, box_key, catalog_version, quality_miss_streak,
            relic_miss_streak, last_reward_key, initialized_from
         ) VALUES (?, ?, 3, ?, ?, ?, 'test')`,
        [
            PLAYER,
            boxKey,
            qualityMissStreak,
            relicMissStreak,
            lastRewardKey,
        ]
    );
}

async function exhaustRelicPool(db) {
    for (let index = 0; index < RELIC_POOL.length; index += 1) {
        await db.run(
            `INSERT INTO clover_seasonal_relic_ownership (
                relic_key, player_id, inventory_item_id, box_opening_id,
                claimed_at, metadata_json
             ) VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP, NULL)`,
            [RELIC_POOL[index], `owner-${index}@lid`, 9000 + index]
        );
    }
}

test('fallback de Relíquia esgotada não repete a reward_key anterior', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await seedState(db, 'simples', 0, 9, 'ph_10_20');
    await exhaustRelicPool(db);
    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });

    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:safety:empty-pool:1',
        roll: 10000,
        randomInt: (min) => min,
    });

    const highRewards = new Set([
        'ph_10_20',
        'ticket_feitico',
        'caixa_rara',
        'titulo_comum',
    ]);
    assert.equal(opened.pity.relicPool.frozen, true);
    assert.equal(opened.pity.relicFallbackAntiRepeat.applied, true);
    assert.equal(opened.pity.relicFallbackAntiRepeat.from, 'ph_10_20');
    assert.equal(highRewards.has(opened.rewardKey), true);
    assert.notEqual(opened.rewardKey, 'ph_10_20');
    assert.equal(opened.pity.after.relicMissStreak, 9);
});

test('hard pity evita Título já desbloqueado e mantém prêmio alto', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await grantPlayerTitle(
        db,
        PLAYER,
        {
            key: 'titulo_temporada_comum',
            name: 'Título Comum da Temporada',
        },
        { source: 'teste' }
    );
    await seedState(db, 'simples', 11, 0, 'ticket_feitico');
    await addCatalogItem(db, PLAYER, 'box_simple_v1', 1, { source: 'teste' });

    const opened = await openBox(db, PLAYER, 'simples', {
        idempotencyKey: 'pity:safety:owned-title:1',
        roll: 60,
        randomInt: (min) => min,
    });

    const highRewards = new Set([
        'ph_10_20',
        'ticket_feitico',
        'caixa_rara',
        'titulo_comum',
    ]);
    assert.equal(opened.pity.hardActive, true);
    assert.equal(opened.pity.ownedTitleAvoidance.applied, true);
    assert.equal(opened.pity.ownedTitleAvoidance.from, 'titulo_comum');
    assert.equal(highRewards.has(opened.rewardKey), true);
    assert.notEqual(opened.rewardKey, 'titulo_comum');
    assert.notEqual(opened.reward.type, 'relic');
    assert.equal(opened.pity.after.qualityMissStreak, 0);
});
