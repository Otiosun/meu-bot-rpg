'use strict';

const RETURN_POINT_SHOP_GATE_VERSION = 40;
const RETURN_POINT_SHOP_GATE_KEY = '0040_return_point_shop_gate';

const RETURN_POINT_SHOP_GATE_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_return_point_shop_gate', table:'clover_return_point_shop_gate', sql:`
CREATE TABLE clover_return_point_shop_gate (
    campaign_key TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('closed','open')),
    required_keep_count INTEGER NOT NULL CHECK (required_keep_count > 0),
    roster_revision INTEGER DEFAULT NULL,
    roster_hash TEXT DEFAULT NULL,
    keep_count_at_open INTEGER DEFAULT NULL CHECK (keep_count_at_open IS NULL OR keep_count_at_open >= 0),
    opened_by TEXT DEFAULT NULL,
    opened_at TEXT DEFAULT NULL,
    closed_by TEXT DEFAULT NULL,
    closed_at TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`}),
    Object.freeze({ type:'table', name:'clover_return_point_shop_gate_events', table:'clover_return_point_shop_gate_events', sql:`
CREATE TABLE clover_return_point_shop_gate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_key TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('open','close')),
    actor_id TEXT NOT NULL,
    roster_revision INTEGER DEFAULT NULL,
    roster_hash TEXT DEFAULT NULL,
    keep_count INTEGER DEFAULT NULL CHECK (keep_count IS NULL OR keep_count >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`}),
    Object.freeze({ type:'index', name:'idx_return_point_shop_gate_events_campaign', table:'clover_return_point_shop_gate_events', sql:`
CREATE INDEX idx_return_point_shop_gate_events_campaign
ON clover_return_point_shop_gate_events (campaign_key, id)
`}),
    Object.freeze({ type:'trigger', name:'trg_return_point_shop_gate_events_no_update', table:'clover_return_point_shop_gate_events', sql:`
CREATE TRIGGER trg_return_point_shop_gate_events_no_update
BEFORE UPDATE ON clover_return_point_shop_gate_events
BEGIN
    SELECT RAISE(ABORT, 'return_point_shop_gate_event_immutable');
END
`}),
    Object.freeze({ type:'trigger', name:'trg_return_point_shop_gate_events_no_delete', table:'clover_return_point_shop_gate_events', sql:`
CREATE TRIGGER trg_return_point_shop_gate_events_no_delete
BEFORE DELETE ON clover_return_point_shop_gate_events
BEGIN
    SELECT RAISE(ABORT, 'return_point_shop_gate_event_immutable');
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

async function inspectReturnPointShopGateSchemaState(db) {
    const names = RETURN_POINT_SHOP_GATE_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = RETURN_POINT_SHOP_GATE_OBJECTS.map((expected) => {
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
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind:'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind:'exact', objects });
    return Object.freeze({ kind:'partial_or_divergent', objects });
}

async function createReturnPointShopGateObjects(db) {
    for (const object of RETURN_POINT_SHOP_GATE_OBJECTS) await db.exec(object.sql);
}

const RETURN_POINT_SHOP_GATE_MIGRATION = Object.freeze({
    version: RETURN_POINT_SHOP_GATE_VERSION,
    key: RETURN_POINT_SHOP_GATE_KEY,
    description: 'Persiste o gate manual da Loja de Retorno e o snapshot da roster de 14 KEEP usado na abertura.',
    checksumMaterial: Object.freeze({
        objects: RETURN_POINT_SHOP_GATE_OBJECTS,
        requiredKeepCount: 14,
        revision: 'return-point-shop-gate-v1',
    }),
    async up(db) {
        const before = await inspectReturnPointShopGateSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema do gate da Loja de Retorno parcial/divergente exige reconciliacao explicita.');
            error.code = 'return_point_shop_gate_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createReturnPointShopGateObjects(db);
        const after = await inspectReturnPointShopGateSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0040 nao produziu o schema canonico do gate da Loja de Retorno.');
            error.code = 'return_point_shop_gate_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    RETURN_POINT_SHOP_GATE_KEY,
    RETURN_POINT_SHOP_GATE_MIGRATION,
    RETURN_POINT_SHOP_GATE_OBJECTS,
    RETURN_POINT_SHOP_GATE_VERSION,
    createReturnPointShopGateObjects,
    inspectReturnPointShopGateSchemaState,
    normalizeSql,
};
