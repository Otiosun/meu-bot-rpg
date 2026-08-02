'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const LEGACY_FLAG = 'CLOVER_ENABLE_LEGACY_SQUAD_STAR_RECONCILE';
process.env[LEGACY_FLAG] = '1';
delete require.cache[require.resolve('../helpers/clover/squadService')];

const { ensureCloverSquadSchema } = require('../database');
const {
    reconcileSquadStars,
    syncAllSquadGroupDescriptions,
} = require('../helpers/clover/squadService');

delete process.env[LEGACY_FLAG];

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado'
        );
    `);
    await ensureCloverSquadSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, group_id, current_stars, historical_stars, black_stars)
         VALUES ('coringas_magenta', 'Coringas Magenta', '120363000000000000@g.us', 14, 31, 1)`
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, esquadrao, estrelas, ficha_status, jogo_status)
         VALUES ('member@lid', 'Membro Um', 'Coringas Magenta', 8, 'aprovada', 'liberado')`
    );
    return db;
}

async function snapshot(db) {
    return {
        squad: await db.get(
            `SELECT current_stars, historical_stars, black_stars
             FROM clover_squads WHERE squad_key = 'coringas_magenta'`
        ),
        ledgerCount: Number((await db.get(
            `SELECT COUNT(*) AS total FROM clover_squad_star_ledger`
        ))?.total || 0),
    };
}

test('reconciliador legado permanece bloqueado mesmo com antiga flag definida', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const before = await snapshot(db);
    const result = await reconcileSquadStars(db, 'coringas_magenta');
    const after = await snapshot(db);

    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'legacy_reconcile_disabled');
    assert.deepEqual(result.insertedMissingMemberStars, []);
    assert.equal(result.ledgerCount, null);
    assert.deepEqual(result.before, { currentStars: 14, historicalStars: 31 });
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(after, before);
});

test('sincronização de descrição continua sem executar reconciliação econômica', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const descriptions = [];
    const sock = {
        groupUpdateDescription: async (groupId, description) => {
            descriptions.push({ groupId, description });
        },
    };

    const before = await snapshot(db);
    const result = await syncAllSquadGroupDescriptions({
        sock,
        db,
        withGroupOnly: true,
        pauseMs: 0,
    });
    const after = await snapshot(db);

    assert.equal(result.ok, true);
    assert.equal(result.total, 1);
    assert.equal(result.synced, 1);
    assert.equal(result.reconciled, 0);
    assert.equal(result.reconciliationBlocked, 1);
    assert.equal(result.results[0].reconcile.reason, 'legacy_reconcile_disabled');
    assert.equal(descriptions.length, 1);
    assert.equal(descriptions[0].groupId, '120363000000000000@g.us');
    assert.match(descriptions[0].description, /Coringas Magenta/);
    assert.deepEqual(after, before);
});
