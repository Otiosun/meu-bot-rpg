'use strict';

const PRE_RESET_LAUNCH_ROSTER_VERSION = 37;
const PRE_RESET_LAUNCH_ROSTER_KEY = '0037_prereset_admin_roster_launch';

const PRE_RESET_LAUNCH_ROSTER_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_pv_ledger', table:'clover_pv_ledger', sql:`
CREATE TABLE clover_pv_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount <> 0),
    entry_kind TEXT NOT NULL CHECK (entry_kind IN ('credit','debit','adjustment','migration','refund','compensation')),
    operation_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    policy_version TEXT DEFAULT NULL,
    reset_cycle_key TEXT DEFAULT NULL,
    related_id TEXT DEFAULT NULL,
    correlation_id TEXT DEFAULT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NOT NULL DEFAULT '{}'
)
`}),
    Object.freeze({ type:'index', name:'idx_clover_pv_ledger_player', table:'clover_pv_ledger', sql:`
CREATE INDEX idx_clover_pv_ledger_player ON clover_pv_ledger (player_id, id)
`}),
    Object.freeze({ type:'trigger', name:'trg_clover_pv_ledger_no_update', table:'clover_pv_ledger', sql:`
CREATE TRIGGER trg_clover_pv_ledger_no_update
BEFORE UPDATE ON clover_pv_ledger
BEGIN
    SELECT RAISE(ABORT, 'pv_ledger_immutable');
END
`}),
    Object.freeze({ type:'trigger', name:'trg_clover_pv_ledger_no_delete', table:'clover_pv_ledger', sql:`
CREATE TRIGGER trg_clover_pv_ledger_no_delete
BEFORE DELETE ON clover_pv_ledger
BEGIN
    SELECT RAISE(ABORT, 'pv_ledger_immutable');
END
`}),
    Object.freeze({ type:'table', name:'clover_prereset_launch_rosters', table:'clover_prereset_launch_rosters', sql:`
CREATE TABLE clover_prereset_launch_rosters (
    campaign_key TEXT PRIMARY KEY,
    authority_mode TEXT NOT NULL DEFAULT 'admin_roster' CHECK (authority_mode = 'admin_roster'),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','applying','completed')),
    roster_hash TEXT DEFAULT NULL,
    finalized_by TEXT DEFAULT NULL,
    finalized_at TEXT DEFAULT NULL,
    finalization_operation_key TEXT DEFAULT NULL UNIQUE,
    apply_operation_key TEXT DEFAULT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NOT NULL DEFAULT '{}'
)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_launch_keep_roster', table:'clover_prereset_launch_keep_roster', sql:`
CREATE TABLE clover_prereset_launch_keep_roster (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    roster_revision INTEGER NOT NULL CHECK (roster_revision > 0),
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (campaign_key, player_id)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_launch_keep_player', table:'clover_prereset_launch_keep_roster', sql:`
CREATE INDEX idx_prereset_launch_keep_player
ON clover_prereset_launch_keep_roster (player_id, campaign_key)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_launch_players', table:'clover_prereset_launch_players', sql:`
CREATE TABLE clover_prereset_launch_players (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    roster_revision INTEGER NOT NULL CHECK (roster_revision > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('keep','reset')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','blocked','applying','completed')),
    economy_snapshot_json TEXT DEFAULT NULL,
    reset_operation_code TEXT DEFAULT NULL UNIQUE,
    last_error_code TEXT DEFAULT NULL,
    last_error_message TEXT DEFAULT NULL,
    completed_at TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (campaign_key, player_id)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_launch_players_status', table:'clover_prereset_launch_players', sql:`
CREATE INDEX idx_prereset_launch_players_status
ON clover_prereset_launch_players (campaign_key, status, outcome, player_id)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_launch_events', table:'clover_prereset_launch_events', sql:`
CREATE TABLE clover_prereset_launch_events (
    operation_key TEXT PRIMARY KEY,
    campaign_key TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('roster_replace','roster_finalize','policy_approve','apply_begin','player_complete','apply_complete')),
    actor_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_launch_events_campaign', table:'clover_prereset_launch_events', sql:`
CREATE INDEX idx_prereset_launch_events_campaign
ON clover_prereset_launch_events (campaign_key, created_at, event_type)
`}),
    Object.freeze({ type:'trigger', name:'trg_prereset_launch_events_no_update', table:'clover_prereset_launch_events', sql:`
CREATE TRIGGER trg_prereset_launch_events_no_update
BEFORE UPDATE ON clover_prereset_launch_events
BEGIN
    SELECT RAISE(ABORT, 'prereset_launch_event_immutable');
END
`}),
    Object.freeze({ type:'trigger', name:'trg_prereset_launch_events_no_delete', table:'clover_prereset_launch_events', sql:`
CREATE TRIGGER trg_prereset_launch_events_no_delete
BEFORE DELETE ON clover_prereset_launch_events
BEGIN
    SELECT RAISE(ABORT, 'prereset_launch_event_immutable');
END
`}),
    Object.freeze({ type:'table', name:'clover_prereset_pr_pv_policies', table:'clover_prereset_pr_pv_policies', sql:`
CREATE TABLE clover_prereset_pr_pv_policies (
    campaign_key TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
    policy_version TEXT DEFAULT NULL,
    numerator INTEGER DEFAULT NULL CHECK (numerator IS NULL OR numerator > 0),
    denominator INTEGER DEFAULT NULL CHECK (denominator IS NULL OR denominator > 0),
    rounding TEXT DEFAULT NULL CHECK (rounding IS NULL OR rounding IN ('floor','ceil')),
    approved_by TEXT DEFAULT NULL,
    approved_at TEXT DEFAULT NULL,
    operation_key TEXT DEFAULT NULL UNIQUE,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_pr_pv_claims', table:'clover_prereset_pr_pv_claims', sql:`
CREATE TABLE clover_prereset_pr_pv_claims (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    operation_key TEXT NOT NULL UNIQUE,
    source_pr_balance INTEGER NOT NULL CHECK (source_pr_balance >= 0),
    source_pr_digest TEXT NOT NULL,
    pv_before INTEGER NOT NULL CHECK (pv_before >= 0),
    calculated_pv INTEGER NOT NULL CHECK (calculated_pv >= 0),
    pv_ledger_id INTEGER DEFAULT NULL,
    pr_ledger_id INTEGER DEFAULT NULL,
    claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (campaign_key, player_id)
)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_launch_inventory_preservations', table:'clover_prereset_launch_inventory_preservations', sql:`
CREATE TABLE clover_prereset_launch_inventory_preservations (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    inventory_item_id INTEGER NOT NULL,
    template_key TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TEXT DEFAULT NULL,
    PRIMARY KEY (campaign_key, player_id, inventory_item_id)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_launch_preserve_item', table:'clover_prereset_launch_inventory_preservations', sql:`
CREATE INDEX idx_prereset_launch_preserve_item
ON clover_prereset_launch_inventory_preservations (inventory_item_id, status, campaign_key)
`}),
    Object.freeze({ type:'trigger', name:'trg_prereset_launch_preserve_inventory_delete', table:'clover_inventory_items', sql:`
CREATE TRIGGER trg_prereset_launch_preserve_inventory_delete
BEFORE DELETE ON clover_inventory_items
WHEN EXISTS (
    SELECT 1
    FROM clover_prereset_launch_inventory_preservations p
    JOIN clover_prereset_launch_players lp
      ON lp.campaign_key = p.campaign_key
     AND lp.player_id = p.player_id
    WHERE p.inventory_item_id = OLD.id
      AND p.player_id = OLD.player_id
      AND p.status = 'active'
      AND lp.outcome = 'reset'
      AND lp.status = 'applying'
)
BEGIN
    SELECT RAISE(IGNORE);
END
`}),
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

async function inspectPreResetLaunchRosterSchemaState(db) {
    const names = PRE_RESET_LAUNCH_ROSTER_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRE_RESET_LAUNCH_ROSTER_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        return Object.freeze({
            name: expected.name,
            exists: Boolean(observed),
            exact: Boolean(observed)
                && observed.type === expected.type
                && observed.tbl_name === expected.table
                && normalizeSql(observed.sql) === normalizeSql(expected.sql),
        });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function createPreResetLaunchRosterObjects(db) {
    for (const object of PRE_RESET_LAUNCH_ROSTER_OBJECTS) await db.exec(object.sql);
}

const PRE_RESET_LAUNCH_ROSTER_MIGRATION = Object.freeze({
    version: PRE_RESET_LAUNCH_ROSTER_VERSION,
    key: PRE_RESET_LAUNCH_ROSTER_KEY,
    description: 'Formaliza roster ADM autoritativo, ledger PV, conversao PR->PV e preservacao atomica de caixas no launch reset.',
    checksumMaterial: Object.freeze({
        objects: PRE_RESET_LAUNCH_ROSTER_OBJECTS,
        authority: 'admin_roster_only_keep_exact_else_reset',
        economy: 'pv_preserved_pr_to_pv_policy_versioned',
        inventory: 'owned_boxes_preserved_during_launch_reset',
        revision: 'prereset-admin-roster-launch-v1',
    }),
    async up(db) {
        const before = await inspectPreResetLaunchRosterSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema F10 parcial/divergente exige reconciliacao explicita.');
            error.code = 'prereset_launch_roster_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createPreResetLaunchRosterObjects(db);
        const after = await inspectPreResetLaunchRosterSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0037 nao produziu o schema F10 canonico.');
            error.code = 'prereset_launch_roster_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    PRE_RESET_LAUNCH_ROSTER_KEY,
    PRE_RESET_LAUNCH_ROSTER_MIGRATION,
    PRE_RESET_LAUNCH_ROSTER_OBJECTS,
    PRE_RESET_LAUNCH_ROSTER_VERSION,
    createPreResetLaunchRosterObjects,
    inspectPreResetLaunchRosterSchemaState,
    normalizeSql,
};
