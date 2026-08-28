'use strict';

const PRE_RESET_CAMPAIGN_VERSION = 35;
const PRE_RESET_CAMPAIGN_KEY = '0035_prereset_campaign_control';

const PRE_RESET_CAMPAIGN_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table', name: 'clover_prereset_campaigns', table: 'clover_prereset_campaigns', sql: `
CREATE TABLE clover_prereset_campaigns (
    campaign_key TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
    deadline_at TEXT NOT NULL,
    closure_operation_key TEXT DEFAULT NULL,
    configured_by TEXT NOT NULL,
    closing_started_at TEXT DEFAULT NULL,
    closed_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_prereset_campaign_events', table: 'clover_prereset_campaign_events', sql: `
CREATE TABLE clover_prereset_campaign_events (
    operation_key TEXT PRIMARY KEY,
    campaign_key TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('configure', 'begin_close', 'close')),
    actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_key) REFERENCES clover_prereset_campaigns(campaign_key)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_prereset_campaign_events_campaign', table: 'clover_prereset_campaign_events', sql: `
CREATE INDEX idx_prereset_campaign_events_campaign
ON clover_prereset_campaign_events (campaign_key, created_at, event_type)
`,
    }),
    Object.freeze({
        type: 'table', name: 'clover_prereset_purge_tombstones', table: 'clover_prereset_purge_tombstones', sql: `
CREATE TABLE clover_prereset_purge_tombstones (
    player_id TEXT PRIMARY KEY,
    operation_key TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    confirmation_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES jogadores(id)
)
`,
    }),
    Object.freeze({
        type: 'index', name: 'idx_prereset_purge_actor', table: 'clover_prereset_purge_tombstones', sql: `
CREATE INDEX idx_prereset_purge_actor
ON clover_prereset_purge_tombstones (actor_id, created_at, player_id)
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_campaign_state_machine', table: 'clover_prereset_campaigns', sql: `
CREATE TRIGGER trg_prereset_campaign_state_machine
BEFORE UPDATE OF status ON clover_prereset_campaigns
WHEN NOT (
    (OLD.status = 'open' AND NEW.status IN ('open', 'closing'))
    OR (OLD.status = 'closing' AND NEW.status IN ('closing', 'closed'))
    OR (OLD.status = 'closed' AND NEW.status = 'closed')
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_campaign_invalid_state_transition');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_campaign_events_no_update', table: 'clover_prereset_campaign_events', sql: `
CREATE TRIGGER trg_prereset_campaign_events_no_update
BEFORE UPDATE ON clover_prereset_campaign_events
BEGIN
    SELECT RAISE(ABORT, 'prereset_campaign_event_update_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_campaign_events_no_delete', table: 'clover_prereset_campaign_events', sql: `
CREATE TRIGGER trg_prereset_campaign_events_no_delete
BEFORE DELETE ON clover_prereset_campaign_events
BEGIN
    SELECT RAISE(ABORT, 'prereset_campaign_event_delete_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_purge_no_update', table: 'clover_prereset_purge_tombstones', sql: `
CREATE TRIGGER trg_prereset_purge_no_update
BEFORE UPDATE ON clover_prereset_purge_tombstones
BEGIN
    SELECT RAISE(ABORT, 'prereset_purge_tombstone_update_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_purge_no_delete', table: 'clover_prereset_purge_tombstones', sql: `
CREATE TRIGGER trg_prereset_purge_no_delete
BEFORE DELETE ON clover_prereset_purge_tombstones
BEGIN
    SELECT RAISE(ABORT, 'prereset_purge_tombstone_delete_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_purge_blocks_player_reactivation', table: 'jogadores', sql: `
CREATE TRIGGER trg_prereset_purge_blocks_player_reactivation
BEFORE UPDATE OF ficha_status, jogo_status ON jogadores
WHEN EXISTS (
    SELECT 1 FROM clover_prereset_purge_tombstones t WHERE t.player_id = OLD.id
)
AND (NEW.ficha_status <> 'incompleta' OR NEW.jogo_status <> 'bloqueado')
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_player_reactivation_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_purge_blocks_future_character_insert', table: 'clover_prereset_characters', sql: `
CREATE TRIGGER trg_prereset_purge_blocks_future_character_insert
BEFORE INSERT ON clover_prereset_characters
WHEN EXISTS (
    SELECT 1 FROM clover_prereset_purge_tombstones t WHERE t.player_id = NEW.player_id
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_future_character_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_purge_blocks_future_character_update', table: 'clover_prereset_characters', sql: `
CREATE TRIGGER trg_prereset_purge_blocks_future_character_update
BEFORE UPDATE ON clover_prereset_characters
WHEN EXISTS (
    SELECT 1 FROM clover_prereset_purge_tombstones t WHERE t.player_id = OLD.player_id
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_future_character_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger', name: 'trg_prereset_purge_blocks_roll_insert', table: 'player_rolls', sql: `
CREATE TRIGGER trg_prereset_purge_blocks_roll_insert
BEFORE INSERT ON player_rolls
WHEN EXISTS (
    SELECT 1 FROM clover_prereset_purge_tombstones t WHERE t.player_id = NEW.player_id
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_purged_roll_forbidden');
END
`,
    }),
]);

function normalizeSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectPreResetCampaignSchemaState(db) {
    const names = PRE_RESET_CAMPAIGN_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRE_RESET_CAMPAIGN_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && observed.tbl_name === expected.table
            && normalizeSql(observed.sql) === normalizeSql(expected.sql);
        return Object.freeze({ name: expected.name, exists: Boolean(observed), exact });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function createPreResetCampaignObjects(db) {
    for (const object of PRE_RESET_CAMPAIGN_OBJECTS) await db.exec(object.sql);
}

const PRE_RESET_CAMPAIGN_MIGRATION = Object.freeze({
    version: PRE_RESET_CAMPAIGN_VERSION,
    key: PRE_RESET_CAMPAIGN_KEY,
    description: 'Formaliza deadline global, fechamento retomavel e tombstone de purge manual do pre-reset.',
    checksumMaterial: Object.freeze({
        objects: PRE_RESET_CAMPAIGN_OBJECTS,
        acceptedLegacySchemaLineage: ['absent', 'exact'],
        revision: 'prereset-campaign-control-v1',
    }),
    async up(db) {
        const before = await inspectPreResetCampaignSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema de controle pre-reset parcial/divergente exige reconciliacao explicita.');
            error.code = 'prereset_campaign_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createPreResetCampaignObjects(db);
        const after = await inspectPreResetCampaignSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0035 nao produziu o schema canonico de controle pre-reset.');
            error.code = 'prereset_campaign_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    PRE_RESET_CAMPAIGN_KEY,
    PRE_RESET_CAMPAIGN_MIGRATION,
    PRE_RESET_CAMPAIGN_OBJECTS,
    PRE_RESET_CAMPAIGN_VERSION,
    createPreResetCampaignObjects,
    inspectPreResetCampaignSchemaState,
    normalizeSql,
};
