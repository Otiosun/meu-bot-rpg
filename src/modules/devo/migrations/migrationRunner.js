const fs = require('fs');
const path = require('path');
const migrations = require('./index');

const MIGRATIONS_TABLE = 'devo_migrations';

function timestampForFile() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row);
}

async function ensureMigrationsTable(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function getAppliedMigrationIds(db, { createTable = false } = {}) {
    if (createTable) {
        await ensureMigrationsTable(db);
    } else if (!await tableExists(db, MIGRATIONS_TABLE)) {
        return new Set();
    }

    const rows = await db.all(`SELECT id FROM ${MIGRATIONS_TABLE}`);
    return new Set(rows.map((row) => row.id));
}

async function getMigrationStatus(db) {
    const appliedIds = await getAppliedMigrationIds(db, { createTable: false });
    const items = migrations.map((migration) => ({
        id: migration.id,
        name: migration.name,
        applied: appliedIds.has(migration.id),
    }));

    return {
        total: items.length,
        applied: items.filter((item) => item.applied).length,
        pending: items.filter((item) => !item.applied),
        items,
    };
}

function backupDatabaseFile(databasePath, backupRoot = path.join(process.cwd(), 'backups', 'devo-migrations')) {
    if (!databasePath || !fs.existsSync(databasePath)) {
        return null;
    }

    fs.mkdirSync(backupRoot, { recursive: true });

    const parsed = path.parse(databasePath);
    const backupPath = path.join(
        backupRoot,
        `${parsed.name}.${timestampForFile()}${parsed.ext || '.sqlite'}`
    );

    fs.copyFileSync(databasePath, backupPath);
    return backupPath;
}

async function runDevoMigrations(db, {
    databasePath = null,
    backup = true,
    backupRoot,
} = {}) {
    try {
        await db.exec('PRAGMA foreign_keys = ON');
    } catch (e) {
        // defensive: some db drivers may not support exec in certain states
    }
    const statusBefore = await getMigrationStatus(db);
    if (!statusBefore.pending.length) {
        return {
            ok: true,
            backupPath: null,
            applied: [],
            pending: [],
        };
    }

    const backupPath = backup ? backupDatabaseFile(databasePath, backupRoot) : null;

    await ensureMigrationsTable(db);
    const appliedIds = await getAppliedMigrationIds(db, { createTable: true });
    const appliedNow = [];

    for (const migration of migrations) {
        if (appliedIds.has(migration.id)) continue;

        await db.exec('BEGIN');
        try {
            await migration.up(db);
            await db.run(
                `INSERT INTO ${MIGRATIONS_TABLE} (id, name)
                 VALUES (?, ?)`,
                [migration.id, migration.name]
            );
            await db.exec('COMMIT');
            appliedNow.push(migration.id);
        } catch (error) {
            await db.exec('ROLLBACK');
            error.message = `Migration ${migration.id} failed: ${error.message}`;
            throw error;
        }
    }

    const statusAfter = await getMigrationStatus(db);

    return {
        ok: true,
        backupPath,
        applied: appliedNow,
        pending: statusAfter.pending,
    };
}

module.exports = {
    MIGRATIONS_TABLE,
    backupDatabaseFile,
    getMigrationStatus,
    runDevoMigrations,
};
