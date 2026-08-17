'use strict';

const legacyDatabase = require('./database/legacy');
const {
    configureCloverDatabaseConnection,
    openCloverDatabase,
} = require('./helpers/clover/databaseConnection');
const {
    CORE_MIGRATIONS,
    prepareCloverSchemaBeforeLegacy,
    runCloverSchemaMigrations,
} = require('./helpers/clover/schemaMigrationService');
const { CURRENT_SCHEMA_MIGRATIONS } = require('./helpers/clover/schemaMigrationCatalog');
const { prebootstrapCloverSchemaBeforeLegacy } = require('./helpers/clover/schemaBasePrebootstrapService');
const {
    buildGuardedLegacyExports,
    markLegacySchemaPrepared,
} = require('./helpers/clover/legacySchemaEnsureBridge');

const guardedLegacyExports = buildGuardedLegacyExports(legacyDatabase);

function resolveSchemaMigrations(options, createLegacyDatabase) {
    if (Array.isArray(options.migrations)) return options.migrations;
    const customLegacy = createLegacyDatabase !== legacyDatabase.criarBanco;
    return customLegacy ? CORE_MIGRATIONS : CURRENT_SCHEMA_MIGRATIONS;
}

async function prepareBeforeLegacy(options, createLegacyDatabase) {
    if (options.preLegacyMigrations === false) {
        return { baselineAdopted: false, migratedBeforeLegacy: false, skipped: 'disabled' };
    }

    const customLegacy = createLegacyDatabase !== legacyDatabase.criarBanco;
    const migrations = resolveSchemaMigrations(options, createLegacyDatabase);
    const openMigrationDatabase = options.openMigrationDatabase
        || (!customLegacy ? openCloverDatabase : null);
    if (typeof openMigrationDatabase !== 'function') {
        return { baselineAdopted: false, migratedBeforeLegacy: false, skipped: 'custom_legacy_without_opener' };
    }

    const migrationDb = await openMigrationDatabase({
        filename: './banco.sqlite',
        busyTimeoutMs: options.busyTimeoutMs,
        foreignKeys: options.foreignKeys,
        journalMode: options.journalMode,
    });
    try {
        const prepared = await prepareCloverSchemaBeforeLegacy(migrationDb, { migrations });
        const canonicalPrebootstrapEnabled = options.canonicalPrebootstrap !== false
            && (!customLegacy || options.canonicalPrebootstrap === true);
        if (
            canonicalPrebootstrapEnabled
            && !prepared.baselineAdopted
            && !prepared.migratedBeforeLegacy
            && prepared.latestVersion === 0
        ) {
            const prebootstrap = await prebootstrapCloverSchemaBeforeLegacy(migrationDb, { migrations });
            return { ...prepared, ...prebootstrap };
        }
        return prepared;
    } finally {
        await migrationDb.close().catch(() => {});
    }
}

async function criarBanco(options = {}) {
    const createLegacyDatabase = options.createLegacyDatabase || legacyDatabase.criarBanco;
    if (typeof createLegacyDatabase !== 'function') {
        throw new TypeError('createLegacyDatabase precisa ser uma função.');
    }

    const migrations = resolveSchemaMigrations(options, createLegacyDatabase);
    const preLegacy = await prepareBeforeLegacy(options, createLegacyDatabase);

    const db = await createLegacyDatabase();
    try {
        await configureCloverDatabaseConnection(db, {
            busyTimeoutMs: options.busyTimeoutMs,
            foreignKeys: options.foreignKeys,
            journalMode: options.journalMode,
        });
        const migrationOptions = preLegacy.skipped === 'custom_legacy_without_opener'
            ? { migrations: [CORE_MIGRATIONS[0]] }
            : { migrations };
        const migrationResult = await runCloverSchemaMigrations(db, migrationOptions);
        const currentLatestVersion = CURRENT_SCHEMA_MIGRATIONS[CURRENT_SCHEMA_MIGRATIONS.length - 1]?.version || 0;
        if (migrationResult.latestVersion >= currentLatestVersion) {
            markLegacySchemaPrepared(db);
        }
        return db;
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
}

module.exports = {
    ...guardedLegacyExports,
    criarBanco,
    prepareBeforeLegacy,
    resolveSchemaMigrations,
};
