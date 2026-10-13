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
const { SCHEMA_MIGRATION_EXTENSIONS } = require('./helpers/clover/schemaMigrationExtensions');
const { SCENE_EVALUATION_ACCOUNTING_MIGRATION } = require('./helpers/clover/schemaMigrationGate2Accounting');
const { UNIVERSAL_EVALUATION_MIGRATION } = require('./helpers/clover/schemaMigrationGate3Evaluation');
const { HUMAN_PROTOTYPE_MIGRATION } = require('./helpers/clover/schemaMigrationGate4RacialEvaluation');
const { prebootstrapCloverSchemaBeforeLegacy } = require('./helpers/clover/schemaBasePrebootstrapService');

const CANONICAL_SCHEMA_MIGRATIONS = Object.freeze([
    ...CURRENT_SCHEMA_MIGRATIONS,
    ...SCHEMA_MIGRATION_EXTENSIONS,
    SCENE_EVALUATION_ACCOUNTING_MIGRATION,
    UNIVERSAL_EVALUATION_MIGRATION,
    HUMAN_PROTOTYPE_MIGRATION,
]);

function resolveSchemaMigrations(options, createLegacyDatabase) {
    if (Array.isArray(options.migrations)) return options.migrations;
    const customLegacy = createLegacyDatabase !== legacyDatabase.criarBanco;
    return customLegacy ? CORE_MIGRATIONS : CANONICAL_SCHEMA_MIGRATIONS;
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
        filename: options.filename || './banco.sqlite',
        busyTimeoutMs: options.busyTimeoutMs,
        foreignKeys: options.foreignKeys,
        journalMode: options.journalMode,
        synchronous: options.synchronous,
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
    const connectionOptions = {
        filename: options.filename || './banco.sqlite',
        busyTimeoutMs: options.busyTimeoutMs,
        foreignKeys: options.foreignKeys,
        journalMode: options.journalMode,
        synchronous: options.synchronous,
    };
    const canonicalLegacy = createLegacyDatabase === legacyDatabase.criarBanco;
    const db = canonicalLegacy
        ? await openCloverDatabase(connectionOptions)
        : await createLegacyDatabase(connectionOptions);
    try {
        if (canonicalLegacy) {
            await legacyDatabase.criarBanco(db);
        } else {
            await configureCloverDatabaseConnection(db, {
                ...connectionOptions,
            });
        }
        const migrationOptions = preLegacy.skipped === 'custom_legacy_without_opener'
            ? { migrations: [CORE_MIGRATIONS[0]] }
            : { migrations };
        await runCloverSchemaMigrations(db, migrationOptions);
        return db;
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
}

module.exports = {
    ...legacyDatabase,
    CANONICAL_SCHEMA_MIGRATIONS,
    criarBanco,
    prepareBeforeLegacy,
    resolveSchemaMigrations,
};
