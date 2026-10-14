'use strict';

const {
    LIVE_SCHEMA_EXTENSION_ATTESTATIONS,
    LIVE_SCHEMA_HISTORY_ATTESTATIONS,
} = require('./liveSchemaHistoryAttestations');

const LIVE_BASELINE_VERSION = 54;

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1",
        [tableName]
    );
    return Boolean(row);
}

async function readLatestAppliedVersion(db) {
    if (!await tableExists(db, 'clover_schema_migrations')) return 0;
    const row = await db.get('SELECT MAX(version) AS latest FROM clover_schema_migrations');
    return Number(row?.latest || 0);
}

async function resolveSchemaMigrationRuntimePlan(db, options = {}) {
    const canonicalMigrations = options.canonicalMigrations || [];
    const releaseMigrations = options.releaseMigrations || [];
    const latestAppliedVersion = await readLatestAppliedVersion(db);

    if (latestAppliedVersion > 30 && latestAppliedVersion < LIVE_BASELINE_VERSION) {
        const error = new Error(
            `Histórico Clover parcial detectado em v${latestAppliedVersion}; esperado <=30 ou >=${LIVE_BASELINE_VERSION}.`
        );
        error.code = 'partial_live_schema_history';
        error.latestAppliedVersion = latestAppliedVersion;
        throw error;
    }

    if (latestAppliedVersion >= LIVE_BASELINE_VERSION) {
        return Object.freeze({
            mode: 'live-attested',
            latestAppliedVersion,
            migrations: releaseMigrations,
            historicalAttestations: LIVE_SCHEMA_HISTORY_ATTESTATIONS,
        });
    }

    return Object.freeze({
        mode: 'canonical',
        latestAppliedVersion,
        migrations: canonicalMigrations,
        historicalAttestations: LIVE_SCHEMA_EXTENSION_ATTESTATIONS,
    });
}

module.exports = {
    LIVE_BASELINE_VERSION,
    readLatestAppliedVersion,
    resolveSchemaMigrationRuntimePlan,
};
