'use strict';

const { FIXED_TRAIT_SLOTS, ensureAdminTraitSchema } = require('./adminTraitService');

const TRIGGER_VERSION = 'profile-trait-sync-v1';
const UPDATE_TRIGGER = 'trg_clover_profile_traits_update_v1';
const INSERT_TRIGGER = 'trg_clover_profile_traits_insert_v1';

function quoteSql(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function canonicalExpression(prefix, slotKey) {
    return `COALESCE(
        NULLIF(TRIM(${prefix}.${slotKey}_key), ''),
        LOWER(REPLACE(TRIM(${prefix}.${slotKey}), ' ', '_'))
    )`;
}

function filledExpression(prefix, slotKey) {
    return `${prefix}.${slotKey} IS NOT NULL
        AND LOWER(TRIM(${prefix}.${slotKey})) NOT IN ('', '-', '—', '–', 'null', 'none', 'n/a', 'undefined')`;
}

function buildSlotStatements(prefix, slotKey) {
    const slot = quoteSql(slotKey);
    const canonical = canonicalExpression(prefix, slotKey);
    const filled = filledExpression(prefix, slotKey);
    const templateMetadata = quoteSql(JSON.stringify({
        descriptionStatus: 'missing_in_profile_catalog',
        profileSync: { version: TRIGGER_VERSION, source: `jogadores.${slotKey}` },
    }));
    const assignmentMetadata = quoteSql(JSON.stringify({
        profileSync: { version: TRIGGER_VERSION, source: 'profile_confirmation' },
    }));

    return `
        INSERT OR IGNORE INTO clover_trait_templates (
            id, name, slot_key, description, effect_text, restrictions_text,
            status, version, metadata_json, operation_code, created_by, updated_by,
            created_at, updated_at, canonical_key, trait_kind, source
        )
        SELECT
            'TR-PF-' || UPPER(HEX(RANDOMBLOB(8))),
            TRIM(${prefix}.${slotKey}),
            ${slot},
            NULL,
            NULL,
            NULL,
            'active',
            1,
            ${templateMetadata},
            NULL,
            'profile-confirmation',
            'profile-confirmation',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            ${canonical},
            'system',
            'profile_confirmation'
        WHERE ${filled};

        INSERT INTO clover_player_traits (
            player_id, trait_id, slot_key, value_text, active, operation_code,
            assigned_by, removed_by, metadata_json, assigned_at, removed_at,
            position, source, legacy_ref, assignment_key
        )
        SELECT
            ${prefix}.id,
            template.id,
            ${slot},
            template.name,
            1,
            NULL,
            'profile-confirmation',
            NULL,
            ${assignmentMetadata},
            CURRENT_TIMESTAMP,
            NULL,
            0,
            'profile_confirmation',
            ${quoteSql(`jogadores.${slotKey}`)},
            'profile-fixed:' || ${prefix}.id || ':' || ${slot} || ':' || template.canonical_key
        FROM clover_trait_templates AS template
        WHERE template.slot_key = ${slot}
          AND template.canonical_key = ${canonical}
          AND ${filled}
        ON CONFLICT(assignment_key) WHERE assignment_key IS NOT NULL DO UPDATE SET
            trait_id = excluded.trait_id,
            value_text = excluded.value_text,
            active = 1,
            operation_code = NULL,
            assigned_by = 'profile-confirmation',
            removed_by = NULL,
            metadata_json = excluded.metadata_json,
            assigned_at = CURRENT_TIMESTAMP,
            removed_at = NULL,
            position = 0,
            source = 'profile_confirmation',
            legacy_ref = excluded.legacy_ref;
    `;
}

function buildTriggerBody(prefix) {
    return `
        UPDATE clover_player_traits
        SET active = 0,
            removed_by = 'profile-confirmation',
            removed_at = CURRENT_TIMESTAMP
        WHERE player_id = ${prefix}.id
          AND active = 1
          AND slot_key IN (${FIXED_TRAIT_SLOTS.map(quoteSql).join(', ')});

        ${FIXED_TRAIT_SLOTS.map((slotKey) => buildSlotStatements(prefix, slotKey)).join('\n')}
    `;
}

async function ensureAdminTraitProfileSyncTrigger(db) {
    await ensureAdminTraitSchema(db);

    await db.exec(`
        DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER};
        DROP TRIGGER IF EXISTS ${INSERT_TRIGGER};

        CREATE TRIGGER ${UPDATE_TRIGGER}
        AFTER UPDATE OF nome_real ON jogadores
        WHEN NEW.ficha_status = 'aprovada'
        BEGIN
            ${buildTriggerBody('NEW')}
        END;

        CREATE TRIGGER ${INSERT_TRIGGER}
        AFTER INSERT ON jogadores
        WHEN NEW.ficha_status = 'aprovada'
        BEGIN
            ${buildTriggerBody('NEW')}
        END;
    `);

    return {
        ok: true,
        version: TRIGGER_VERSION,
        triggers: [UPDATE_TRIGGER, INSERT_TRIGGER],
    };
}

module.exports = {
    INSERT_TRIGGER,
    TRIGGER_VERSION,
    UPDATE_TRIGGER,
    buildTriggerBody,
    ensureAdminTraitProfileSyncTrigger,
};
