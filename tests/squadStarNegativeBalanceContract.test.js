'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../database') {
        return { ensureCloverSquadSchema: async () => {} };
    }
    if (request === '../groupAccess') {
        return { normalizeJid: (value) => value ? String(value).trim() : '' };
    }
    if (request === './cavalierService') {
        return {
            normalizeSquadKey: (value) => String(value || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, ''),
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    purchaseSquadStarsInTransaction,
    readSquadNativeStars,
    recordSquadStarTransactionInTransaction,
} = require('../helpers/clover/squadSeasonStarService');
Module._load = originalLoad;

class FakeDb {
    constructor({
        balance = 10,
        lifetime = 30,
        black = 0,
        seasonStars = 12,
        existingTransaction = null,
        beforeGuard = null,
    } = {}) {
        this.squad = {
            squad_key: 'coringas_magenta',
            name: 'Coringas Magenta',
            current_stars: balance,
            historical_stars: lifetime,
            black_stars: black,
        };
        this.season = {
            season_id: 'season-2026',
            name: 'Temporada 2026',
            status: 'active',
        };
        this.seasonStars = seasonStars;
        this.existingTransaction = existingTransaction;
        this.beforeGuard = beforeGuard;
        this.nativeTransactions = [];
        this.legacyEntries = [];
        this.nextId = 1;
        this.guardedUpdateCalls = 0;
    }

    async exec() {}

    async all(sql) {
        if (sql.includes('SELECT squad_key FROM clover_squads')) {
            return [{ squad_key: this.squad.squad_key }];
        }
        return [];
    }

    async get(sql, params = []) {
        if (sql.includes('FROM clover_squad_seasons') && sql.includes("status = 'active'")) {
            return { ...this.season };
        }
        if (sql.includes('FROM clover_squad_star_transactions')
            && sql.includes('transaction_key = ?')) {
            return this.existingTransaction ? { ...this.existingTransaction } : null;
        }
        if (sql.includes('SELECT season_stars FROM clover_squad_season_stars')) {
            return { season_stars: this.seasonStars };
        }
        if (sql.includes('SELECT current_stars FROM clover_squads')) {
            return { current_stars: this.squad.current_stars };
        }
        if (sql.includes('SELECT * FROM clover_squads WHERE squad_key = ?')) {
            return params[0] === this.squad.squad_key ? { ...this.squad } : null;
        }
        return null;
    }

    async run(sql, params = []) {
        if (sql.includes('INSERT OR IGNORE INTO clover_squad_seasons')
            || sql.includes('INSERT OR IGNORE INTO clover_squad_season_stars')) {
            return { changes: 0 };
        }

        if (sql.includes('UPDATE clover_squads')
            && sql.includes('current_stars = current_stars + ?')) {
            this.guardedUpdateCalls += 1;
            if (typeof this.beforeGuard === 'function') {
                this.beforeGuard(this);
                this.beforeGuard = null;
            }
            const [delta, lifetimeDelta, squadKey, expectedBalance, guardDelta] = params;
            assert.equal(delta, guardDelta);
            if (squadKey !== this.squad.squad_key
                || !Number.isInteger(this.squad.current_stars)
                || this.squad.current_stars !== expectedBalance
                || this.squad.current_stars < 0
                || this.squad.current_stars + delta < 0) {
                return { changes: 0 };
            }
            this.squad.current_stars += delta;
            this.squad.historical_stars += lifetimeDelta;
            return { changes: 1 };
        }

        if (sql.includes('UPDATE clover_squad_season_stars')) {
            this.seasonStars += params[0];
            return { changes: 1 };
        }

        if (sql.includes('INSERT INTO clover_squad_star_transactions')) {
            const [
                transactionKey,
                squadKey,
                seasonId,
                playerId,
                amount,
                kind,
                source,
                reason,
                relatedId,
                createdBy,
                metadataJson,
            ] = params;
            const row = {
                id: this.nextId++,
                transaction_key: transactionKey,
                squad_key: squadKey,
                season_id: seasonId,
                player_id: playerId,
                amount,
                kind,
                source,
                reason,
                related_id: relatedId,
                created_by: createdBy,
                metadata: JSON.parse(metadataJson),
            };
            this.nativeTransactions.push(row);
            return { changes: 1, lastID: row.id };
        }

        if (sql.includes('INSERT INTO clover_squad_star_ledger')) {
            const [
                squadKey,
                playerId,
                evaluationId,
                amount,
                kind,
                source,
                reason,
                createdBy,
                metadataJson,
            ] = params;
            this.legacyEntries.push({
                squadKey,
                playerId,
                evaluationId,
                amount,
                kind,
                source,
                reason,
                createdBy,
                metadata: JSON.parse(metadataJson),
            });
            return { changes: 1, lastID: this.legacyEntries.length };
        }

        return { changes: 0 };
    }
}

async function assertRejectedWithoutLedger(db, action, expectedCode, {
    expectedBalance = db.squad.current_stars,
} = {}) {
    await assert.rejects(action, (error) => error?.code === expectedCode);
    assert.equal(db.squad.current_stars, expectedBalance);
    assert.equal(db.nativeTransactions.length, 0);
    assert.equal(db.legacyEntries.length, 0);
}

test('compra acima do saldo falha sem qualquer escrita', async () => {
    const db = new FakeDb({ balance: 5 });
    await assertRejectedWithoutLedger(
        db,
        () => purchaseSquadStarsInTransaction(db, {
            squadKey: 'Coringas Magenta',
            amount: 6,
            transactionKey: 'purchase:1',
        }),
        'insufficient_stars'
    );
    assert.equal(db.guardedUpdateCalls, 0);
});

test('ajuste negativo acima do saldo também falha sem escrita', async () => {
    const db = new FakeDb({ balance: 5 });
    await assertRejectedWithoutLedger(
        db,
        () => recordSquadStarTransactionInTransaction(db, {
            squadKey: 'Coringas Magenta',
            amount: -6,
            kind: 'adjustment',
            transactionKey: 'adjustment:1',
        }),
        'insufficient_stars'
    );
    assert.equal(db.guardedUpdateCalls, 0);
});

test('ajuste negativo válido registra saldos reais e legado como gasto', async () => {
    const db = new FakeDb({ balance: 8 });
    const result = await recordSquadStarTransactionInTransaction(db, {
        squadKey: 'Coringas Magenta',
        amount: -3,
        kind: 'adjustment',
        transactionKey: 'adjustment:2',
        reason: 'Correção aprovada',
        createdBy: 'admin@lid',
    });

    assert.equal(result.duplicate, false);
    assert.equal(db.squad.current_stars, 5);
    assert.equal(db.nativeTransactions.length, 1);
    assert.equal(db.legacyEntries.length, 1);
    assert.equal(db.nativeTransactions[0].metadata.balance_before, 8);
    assert.equal(db.nativeTransactions[0].metadata.balance_after, 5);
    assert.equal(db.legacyEntries[0].metadata.balance_before, 8);
    assert.equal(db.legacyEntries[0].metadata.balance_after, 5);
    assert.equal(db.legacyEntries[0].kind, 'gasto');
});

test('saldo negativo preexistente é erro de integridade e nunca vira zero', async () => {
    const db = new FakeDb({ balance: -4 });
    await assert.rejects(
        () => readSquadNativeStars(db, 'Coringas Magenta'),
        (error) => error?.code === 'star_integrity_violation'
            && error?.details?.field === 'clover_squads.current_stars'
            && error?.details?.value === -4
    );
});

test('valor nulo armazenado é erro de integridade, não zero', async () => {
    const db = new FakeDb({ balance: 4 });
    db.squad.current_stars = null;
    await assert.rejects(
        () => readSquadNativeStars(db, 'Coringas Magenta'),
        (error) => error?.code === 'star_integrity_violation'
            && error?.details?.field === 'clover_squads.current_stars'
            && error?.details?.value === null
    );
});

test('historico negativo armazenado é erro de integridade', async () => {
    const db = new FakeDb({ balance: 4, lifetime: -2 });
    await assert.rejects(
        () => readSquadNativeStars(db, 'Coringas Magenta'),
        (error) => error?.code === 'star_integrity_violation'
            && error?.details?.field === 'clover_squads.historical_stars'
            && error?.details?.value === -2
    );
});

test('Estrelas Negras negativas armazenadas são erro de integridade', async () => {
    const db = new FakeDb({ balance: 4, black: -1 });
    await assert.rejects(
        () => readSquadNativeStars(db, 'Coringas Magenta'),
        (error) => error?.code === 'star_integrity_violation'
            && error?.details?.field === 'clover_squads.black_stars'
            && error?.details?.value === -1
    );
});

test('mudança concorrente impede débito e não grava ledger', async () => {
    const db = new FakeDb({
        balance: 10,
        beforeGuard: (instance) => {
            instance.squad.current_stars = 2;
        },
    });
    await assertRejectedWithoutLedger(
        db,
        () => purchaseSquadStarsInTransaction(db, {
            squadKey: 'Coringas Magenta',
            amount: 4,
            transactionKey: 'purchase:concurrent',
        }),
        'star_balance_conflict',
        { expectedBalance: 2 }
    );
    assert.equal(db.guardedUpdateCalls, 1);
});

test('duplicata idempotente não reaplica débito e preserva resultado original', async () => {
    const db = new FakeDb({
        balance: 7,
        existingTransaction: {
            id: 44,
            transaction_key: 'purchase:duplicate',
            squad_key: 'coringas_magenta',
            player_id: null,
            amount: -3,
            kind: 'purchase',
            metadata_json: JSON.stringify({
                balance_before: 10,
                balance_after: 7,
            }),
        },
    });
    const result = await purchaseSquadStarsInTransaction(db, {
        squadKey: 'Coringas Magenta',
        amount: 3,
        transactionKey: 'purchase:duplicate',
    });

    assert.equal(result.duplicate, true);
    assert.equal(result.transactionId, 44);
    assert.deepEqual(result.original, {
        amount: -3,
        kind: 'purchase',
        balanceBefore: 10,
        balanceAfter: 7,
    });
    assert.equal(result.stars.balance, 7);
    assert.equal(db.squad.current_stars, 7);
    assert.equal(db.guardedUpdateCalls, 0);
    assert.equal(db.nativeTransactions.length, 0);
    assert.equal(db.legacyEntries.length, 0);
});

test('pós-condição divergente falha antes de gravar ledgers', async () => {
    const db = new FakeDb({ balance: 10 });
    const originalGet = db.get.bind(db);
    let currentReads = 0;
    db.get = async (sql, params) => {
        if (sql.includes('SELECT current_stars FROM clover_squads')) {
            currentReads += 1;
            if (currentReads === 1) return { current_stars: 8 };
        }
        return originalGet(sql, params);
    };

    await assertRejectedWithoutLedger(
        db,
        () => purchaseSquadStarsInTransaction(db, {
            squadKey: 'Coringas Magenta',
            amount: 3,
            transactionKey: 'purchase:postcondition',
        }),
        'star_balance_postcondition_failed',
        { expectedBalance: 7 }
    );
});
