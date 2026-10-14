'use strict';

const {
    migrationChecksum,
    tableExists,
} = require('./schemaMigrationService');

const MIGRATION_TABLE = 'clover_schema_migrations';

function normalizeChecksum(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeAttestation(attestation) {
    return Object.freeze({
        version: Number(attestation?.version),
        key: String(attestation?.key || '').trim(),
        checksum: normalizeChecksum(attestation?.checksum),
    });
}

function exactHistoricalMatch(row, attestation) {
    if (!row || !attestation) return false;
    return Number(row.version) === Number(attestation.version)
        && String(row.migration_key || '') === String(attestation.key || '')
        && normalizeChecksum(row.checksum) === normalizeChecksum(attestation.checksum);
}

function exactExecutableMatch(row, migration) {
    if (!row || !migration) return false;
    return Number(row.version) === Number(migration.version)
        && String(row.migration_key || '') === String(migration.key || '')
        && normalizeChecksum(row.checksum) === migrationChecksum(migration);
}

async function readCompatibilityLedger(db) {
    if (!await tableExists(db, MIGRATION_TABLE)) return [];
    return db.all(`
        SELECT version, migration_key, checksum
        FROM ${MIGRATION_TABLE}
        ORDER BY version ASC
    `);
}

async function resolveMigrationCompatibilityPlan(db, options = {}) {
    const migrations = Array.isArray(options.migrations) ? options.migrations : [];
    const attestations = Array.isArray(options.historicalAttestations)
        ? options.historicalAttestations.map(normalizeAttestation)
        : [];

    const executableByVersion = new Map(
        migrations.map((migration) => [Number(migration.version), migration])
    );
    const attestationByVersion = new Map();
    for (const attestation of attestations) {
        if (attestationByVersion.has(attestation.version)) {
            const error = new Error(`Atestação histórica duplicada para migration ${attestation.version}.`);
            error.code = 'duplicate_historical_attestation_version';
            error.version = attestation.version;
            throw error;
        }
        attestationByVersion.set(attestation.version, attestation);
    }

    const ledgerRows = await readCompatibilityLedger(db);
    const rowByVersion = new Map(
        ledgerRows.map((row) => [Number(row.version), row])
    );
    const shadowedExecutableVersions = new Set();
    const activeHistoricalAttestations = [];

    for (const attestation of attestations) {
        const version = Number(attestation.version);
        const migration = executableByVersion.get(version) || null;
        const row = rowByVersion.get(version) || null;

        if (!row) {
            // Em banco novo, atestação que colide com migration executável fica dormente.
            // A migration canônica continua responsável por criar o schema.
            if (!migration) activeHistoricalAttestations.push(attestation);
            continue;
        }

        if (exactHistoricalMatch(row, attestation)) {
            activeHistoricalAttestations.push(attestation);
            if (migration) shadowedExecutableVersions.add(version);
            continue;
        }

        // Um banco canônico novo pode ter a mesma versão já aplicada pelo executável atual.
        // Nesse caso a atestação live não substitui a migration canônica.
        if (migration && exactExecutableMatch(row, migration)) continue;

        const error = new Error(
            `Histórico live divergente para migration ${version}: `
            + `observado ${row.migration_key || '<sem-key>'}/${normalizeChecksum(row.checksum) || '<sem-checksum>'}.`
        );
        error.code = 'live_history_attestation_mismatch';
        error.version = version;
        error.expectedHistoricalKey = attestation.key;
        error.expectedHistoricalChecksum = attestation.checksum;
        error.observedKey = row.migration_key;
        error.observedChecksum = normalizeChecksum(row.checksum);
        error.currentExecutableKey = migration?.key || null;
        error.currentExecutableChecksum = migration ? migrationChecksum(migration) : null;
        throw error;
    }

    const plannedMigrations = migrations.filter(
        (migration) => !shadowedExecutableVersions.has(Number(migration.version))
    );

    return {
        migrations: plannedMigrations,
        historicalAttestations: activeHistoricalAttestations,
        ledgerRows,
        shadowedExecutableVersions: [...shadowedExecutableVersions].sort((a, b) => a - b),
    };
}

module.exports = {
    MIGRATION_TABLE,
    exactExecutableMatch,
    exactHistoricalMatch,
    normalizeAttestation,
    normalizeChecksum,
    readCompatibilityLedger,
    resolveMigrationCompatibilityPlan,
};
