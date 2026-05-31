const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    backupDatabaseFile,
    getMigrationStatus,
    runDevoMigrations,
} = require('../src/modules/devo/migrations/migrationRunner');

function getArgValue(name) {
    const index = process.argv.indexOf(name);
    if (index === -1) return null;
    return process.argv[index + 1] || null;
}

async function main() {
    const dbArg = getArgValue('--db');
    const filename = path.resolve(dbArg || process.env.DEVO_DB_PATH || './banco.sqlite');
    const backupPath = backupDatabaseFile(filename);

    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');

    try {
        const before = await getMigrationStatus(db);
        const result = await runDevoMigrations(db, {
            databasePath: filename,
            backup: false,
        });
        const after = await getMigrationStatus(db);

        console.log(JSON.stringify({
            database: filename,
            backup: backupPath,
            before: {
                applied: before.applied,
                total: before.total,
                pending: before.pending.map((item) => item.id),
            },
            appliedNow: result.applied,
            after: {
                applied: after.applied,
                total: after.total,
                pending: after.pending.map((item) => item.id),
            },
        }, null, 2));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
