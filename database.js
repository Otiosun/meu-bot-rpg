'use strict';

const legacyDatabase = require('./database/legacy');
const { configureCloverDatabaseConnection } = require('./helpers/clover/databaseConnection');
const { runCloverSchemaMigrations } = require('./helpers/clover/schemaMigrationService');

async function criarBanco(options = {}) {
    const createLegacyDatabase = options.createLegacyDatabase || legacyDatabase.criarBanco;
    if (typeof createLegacyDatabase !== 'function') {
        throw new TypeError('createLegacyDatabase precisa ser uma função.');
    }

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
};
