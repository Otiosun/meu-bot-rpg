'use strict';

const crypto = require('crypto');

const MIGRATION_TABLE = 'clover_schema_migrations';
const BASELINE_VERSION = 1;
const BASELINE_KEY = '0001_baseline_adoption';
const LOW_RISK_COLUMNS_VERSION = 2;
const LOW_RISK_COLUMNS_KEY = '0002_low_risk_legacy_columns';

const LOW_RISK_COLUMN_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_character_stats', column: 'ph_accumulated', definition: 'INTEGER DEFAULT 0' }),
    Object.freeze({ table: 'clover_character_stats', column: 'ph_available', definition: 'INTEGER DEFAULT 0' }),
    Object.freeze({ table: 'clover_box_openings', column: 'roll_basis_points', definition: 'INTEGER DEFAULT NULL' }),
    Object.freeze({ table: 'clover_inventory_reservations', column: 'expires_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_consumable_uses', column: 'effect_category', definition: 'TEXT DEFAULT NULL' }),
]);

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeSql(sql) {
    return String(sql || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function migrationChecksum(migration) {
    const payload = {
        version: migration.version,
        key: migration.key,
        description: migration.description || '',
        up: typeof migration.up === 'function' ? String(migration.up) : '',
    };
    if (migration.checksumMaterial !== undefined) {
        payload.checksumMaterial = migration.checksumMaterial;
    }
    return sha256(JSON.stringify(payload));
}

function assertIdentifier(value, label) {
    const text = String(value || '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
        throw new TypeError(`${label} inválido: ${text || '<vazio>'}`);
    }
    return text;
}

async function tableExists(db, tableName) {
    const table = assertIdentifier(tableName, 'tableName');
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
        [table]
    );
    return Boolean(row);
}

async function columnExists(db, tableName, columnName) {
    const table = assertIdentifier(tableName, 'tableName');
    const column = assertIdentifier(columnName, 'columnName');
    if (!await tableExists(db, table)) return false;
    const columns = await db.all(`PRAGMA table_info(${table})`);
    return columns.some((item) => item.name === column);
}

async function addColumnIfMissing(db, target) {
    const table = assertIdentifier(target?.table, 'target.table');
    const column = assertIdentifier(target?.column, 'target.column');
    const definition = String(target?.definition || '').trim();
    if (!definition || /;/.test(definition)) {
        throw new TypeError(`Definição inválida para ${table}.${column}.`);
    }
    if (!await tableExists(db, table)) {
        const error = new Error(`Tabela obrigatória ausente para migration: ${table}.`);
        error.code = 'migration_precondition_failed';
        error.table = table;
        throw error;
    }
    if (await columnExists(db, table, column)) return false;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
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
    Object.freeze({
        version: LOW_RISK_COLUMNS_VERSION,
        key: LOW_RISK_COLUMNS_KEY,
        description: 'Versiona cinco colunas legadas de baixo risco antes da retirada gradual de ensureColumn.',
        checksumMaterial: LOW_RISK_COLUMN_TARGETS,
        async up(db) {
            for (const target of LOW_RISK_COLUMN_TARGETS) {
                await addColumnIfMissing(db, target);
            }
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

async function assertUserVersionCompatible(db, applied) {
    const row = await db.get('PRAGMA user_version');
    const observed = Number(Object.values(row || {})[0] || 0);
    const expected = applied.length ? Number(applied[applied.length - 1].version) : 0;
    if (observed !== expected) {
        const error = new Error(`PRAGMA user_version divergente antes de migrar: esperado ${expected}, observado ${observed}.`);
        error.code = 'user_version_mismatch';
        error.expected = expected;
        error.observed = observed;
        throw error;
    }
    return observed;
}

async function assertAppliedMigrationsCompatible(db, migrations) {
    const applied = await readAppliedMigrations(db);

    if (applied.length > migrations.length) {
        const row = applied[migrations.length];
        const error = new Error(`Banco possui migration desconhecida: versão ${row.version}.`);
        error.code = 'unknown_applied_migration';
        throw error;
    }

    for (let index = 0; index < applied.length; index += 1) {
        const row = applied[index];
        const expected = migrations[index];
        if (!expected || Number(row.version) !== Number(expected.version)) {
            const error = new Error(`Sequência de migrations divergente na posição ${index + 1}: observado ${row.version}.`);
            error.code = 'migration_sequence_mismatch';
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

async function inspectCloverMigrationState(db, options = {}) {
    const migrations = options.migrations || CORE_MIGRATIONS;
    validateMigrationList(migrations);
    const ledgerExists = await tableExists(db, MIGRATION_TABLE);
    if (!ledgerExists) {
        const row = await db.get('PRAGMA user_version');
        return {
            ledgerExists: false,
            baselineAdopted: false,
            applied: [],
            userVersion: Number(Object.values(row || {})[0] || 0),
            currentSchemaFingerprint: await computeSchemaFingerprint(db),
            latestRecordedFingerprint: null,
            schemaFingerprintMatchesLatest: null,
        };
    }

    const applied = await assertAppliedMigrationsCompatible(db, migrations);
    const userVersion = await assertUserVersionCompatible(db, applied);
    const currentSchemaFingerprint = await computeSchemaFingerprint(db);
    const latestRecordedFingerprint = applied.length
        ? String(applied[applied.length - 1].schema_fingerprint || '')
        : null;
    return {
        ledgerExists: true,
        baselineAdopted: applied.some((row) => Number(row.version) === BASELINE_VERSION && row.migration_key === BASELINE_KEY),
        applied,
        userVersion,
        currentSchemaFingerprint,
        latestRecordedFingerprint,
        schemaFingerprintMatchesLatest: latestRecordedFingerprint === null
            ? null
            : latestRecordedFingerprint === currentSchemaFingerprint,
    };
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
    await assertUserVersionCompatible(db, applied);
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

async function prepareCloverSchemaBeforeLegacy(db, options = {}) {
    const migrations = options.migrations || CORE_MIGRATIONS;
    const state = await inspectCloverMigrationState(db, { migrations });
    if (!state.ledgerExists) {
        if (state.userVersion !== 0) {
            const error = new Error(
                `PRAGMA user_version=${state.userVersion} sem ledger ${MIGRATION_TABLE}.`
            );
            error.code = 'migration_state_inconsistent';
            error.userVersion = state.userVersion;
            throw error;
        }
        return {
            baselineAdopted: false,
            migratedBeforeLegacy: false,
            appliedCount: 0,
            latestVersion: 0,
        };
    }

    if (!state.baselineAdopted) {
        return {
            baselineAdopted: false,
            migratedBeforeLegacy: false,
            appliedCount: 0,
            latestVersion: state.userVersion,
        };
    }

    const result = await runCloverSchemaMigrations(db, { migrations });
    return {
        baselineAdopted: true,
        migratedBeforeLegacy: true,
        appliedCount: result.appliedCount,
        latestVersion: result.latestVersion,
        schemaFingerprint: result.schemaFingerprint,
    };
}

module.exports = {
    BASELINE_KEY,
    BASELINE_VERSION,
    CORE_MIGRATIONS,
    LOW_RISK_COLUMNS_KEY,
    LOW_RISK_COLUMNS_VERSION,
    LOW_RISK_COLUMN_TARGETS,
    MIGRATION_TABLE,
    addColumnIfMissing,
    applyMigration,
    assertAppliedMigrationsCompatible,
    assertUserVersionCompatible,
    columnExists,
    computeSchemaFingerprint,
    ensureMigrationLedger,
    inspectCloverMigrationState,
    migrationChecksum,
    prepareCloverSchemaBeforeLegacy,
    readAppliedMigrations,
    runCloverSchemaMigrations,
    tableExists,
    validateMigrationList,
};
