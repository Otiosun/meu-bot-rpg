'use strict';

const legacyDatabase = require('./database/legacy');
const {
    configureCloverDatabaseConnection,
    openCloverDatabase,
} = require('./helpers/clover/databaseConnection');
const {
    prepareCloverSchemaBeforeLegacy,
    runCloverSchemaMigrations,
} = require('./helpers/clover/schemaMigrationService');

async function prepareBeforeLegacy(options, createLegacyDatabase) {
    if (options.preLegacyMigrations === false) {
        return { baselineAdopted: false, migratedBeforeLegacy: false, skipped: 'disabled' };
    }

    const customLegacy = createLegacyDatabase !== legacyDatabase.criarBanco;
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
        return await prepareCloverSchemaBeforeLegacy(migrationDb);
    } finally {
        await migrationDb.close().catch(() => {});
    }
}

async function criarBanco(options = {}) {
    const createLegacyDatabase = options.createLegacyDatabase || legacyDatabase.criarBanco;
    if (typeof createLegacyDatabase !== 'function') {
        throw new TypeError('createLegacyDatabase precisa ser uma função.');
    }

    await prepareBeforeLegacy(options, createLegacyDatabase);

    const db = await createLegacyDatabase();
    try {
        await configureCloverDatabaseConnection(db, {
            busyTimeoutMs: options.busyTimeoutMs,
            foreignKeys: options.foreignKeys,
            journalMode: options.journalMode,
        });
        await runCloverSchemaMigrations(db);
        return db;
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
}

module.exports = {
    ...legacyDatabase,
    criarBanco,
    prepareBeforeLegacy,
};
