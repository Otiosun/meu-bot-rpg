'use strict';

const PRE_RESET_FUTURE_SLOT_VERSION = 39;
const PRE_RESET_FUTURE_SLOT_KEY = '0039_prereset_future_slot_reservations';

const PRE_RESET_FUTURE_SLOT_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_prereset_future_slot_reservations', table:'clover_prereset_future_slot_reservations', sql:`
CREATE TABLE clover_prereset_future_slot_reservations (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    roll_number INTEGER NOT NULL CHECK (roll_number > 0),
    category TEXT NOT NULL CHECK (category IN ('family', 'anomaly', 'magic', 'race', 'grimoire')),
    option_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'consumed')),
    source TEXT NOT NULL DEFAULT 'prereset_future_roll',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TEXT DEFAULT NULL,
    consumed_at TEXT DEFAULT NULL,
    PRIMARY KEY (campaign_key, player_id, roll_number, category)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_future_slots_option', table:'clover_prereset_future_slot_reservations', sql:`
CREATE INDEX idx_prereset_future_slots_option
ON clover_prereset_future_slot_reservations (campaign_key, category, option_key, status)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_future_slots_player', table:'clover_prereset_future_slot_reservations', sql:`
CREATE INDEX idx_prereset_future_slots_player
ON clover_prereset_future_slot_reservations (player_id, campaign_key, roll_number, status)
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

async function inspectPreResetFutureSlotSchemaState(db) {
    const names = PRE_RESET_FUTURE_SLOT_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRE_RESET_FUTURE_SLOT_OBJECTS.map((expected) => {
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

const PRE_RESET_FUTURE_SLOT_MIGRATION = Object.freeze({
    version: PRE_RESET_FUTURE_SLOT_VERSION,
    key: PRE_RESET_FUTURE_SLOT_KEY,
    description: 'Reserva vagas limitadas do universo futuro sem TTL e sem usar slot_reservations do personagem legado.',
    checksumMaterial: Object.freeze({ objects:PRE_RESET_FUTURE_SLOT_OBJECTS, revision:'prereset-future-slots-v2' }),
    async up(db) {
        const before = await inspectPreResetFutureSlotSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema future slots parcial/divergente exige reconciliacao explicita.');
            error.code = 'prereset_future_slot_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        for (const object of PRE_RESET_FUTURE_SLOT_OBJECTS) await db.exec(object.sql);
        const after = await inspectPreResetFutureSlotSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0039 nao produziu schema future slots canonico.');
            error.code = 'prereset_future_slot_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    PRE_RESET_FUTURE_SLOT_KEY,
    PRE_RESET_FUTURE_SLOT_MIGRATION,
    PRE_RESET_FUTURE_SLOT_OBJECTS,
    PRE_RESET_FUTURE_SLOT_VERSION,
    inspectPreResetFutureSlotSchemaState,
};