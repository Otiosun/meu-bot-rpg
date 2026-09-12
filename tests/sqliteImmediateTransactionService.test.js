'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { withImmediateTransaction } = require('../helpers/clover/sqliteImmediateTransactionService');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('transacoes concorrentes na mesma conexao sao serializadas sem rollback cruzado', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec('CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

    const first = withImmediateTransaction(db, async () => {
        await db.run("INSERT INTO evidence (id,value) VALUES (1,'first')");
        await delay(30);
        return 'first-ok';
    });
    const second = withImmediateTransaction(db, async () => {
        await db.run("INSERT INTO evidence (id,value) VALUES (2,'second')");
        return 'second-ok';
    });

    assert.deepEqual(await Promise.all([first, second]), ['first-ok', 'second-ok']);
    const rows = await db.all('SELECT id,value FROM evidence ORDER BY id');
    assert.deepEqual(rows, [
        { id: 1, value: 'first' },
        { id: 2, value: 'second' },
    ]);
});

test('rollback de uma transacao serializada nao desfaz a proxima', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec('CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');

    const failed = withImmediateTransaction(db, async () => {
        await db.run("INSERT INTO evidence (id,value) VALUES (1,'must-rollback')");
        throw new Error('expected failure');
    });
    const succeeding = withImmediateTransaction(db, async () => {
        await db.run("INSERT INTO evidence (id,value) VALUES (2,'survives')");
        return 'ok';
    });

    await assert.rejects(() => failed, /expected failure/);
    assert.equal(await succeeding, 'ok');
    const rows = await db.all('SELECT id,value FROM evidence ORDER BY id');
    assert.deepEqual(rows, [{ id: 2, value: 'survives' }]);
});
