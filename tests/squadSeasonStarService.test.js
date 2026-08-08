'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { ensureCloverSquadSchema } = require('../database');
const {
    grantSquadStarsInTransaction,
    purchaseSquadStarsInTransaction,
    readSquadNativeStars,
} = require('../helpers/clover/squadSeasonStarService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureCloverSquadSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, current_stars, historical_stars, black_stars)
         VALUES ('veu_negro', 'Véu Negro', 0, 0, 0)`
    );
    return db;
}

test('grant atualiza saldo, lifetime, temporada, transação nativa e ledger legado com evaluation_id', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const result = await grantSquadStarsInTransaction(db, {
        squadKey: 'Véu Negro',
        amount: 3,
        transactionKey: 'quick-evaluation:squad-stars:42',
        evaluationId: 42,
        source: 'ficha_avaliacao',
        reason: 'Ficha de avaliação teste.',
        createdBy: 'system',
        metadata: { modality_key: 'teste' },
    });

    assert.equal(result.duplicate, false);
    const stars = await readSquadNativeStars(db, 'veu_negro');
    assert.equal(stars.balance, 3);
    assert.equal(stars.lifetime, 3);
    assert.equal(stars.season, 3);
    assert.equal(stars.black, 0);

    const nativeTx = await db.get(
        'SELECT * FROM clover_squad_star_transactions WHERE transaction_key = ?',
        ['quick-evaluation:squad-stars:42']
    );
    assert.equal(nativeTx.amount, 3);
    assert.equal(nativeTx.kind, 'grant');
    assert.equal(nativeTx.source, 'ficha_avaliacao');
    assert.equal(nativeTx.season_id, 'season-2026');
    assert.equal(JSON.parse(nativeTx.metadata_json).evaluation_id, 42);

    const legacy = await db.get('SELECT * FROM clover_squad_star_ledger ORDER BY id DESC LIMIT 1');
    assert.equal(legacy.evaluation_id, 42);
    assert.equal(legacy.amount, 3);
    assert.equal(legacy.kind, 'ganho');
    assert.equal(legacy.source, 'ficha_avaliacao');
});

test('retry com a mesma transaction_key não duplica Estrelas nem ledgers', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const input = {
        squadKey: 'veu_negro',
        amount: 4,
        transactionKey: 'quick-evaluation:squad-stars:77',
        evaluationId: 77,
        source: 'ficha_avaliacao',
        createdBy: 'system',
    };
    await grantSquadStarsInTransaction(db, input);
    const replay = await grantSquadStarsInTransaction(db, input);
    assert.equal(replay.duplicate, true);

    const squad = await db.get('SELECT current_stars, historical_stars FROM clover_squads WHERE squad_key = ?', ['veu_negro']);
    assert.equal(squad.current_stars, 4);
    assert.equal(squad.historical_stars, 4);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_transactions')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_ledger')).total, 1);
    assert.equal((await db.get('SELECT season_stars FROM clover_squad_season_stars WHERE squad_key = ?', ['veu_negro'])).season_stars, 4);
});

test('purchase reduz somente saldo atual e preserva lifetime e ranking da temporada', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    await grantSquadStarsInTransaction(db, {
        squadKey: 'veu_negro',
        amount: 10,
        transactionKey: 'seed:gain',
        source: 'teste',
        createdBy: 'system',
    });
    const purchase = await purchaseSquadStarsInTransaction(db, {
        squadKey: 'veu_negro',
        amount: 4,
        transactionKey: 'upgrade:purchase:1',
        source: 'melhoria_esquadrao',
        reason: 'Compra de melhoria.',
        createdBy: 'system',
    });
    assert.equal(purchase.duplicate, false);

    const stars = await readSquadNativeStars(db, 'veu_negro');
    assert.equal(stars.balance, 6);
    assert.equal(stars.lifetime, 10);
    assert.equal(stars.season, 10);

    const legacy = await db.get('SELECT * FROM clover_squad_star_ledger ORDER BY id DESC LIMIT 1');
    assert.equal(legacy.amount, -4);
    assert.equal(legacy.kind, 'gasto');
});

test('purchase sem saldo suficiente falha antes de qualquer mutação', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    await assert.rejects(
        () => purchaseSquadStarsInTransaction(db, {
            squadKey: 'veu_negro',
            amount: 1,
            transactionKey: 'upgrade:insufficient',
            source: 'teste',
            createdBy: 'system',
        }),
        (error) => error?.code === 'insufficient_stars'
    );
    const stars = await readSquadNativeStars(db, 'veu_negro');
    assert.equal(stars.balance, 0);
    assert.equal(stars.lifetime, 0);
    assert.equal(stars.season, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_transactions')).total, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_ledger')).total, 0);
});
