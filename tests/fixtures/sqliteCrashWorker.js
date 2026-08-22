'use strict';

const { openCloverDatabase } = require('../../helpers/clover/databaseConnection');

async function run() {
    const [filename, mode] = process.argv.slice(2);
    const db = await openCloverDatabase({ filename });
    if (mode === 'committed') {
        await db.exec('BEGIN IMMEDIATE');
        await db.run(`INSERT INTO crash_records (kind, value) VALUES ('committed', 'survives')`);
        await db.exec('COMMIT');
        process.send?.({ state: 'committed' });
    } else if (mode === 'uncommitted') {
        await db.exec('BEGIN IMMEDIATE');
        await db.run(`INSERT INTO crash_records (kind, value) VALUES ('uncommitted', 'must_rollback')`);
        process.send?.({ state: 'uncommitted' });
    } else {
        throw new Error(`Unknown crash mode: ${mode}`);
    }
    setInterval(() => {}, 1_000);
}

run().catch((error) => {
    process.send?.({ state: 'error', message: error.message });
    process.exitCode = 1;
});
