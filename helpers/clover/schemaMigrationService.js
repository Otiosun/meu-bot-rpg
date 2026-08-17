'use strict';

const crypto = require('crypto');

const MIGRATION_TABLE = 'clover_schema_migrations';
const BASELINE_VERSION = 1;
const BASELINE_KEY = '0001_baseline_adoption';

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeSql(sql) {
    return String(sql || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function migrationChecksum(migration) {
    return sha256(JSON.stringify({
        version: migration.version,
        key: migration.key,
        description: migration.description || '',
        up: typeof migration.up === 'function' ? String(migration.up) : '',
    }));
}

async function computeSchemaFingerprint(db, options = {}) {
    const excluded = new Set([
        MIGRATION_TABLE,
        ...(options.excludeNames || []),
    ]);

    const rows = await db.all(`
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type ASC, name ASC, tbl_name ASC
    `);

    const canonical = rows
        .filter((row) => !excluded.has(row.name))
        .map((row) => ({
            type: String(row.type || ''),
            name: String(row.name || ''),
            table: String(row.tbl_name || ''),
            sql: normalizeSql(row.sql),
        }));

    return sha256(JSON.stringify(canonical));
}

async function ensureMigrationLedger(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
            version INTEGER PRIMARY KEY,
            migration_key TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL,
            schema_fingerprint TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
    `);
}

const CORE_MIGRATIONS = Object.freeze([
    Object.freeze({
        version: BASELINE_VERSION,
        key: BASELINE_KEY,
        description: 'Adota o schema legado existente sem recriar tabelas de domínio.',
        async up() {
            // Baseline intencionalmente sem DDL de domínio. O bootstrap legado ainda roda
            // antes deste migrator durante a FASE 1; remoções de DDL serão graduais.
        },
    }),
]);

function validateMigrationList(migrations) {
    let previousVersion = 0;
    const keys = new Set();
    for (const migration of migrations) {
        if (!Number.isInteger(migration?.version) || migration.version <= previousVersion) {
            throw new Error('Migrations precisam ter versões inteiras positivas e estritamente crescentes.');
        }
        if (!migration.key || keys.has(migration.key)) {
            throw new Error(`Migration key inválida ou duplicada: ${migration?.key || '<vazia>'}`);
        }
        if (typeof migration.up !== 'function') {
            throw new Error(`Migration ${migration.key} não possui up(db).`);
        }
        previousVersion = migration.version;
        keys.add(migration.key);
    }
}

async function readAppliedMigrations(db) {
    await ensureMigrationLedger(db);
    return db.all(`
        SELECT version, migration_key, checksum, schema_fingerprint, applied_at, metadata_json
        FROM ${MIGRATION_TABLE}
        ORDER BY version ASC
    `);
}

async function assertAppliedMigrationsCompatible(db, migrations) {
    const applied = await readAppliedMigrations(db);
    const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

    for (const row of applied) {
        const expected = byVersion.get(Number(row.version));
        if (!expected) {
            const error = new Error(`Banco possui migration desconhecida: versão ${row.version}.`);
            error.code = 'unknown_applied_migration';
            throw error;
        }
        const expectedChecksum = migrationChecksum(expected);
        if (row.migration_key !== expected.key || row.checksum !== expectedChecksum) {
            const error = new Error(`Checksum/key divergente para migration ${row.version}.`);
            error.code = 'migration_checksum_mismatch';
            throw error;
        }
    }
    return applied;
}

async function applyMigration(db, migration) {
    const checksum = migrationChecksum(migration);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await db.get(
            `SELECT version, migration_key, checksum, schema_fingerprint
             FROM ${MIGRATION_TABLE}
             WHERE version = ?`,
            [migration.version]
        );
        if (existing) {
            if (existing.migration_key !== migration.key || existing.checksum !== checksum) {
                const error = new Error(`Checksum/key divergente para migration ${migration.version}.`);
                error.code = 'migration_checksum_mismatch';
                throw error;
            }
            await db.exec('COMMIT');
            return {
                version: migration.version,
                key: migration.key,
                checksum,
                schemaFingerprint: existing.schema_fingerprint,
                applied: false,
            };
        }

        const beforeFingerprint = await computeSchemaFingerprint(db);
        await migration.up(db);
        const afterFingerprint = await computeSchemaFingerprint(db);
        const metadata = JSON.stringify({
            baselineAdoption: migration.version === BASELINE_VERSION,
            beforeFingerprint,
            afterFingerprint,
        });

        await db.run(
            `INSERT INTO ${MIGRATION_TABLE}
             (version, migration_key, checksum, schema_fingerprint, metadata_json)
             VALUES (?, ?, ?, ?, ?)`,
            [migration.version, migration.key, checksum, afterFingerprint, metadata]
        );
        await db.exec(`PRAGMA user_version = ${migration.version}`);
        await db.exec('COMMIT');

        return {
            version: migration.version,
            key: migration.key,
            checksum,
            schemaFingerprint: afterFingerprint,
            applied: true,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function runCloverSchemaMigrations(db, options = {}) {
    const migrations = options.migrations || CORE_MIGRATIONS;
    validateMigrationList(migrations);
    await ensureMigrationLedger(db);

    const applied = await assertAppliedMigrationsCompatible(db, migrations);
    const appliedVersions = new Set(applied.map((row) => Number(row.version)));
    const results = [];

    for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) {
            results.push({
                version: migration.version,
                key: migration.key,
                checksum: migrationChecksum(migration),
                applied: false,
            });
            continue;
        }
        results.push(await applyMigration(db, migration));
    }

    const latestVersion = migrations.length ? migrations[migrations.length - 1].version : 0;
    const userVersion = await db.get('PRAGMA user_version');
    const observedUserVersion = Number(Object.values(userVersion || {})[0] || 0);
    if (observedUserVersion !== latestVersion) {
        const error = new Error(`PRAGMA user_version divergente: esperado ${latestVersion}, observado ${observedUserVersion}.`);
        error.code = 'user_version_mismatch';
        throw error;
    }

    return {
        latestVersion,
        appliedCount: results.filter((item) => item.applied).length,
        migrations: results,
        schemaFingerprint: await computeSchemaFingerprint(db),
    };
}

module.exports = {
    BASELINE_KEY,
    BASELINE_VERSION,
    CORE_MIGRATIONS,
    MIGRATION_TABLE,
    applyMigration,
    assertAppliedMigrationsCompatible,
    computeSchemaFingerprint,
    ensureMigrationLedger,
    migrationChecksum,
    readAppliedMigrations,
    runCloverSchemaMigrations,
    validateMigrationList,
};
