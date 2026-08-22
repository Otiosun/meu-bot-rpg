'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    all,
    exec,
    get,
    openCloverDatabase,
    run,
    transaction,
} = require('../helpers/clover/databaseConnection');

async function temporaryDatabase(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-data-access-'));
    const db = await openCloverDatabase({ filename: path.join(directory, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return db;
}

test('primitives preservam retorno e confirmam transacao', async (t) => {
    const db = await temporaryDatabase(t);
    await exec(db, 'CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const result = await transaction(db, async (tx) => {
        const inserted = await tx.run('INSERT INTO records (value) VALUES (?)', ['committed']);
        assert.equal(inserted.changes, 1);
        return inserted.lastID;
    });
    assert.equal(await get(db, 'SELECT value FROM records WHERE id = ?', [result]).then((row) => row.value), 'committed');
    assert.deepEqual(await all(db, 'SELECT value FROM records ORDER BY id'), [{ value: 'committed' }]);
    assert.equal((await run(db, 'UPDATE records SET value = ? WHERE id = ?', ['updated', result])).changes, 1);
});

test('transaction faz rollback, propaga erro e nao deixa estado preso', async (t) => {
    const db = await temporaryDatabase(t);
    await exec(db, 'CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const expected = new Error('rollback sentinel');
    await assert.rejects(
        transaction(db, async (tx) => {
            await tx.run('INSERT INTO records (value) VALUES (?)', ['discarded']);
            throw expected;
        }),
        (error) => error === expected,
    );
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM records')).count, 0);
    await transaction(db, (tx) => tx.run('INSERT INTO records (value) VALUES (?)', ['usable']));
    assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM records')).count, 1);
});

test('transaction falha cedo para aninhamento em vez de inventar savepoint', async (t) => {
    const db = await temporaryDatabase(t);
    await assert.rejects(
        transaction(db, async () => transaction(db, async () => {})),
        (error) => error && error.code === 'sqlite_nested_transaction_unsupported',
    );
});
