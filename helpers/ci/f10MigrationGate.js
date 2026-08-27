'use strict';

const {
    inspectPreResetCharacterLaunchSchemaState,
} = require('../clover/schemaMigrationCatalog');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    GLOBAL_RESET_CHILD_EVENT_GUARD_KEY,
    GLOBAL_RESET_CHILD_EVENT_GUARD_VERSION,
} = require('../clover/schemaMigrationPlan');
const {
    inspectResetJournalSchemaState,
} = require('../clover/resetJournalSchemaMigration');
const {
    inspectCloverScriptJournalSchemaState,
} = require('../clover/cloverScriptSchemaMigration');
const {
    inspectGlobalResetJournalFreezeSchemaState,
} = require('../clover/globalResetJournalFreezeMigration');
const {
    inspectGlobalResetChildEventGuardSchemaState,
} = require('../clover/globalResetChildEventGuardMigration');
const {
    inspectCloverMigrationState,
} = require('../clover/schemaMigrationService');

const EXPECTED_MIGRATION_KEYS = Object.freeze([
    '0001_baseline_adoption',
    '0002_low_risk_legacy_columns',
    '0003_bootstrap_metadata_columns',
    '0004_market_request_columns',
    '0005_quick_evaluation_columns',
    '0006_player_roll_columns',
    '0007_item_template_columns',
    '0008_inventory_item_columns',
    '0009_admin_service_columns',
    '0010_player_profile_columns',
    '0011_character_identity_columns',
    '0012_appearance_moderation_columns',
    '0013_site_profile_image_columns',
    '0014_character_trait_columns',
    '0015_roll_attempt_state_columns',
    '0016_story_state_columns',
    '0017_game_state_columns',
    '0018_player_patent_column',
    '0019_squad_columns',
    '0020_raid_v1_bridge',
    '0021_raid_v2_columns',
    '0022_raid_participant_finalization',
    '0023_raid_rewards_v2',
    '0024_raid_monthly_progress',
    '0025_raid_support_tables',
    '0026_raid_idempotency_requests',
    '0027_raid_reward_proposal_history',
    '0028_raid_reward_proposal_idempotency',
    '0029_prereset_character_launch_foundation',
    '0030_reset_journal_foundation',
    '0031_clover_script_journal_foundation',
    '0032_global_reset_journal_freeze',
    '0033_global_reset_child_event_guard',
]);

class F10MigrationGateError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'F10MigrationGateError';
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details = {}) {
    throw new F10MigrationGateError(code, message, details);
}

function assertCanonicalMigrationChain(migrations = CURRENT_SCHEMA_MIGRATIONS) {
    if (!Array.isArray(migrations)) {
        fail('migration_chain_invalid', 'Cadeia canônica de migrations precisa ser uma lista.');
    }

    const seenKeys = new Set();
    for (let index = 0; index < migrations.length; index += 1) {
        const migration = migrations[index];
        const expectedVersion = index + 1;
        const expectedKey = EXPECTED_MIGRATION_KEYS[index];

        if (!migration || !Number.isInteger(migration.version) || typeof migration.key !== 'string') {
            fail('migration_chain_invalid_entry', `Entrada de migration inválida na posição ${index + 1}.`);
        }
        if (seenKeys.has(migration.key)) {
            fail('migration_chain_duplicate_key', `Migration key duplicada: ${migration.key}.`, {
                key: migration.key,
                index,
            });
        }
        seenKeys.add(migration.key);

        if (migration.version !== expectedVersion) {
            fail(
                'migration_chain_non_contiguous',
                `Cadeia canônica precisa ser contígua: esperado ${expectedVersion}, observado ${migration.version}.`,
                { index, expectedVersion, observedVersion: migration.version }
            );
        }
        if (expectedKey !== undefined && migration.key !== expectedKey) {
            fail(
                'migration_chain_key_drift',
                `Migration key divergente na versão ${expectedVersion}: esperado ${expectedKey}, observado ${migration.key}.`,
                { index, expectedVersion, expectedKey, observedKey: migration.key }
            );
        }
    }

    if (migrations.length !== EXPECTED_MIGRATION_KEYS.length) {
        fail(
            'migration_chain_incomplete',
            `Cadeia canônica precisa conter ${EXPECTED_MIGRATION_KEYS.length} migrations; observadas ${migrations.length}.`,
            { expectedTotal: EXPECTED_MIGRATION_KEYS.length, observedTotal: migrations.length }
        );
    }

    const latest = migrations.at(-1);
    if (
        latest.version !== GLOBAL_RESET_CHILD_EVENT_GUARD_VERSION
        || latest.key !== GLOBAL_RESET_CHILD_EVENT_GUARD_KEY
    ) {
        fail(
            'migration_chain_latest_mismatch',
            `Head de migrations precisa ser ${GLOBAL_RESET_CHILD_EVENT_GUARD_KEY}.`,
            { observedVersion: latest.version, observedKey: latest.key }
        );
    }

    return Object.freeze({
        total: migrations.length,
        firstVersion: migrations[0].version,
        latestVersion: latest.version,
        latestKey: latest.key,
    });
}

async function assertDatabaseAtCanonicalMigrationHead(db, migrations = CURRENT_SCHEMA_MIGRATIONS) {
    const chain = assertCanonicalMigrationChain(migrations);
    const state = await inspectCloverMigrationState(db, { migrations });

    if (!state.ledgerExists) {
        fail('migration_ledger_missing', 'Ledger canônico de migrations ausente.');
    }
    if (state.applied.length !== chain.total) {
        fail(
            'migration_ledger_incomplete',
            `Ledger precisa conter ${chain.total} migrations; observadas ${state.applied.length}.`,
            { expectedTotal: chain.total, observedTotal: state.applied.length }
        );
    }
    if (state.userVersion !== chain.latestVersion) {
        fail(
            'migration_user_version_mismatch',
            `PRAGMA user_version precisa ser ${chain.latestVersion}; observado ${state.userVersion}.`,
            { expected: chain.latestVersion, observed: state.userVersion }
        );
    }
    if (state.schemaFingerprintMatchesLatest !== true) {
        fail(
            'migration_schema_fingerprint_drift',
            'Schema atual divergiu do fingerprint gravado pela migration canônica mais recente.',
            {
                currentSchemaFingerprint: state.currentSchemaFingerprint,
                latestRecordedFingerprint: state.latestRecordedFingerprint,
            }
        );
    }

    for (let index = 0; index < state.applied.length; index += 1) {
        const row = state.applied[index];
        const expected = migrations[index];
        if (Number(row.version) !== expected.version || row.migration_key !== expected.key) {
            fail(
                'migration_ledger_sequence_mismatch',
                `Ledger divergiu da cadeia canônica na posição ${index + 1}.`,
                { index, observedVersion: row.version, observedKey: row.migration_key }
            );
        }
    }

    const preResetSchema = await inspectPreResetCharacterLaunchSchemaState(db);
    if (preResetSchema.kind !== 'exact') {
        fail(
            'migration_prereset_schema_not_exact',
            'Schema da migration 0029 não está exato após bootstrap canônico.',
            { kind: preResetSchema.kind }
        );
    }

    const resetJournalSchema = await inspectResetJournalSchemaState(db);
    if (resetJournalSchema.kind !== 'exact') {
        fail(
            'migration_reset_journal_schema_not_exact',
            'Schema da migration 0030 não está exato após bootstrap canônico.',
            { kind: resetJournalSchema.kind }
        );
    }

    const cloverScriptJournalSchema = await inspectCloverScriptJournalSchemaState(db);
    if (cloverScriptJournalSchema.kind !== 'exact') {
        fail(
            'migration_clover_script_schema_not_exact',
            'Schema da migration 0031 não está exato após bootstrap canônico.',
            { kind: cloverScriptJournalSchema.kind }
        );
    }

    const globalResetFreezeSchema = await inspectGlobalResetJournalFreezeSchemaState(db);
    if (globalResetFreezeSchema.kind !== 'exact') {
        fail(
            'migration_global_reset_freeze_schema_not_exact',
            'Schema da migration 0032 não está exato após bootstrap canônico.',
            { kind: globalResetFreezeSchema.kind }
        );
    }

    const globalResetChildEventGuardSchema = await inspectGlobalResetChildEventGuardSchemaState(db);
    if (globalResetChildEventGuardSchema.kind !== 'exact') {
        fail(
            'migration_latest_schema_not_exact',
            'Schema da migration 0033 não está exato após bootstrap canônico.',
            { kind: globalResetChildEventGuardSchema.kind }
        );
    }

    return Object.freeze({
        chain,
        userVersion: state.userVersion,
        appliedCount: state.applied.length,
        currentSchemaFingerprint: state.currentSchemaFingerprint,
        schemaFingerprintMatchesLatest: state.schemaFingerprintMatchesLatest,
        preResetSchemaKind: preResetSchema.kind,
        resetJournalSchemaKind: resetJournalSchema.kind,
        cloverScriptJournalSchemaKind: cloverScriptJournalSchema.kind,
        globalResetFreezeSchemaKind: globalResetFreezeSchema.kind,
        globalResetChildEventGuardSchemaKind: globalResetChildEventGuardSchema.kind,
        applied: Object.freeze(state.applied.map((row) => Object.freeze({
            version: Number(row.version),
            key: row.migration_key,
            checksum: row.checksum,
            appliedAt: row.applied_at,
        }))),
    });
}

module.exports = {
    EXPECTED_MIGRATION_KEYS,
    F10MigrationGateError,
    assertCanonicalMigrationChain,
    assertDatabaseAtCanonicalMigrationHead,
};
