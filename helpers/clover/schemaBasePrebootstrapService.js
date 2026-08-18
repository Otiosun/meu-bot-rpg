'use strict';

const {
    MIGRATION_TABLE,
    computeSchemaFingerprint,
    inspectCloverMigrationState,
    tableExists,
    validateMigrationList,
} = require('./schemaMigrationService');
const { ensureCanonicalMigratedBaseTables } = require('./schemaBaseCatalog');

const DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS = Object.freeze([
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
]);

function resolvePrebootstrapMigrations(migrations, options = {}) {
    validateMigrationList(migrations);
    const allowed = new Set(options.migrationKeys || DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS);
    return migrations.filter((migration) => allowed.has(migration.key));
}

async function prebootstrapCloverSchemaBeforeLegacy(db, options = {}) {
    const migrations = options.migrations || [];
    const state = await inspectCloverMigrationState(db, { migrations });
    if (state.userVersion !== 0 || state.applied.length !== 0) {
        const error = new Error('Pre-bootstrap canônico exige banco ainda não adotado (user_version=0 e ledger vazio/ausente).');
        error.code = 'canonical_prebootstrap_state_incompatible';
        error.userVersion = state.userVersion;
        error.appliedCount = state.applied.length;
        throw error;
    }

    const selected = resolvePrebootstrapMigrations(migrations, options);
    const beforeFingerprint = state.currentSchemaFingerprint;
    const ledgerExistedBefore = state.ledgerExists;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const base = await ensureCanonicalMigratedBaseTables(db);
        const transient = [];
        for (const migration of selected) {
            await migration.up(db);
            transient.push({ version: migration.version, key: migration.key });
        }

        const ledgerExistsAfter = await tableExists(db, MIGRATION_TABLE);
        if (ledgerExistsAfter !== ledgerExistedBefore) {
            const error = new Error('Pre-bootstrap alterou indevidamente a existência do ledger de migrations.');
            error.code = 'canonical_prebootstrap_ledger_mutation';
            throw error;
        }

        const row = await db.get('PRAGMA user_version');
        const observedUserVersion = Number(Object.values(row || {})[0] || 0);
        if (observedUserVersion !== 0) {
            const error = new Error(`Pre-bootstrap alterou PRAGMA user_version para ${observedUserVersion}.`);
            error.code = 'canonical_prebootstrap_user_version_mutation';
            error.observed = observedUserVersion;
            throw error;
        }

        const afterFingerprint = await computeSchemaFingerprint(db);
        await db.exec('COMMIT');
        return {
            prebootstrappedBeforeLegacy: true,
            baseTablesCreatedOrPresent: base.createdOrPresent,
            transientMigrationCount: transient.length,
            transientMigrations: transient,
            beforeFingerprint,
            afterFingerprint,
            ledgerExistedBefore,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
    resolvePrebootstrapMigrations,
};
