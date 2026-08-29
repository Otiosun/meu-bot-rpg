'use strict';

const RETURN_POINT_SHOP_PURCHASE_VERSION = 41;
const RETURN_POINT_SHOP_PURCHASE_KEY = '0041_return_point_shop_purchases';

const RETURN_POINT_SHOP_PURCHASE_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_prereset_purchases', table:'clover_prereset_purchases', sql:`
CREATE TABLE clover_prereset_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    catalog_item_key TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    price_return_points INTEGER NOT NULL CHECK (price_return_points > 0),
    return_points_ledger_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded','void')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES jogadores(id),
    FOREIGN KEY (return_points_ledger_id) REFERENCES clover_return_points_ledger(id)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_purchases_player', table:'clover_prereset_purchases', sql:`
CREATE INDEX idx_prereset_purchases_player
ON clover_prereset_purchases (player_id, status, id)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_purchases_catalog', table:'clover_prereset_purchases', sql:`
CREATE INDEX idx_prereset_purchases_catalog
ON clover_prereset_purchases (catalog_item_key, status, id)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_entitlements', table:'clover_prereset_entitlements', sql:`
CREATE TABLE clover_prereset_entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    purchase_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','revoked')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    consumed_at TEXT DEFAULT NULL,
    UNIQUE (player_id, entitlement_key),
    UNIQUE (purchase_id),
    FOREIGN KEY (player_id) REFERENCES jogadores(id),
    FOREIGN KEY (purchase_id) REFERENCES clover_prereset_purchases(id)
)
`}),
    Object.freeze({ type:'index', name:'idx_prereset_entitlements_player', table:'clover_prereset_entitlements', sql:`
CREATE INDEX idx_prereset_entitlements_player
ON clover_prereset_entitlements (player_id, status, id)
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

async function inspectReturnPointShopPurchaseSchemaState(db) {
    const names = RETURN_POINT_SHOP_PURCHASE_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = RETURN_POINT_SHOP_PURCHASE_OBJECTS.map((expected) => {
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

async function createReturnPointShopPurchaseObjects(db) {
    for (const object of RETURN_POINT_SHOP_PURCHASE_OBJECTS) await db.exec(object.sql);
}

async function createMissingReturnPointShopPurchaseObjects(db, state) {
    const observedByName = new Map(state.objects.map((entry) => [entry.name, entry]));
    for (const object of RETURN_POINT_SHOP_PURCHASE_OBJECTS) {
        const observed = observedByName.get(object.name);
        if (!observed?.exists) await db.exec(object.sql);
    }
}

function schemaHasDivergentObject(state) {
    return state.objects.some((entry) => entry.exists && !entry.exact);
}

function reconciliationError(state) {
    const error = new Error('Schema de compras da Loja de Retorno parcial/divergente exige reconciliacao explicita.');
    error.code = 'return_point_shop_purchase_schema_reconciliation_required';
    error.state = state;
    return error;
}

const RETURN_POINT_SHOP_PURCHASE_MIGRATION = Object.freeze({
    version: RETURN_POINT_SHOP_PURCHASE_VERSION,
    key: RETURN_POINT_SHOP_PURCHASE_KEY,
    description: 'Persiste compras idempotentes da Loja de Retorno e os direitos adquiridos para a proxima vida.',
    checksumMaterial: Object.freeze({
        objects: RETURN_POINT_SHOP_PURCHASE_OBJECTS,
        revision: 'return-point-shop-purchases-v2-compatible-partial-heal',
    }),
    async up(db) {
        const before = await inspectReturnPointShopPurchaseSchemaState(db);
        if (before.kind === 'exact') return;
        if (schemaHasDivergentObject(before)) throw reconciliationError(before);

        await createMissingReturnPointShopPurchaseObjects(db, before);

        const after = await inspectReturnPointShopPurchaseSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0041 nao produziu o schema canonico de compras da Loja de Retorno.');
            error.code = 'return_point_shop_purchase_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    RETURN_POINT_SHOP_PURCHASE_KEY,
    RETURN_POINT_SHOP_PURCHASE_MIGRATION,
    RETURN_POINT_SHOP_PURCHASE_OBJECTS,
    RETURN_POINT_SHOP_PURCHASE_VERSION,
    createMissingReturnPointShopPurchaseObjects,
    createReturnPointShopPurchaseObjects,
    inspectReturnPointShopPurchaseSchemaState,
    normalizeSql,
    schemaHasDivergentObject,
};
