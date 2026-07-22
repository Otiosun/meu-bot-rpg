const test = require('node:test');
const assert = require('node:assert/strict');

const {
    closeDatabaseOnce,
    registerDatabase,
    retireDatabase,
    snapshotDatabaseLifecycle,
    withDatabaseLease,
} = require('../helpers/clover/databaseLifecycleGuard');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeDb() {
    return {
        closeCalls: 0,
        async close() {
            this.closeCalls += 1;
        },
    };
}

test('aposentar banco espera operação em andamento antes de fechar', async () => {
    const db = registerDatabase(createFakeDb());
    let operationFinished = false;

    const operation = withDatabaseLease(db, 'slow-command', async () => {
        await delay(60);
        operationFinished = true;
    });

    await delay(10);
    const retirement = retireDatabase(db, { timeoutMs: 500 });
    await delay(20);

    assert.equal(db.closeCalls, 0);
    assert.equal(snapshotDatabaseLifecycle(db).active, 1);

    await Promise.all([operation, retirement]);
    assert.equal(operationFinished, true);
    assert.equal(db.closeCalls, 1);
    assert.equal(snapshotDatabaseLifecycle(db).closed, true);
});

test('nova operação é recusada depois que o banco foi aposentado', async () => {
    const db = registerDatabase(createFakeDb());
    await retireDatabase(db, { timeoutMs: 50 });

    await assert.rejects(
        () => withDatabaseLease(db, 'late-command', async () => null),
        (error) => error.code === 'database_retired'
    );
});

test('fechamento repetido chama db.close apenas uma vez', async () => {
    const db = registerDatabase(createFakeDb());

    await Promise.all([
        closeDatabaseOnce(db),
        closeDatabaseOnce(db),
        closeDatabaseOnce(db),
    ]);

    assert.equal(db.closeCalls, 1);
    const repeated = await closeDatabaseOnce(db);
    assert.equal(repeated.alreadyClosed, true);
    assert.equal(db.closeCalls, 1);
});

test('timeout força fechamento e informa operação ainda ativa', async () => {
    const db = registerDatabase(createFakeDb());
    let releaseOperation;

    const operation = withDatabaseLease(db, 'hung-command', async () => {
        await new Promise((resolve) => {
            releaseOperation = resolve;
        });
    });

    await delay(5);
    const result = await retireDatabase(db, { timeoutMs: 20 });
    assert.equal(result.forced, true);
    assert.equal(result.idle, false);
    assert.equal(db.closeCalls, 1);

    releaseOperation();
    await operation;
});
