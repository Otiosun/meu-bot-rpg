'use strict';

const PRE_RESET_FUTURE_ROLL_VERSION = 38;
const PRE_RESET_FUTURE_ROLL_KEY = '0038_prereset_future_rolls';

const PRE_RESET_FUTURE_ROLL_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_prereset_future_rolls', table:'clover_prereset_future_rolls', sql:`
CREATE TABLE clover_prereset_future_rolls (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    roll_number INTEGER NOT NULL CHECK (roll_number > 0),
    kingdom TEXT NOT NULL,
    social_class TEXT NOT NULL,
    family TEXT DEFAULT NULL,
    race TEXT NOT NULL,
    grimoire TEXT NOT NULL,
    grimoire_rank TEXT DEFAULT NULL,
    grimoire_symbol TEXT DEFAULT NULL,
    magic_rarity TEXT NOT NULL,
    magic_scope TEXT DEFAULT NULL,
    summary TEXT NOT NULL,
    roll_version TEXT NOT NULL,
    kingdom_key TEXT DEFAULT NULL,
    social_class_key TEXT DEFAULT NULL,
    race_key TEXT DEFAULT NULL,
    grimoire_key TEXT DEFAULT NULL,
    magic_rarity_key TEXT DEFAULT NULL,
    roll_payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (campaign_key, player_id, roll_number)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_future_rolls_player', table:'clover_prereset_future_rolls', sql:`
CREATE INDEX idx_prereset_future_rolls_player
ON clover_prereset_future_rolls (player_id, campaign_key, roll_number)
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

async function inspectPreResetFutureRollSchemaState(db) {
    const names = PRE_RESET_FUTURE_ROLL_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRE_RESET_FUTURE_ROLL_OBJECTS.map((expected) => {
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

const PRE_RESET_FUTURE_ROLL_MIGRATION = Object.freeze({
    version: PRE_RESET_FUTURE_ROLL_VERSION,
    key: PRE_RESET_FUTURE_ROLL_KEY,
    description: 'Armazena rolls da nova fase durante PRE_RESET sem tocar player_rolls do personagem legado.',
    checksumMaterial: Object.freeze({ objects:PRE_RESET_FUTURE_ROLL_OBJECTS, revision:'prereset-future-rolls-v1' }),
    async up(db) {
        const before = await inspectPreResetFutureRollSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema future rolls parcial/divergente exige reconciliacao explicita.');
            error.code = 'prereset_future_roll_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        for (const object of PRE_RESET_FUTURE_ROLL_OBJECTS) await db.exec(object.sql);
        const after = await inspectPreResetFutureRollSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0038 nao produziu schema future rolls canonico.');
            error.code = 'prereset_future_roll_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    PRE_RESET_FUTURE_ROLL_KEY,
    PRE_RESET_FUTURE_ROLL_MIGRATION,
    PRE_RESET_FUTURE_ROLL_OBJECTS,
    PRE_RESET_FUTURE_ROLL_VERSION,
    inspectPreResetFutureRollSchemaState,
};
