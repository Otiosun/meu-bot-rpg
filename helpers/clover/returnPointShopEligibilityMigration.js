'use strict';

const RETURN_POINT_SHOP_ELIGIBILITY_VERSION = 42;
const RETURN_POINT_SHOP_ELIGIBILITY_KEY = '0042_return_point_shop_eligibility_snapshot';
const TEST_ONLY_PRE_RESET_SHOP_GATE_BYPASS_KEY = 'test_only_prereset_shop_gate_bypass';

const RETURN_POINT_SHOP_ELIGIBILITY_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_return_point_shop_eligible', table:'clover_return_point_shop_eligible', sql:`
CREATE TABLE clover_return_point_shop_eligible (
    campaign_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    roster_revision INTEGER NOT NULL,
    roster_hash TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('keep','reset')),
    captured_by TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (campaign_key, player_id)
)
`}),
    Object.freeze({ type:'index', name:'idx_return_point_shop_eligible_outcome', table:'clover_return_point_shop_eligible', sql:`
CREATE INDEX idx_return_point_shop_eligible_outcome
ON clover_return_point_shop_eligible (campaign_key, outcome, roster_revision, player_id)
`}),
    Object.freeze({ type:'trigger', name:'trg_return_point_shop_purchase_eligible', table:'clover_prereset_purchases', sql:`
CREATE TRIGGER trg_return_point_shop_purchase_eligible
BEFORE INSERT ON clover_prereset_purchases
WHEN COALESCE(
    CASE
        WHEN json_valid(NEW.metadata_json)
        THEN json_extract(NEW.metadata_json, '$.${TEST_ONLY_PRE_RESET_SHOP_GATE_BYPASS_KEY}')
        ELSE 0
    END,
    0
) != 1
AND NOT EXISTS (
    SELECT 1
    FROM clover_return_point_shop_eligible e
    JOIN clover_return_point_shop_gate g
      ON g.campaign_key=e.campaign_key
    WHERE e.campaign_key='mythic_launch_v1'
      AND e.player_id=NEW.player_id
      AND e.outcome='reset'
      AND g.status='open'
      AND e.roster_revision=g.roster_revision
      AND COALESCE(e.roster_hash,'')=COALESCE(g.roster_hash,'')
)
BEGIN
    SELECT RAISE(ABORT, 'return_shop_not_eligible');
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

async function inspectReturnPointShopEligibilitySchemaState(db) {
    const names = RETURN_POINT_SHOP_ELIGIBILITY_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = RETURN_POINT_SHOP_ELIGIBILITY_OBJECTS.map((expected) => {
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

async function createReturnPointShopEligibilityObjects(db) {
    for (const object of RETURN_POINT_SHOP_ELIGIBILITY_OBJECTS) await db.exec(object.sql);
}

const RETURN_POINT_SHOP_ELIGIBILITY_MIGRATION = Object.freeze({
    version: RETURN_POINT_SHOP_ELIGIBILITY_VERSION,
    key: RETURN_POINT_SHOP_ELIGIBILITY_KEY,
    description: 'Congela os jogadores elegiveis na abertura da Loja de Retorno e bloqueia compras fora do snapshot.',
    checksumMaterial: Object.freeze({
        objects: RETURN_POINT_SHOP_ELIGIBILITY_OBJECTS,
        revision: 'return-point-shop-eligibility-v3-test-only-synthetic-scope',
    }),
    async up(db) {
        const before = await inspectReturnPointShopEligibilitySchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema de elegibilidade da Loja de Retorno parcial/divergente exige reconciliacao explicita.');
            error.code = 'return_point_shop_eligibility_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createReturnPointShopEligibilityObjects(db);
        const after = await inspectReturnPointShopEligibilitySchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0042 nao produziu o schema canonico de elegibilidade da Loja de Retorno.');
            error.code = 'return_point_shop_eligibility_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    RETURN_POINT_SHOP_ELIGIBILITY_KEY,
    RETURN_POINT_SHOP_ELIGIBILITY_MIGRATION,
    RETURN_POINT_SHOP_ELIGIBILITY_OBJECTS,
    RETURN_POINT_SHOP_ELIGIBILITY_VERSION,
    TEST_ONLY_PRE_RESET_SHOP_GATE_BYPASS_KEY,
    createReturnPointShopEligibilityObjects,
    inspectReturnPointShopEligibilitySchemaState,
    normalizeSql,
};