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

// Migration 0029 introduced a deliberately synthetic shop foundation. 0041 is
// the first real Return Shop schema, so this exact lineage is a supported
// upgrade path rather than an unknown divergence.
const RETURN_POINT_SHOP_0029_LEGACY_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_prereset_purchases', table:'clover_prereset_purchases', sql:`
CREATE TABLE clover_prereset_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    catalog_item_key TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    price_return_points INTEGER NOT NULL CHECK (price_return_points > 0),
    return_points_ledger_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    refunded_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (return_points_ledger_id) REFERENCES clover_return_points_ledger(id)
)
`}),
    Object.freeze({ type:'index', name:'idx_clover_prereset_purchases_player', table:'clover_prereset_purchases', sql:`
CREATE INDEX idx_clover_prereset_purchases_player
ON clover_prereset_purchases (player_id, created_at, status)
`}),
    Object.freeze({ type:'table', name:'clover_prereset_entitlements', table:'clover_prereset_entitlements', sql:`
CREATE TABLE clover_prereset_entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    entitlement_key TEXT NOT NULL,
    purchase_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'reserved', 'revoked')),
    reserved_for_player_id TEXT DEFAULT NULL,
    granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (player_id, entitlement_key),
    FOREIGN KEY (purchase_id) REFERENCES clover_prereset_purchases(id)
)
`}),
    Object.freeze({ type:'index', name:'idx_clover_prereset_entitlements_player', table:'clover_prereset_entitlements', sql:`
CREATE INDEX idx_clover_prereset_entitlements_player
ON clover_prereset_entitlements (player_id, status, entitlement_key)
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

async function inspectObjects(db, expectedObjects) {
    const names = expectedObjects.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = expectedObjects.map((expected) => {
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

async function inspectReturnPointShopPurchaseSchemaState(db) {
    return inspectObjects(db, RETURN_POINT_SHOP_PURCHASE_OBJECTS);
}

async function inspect0029LegacyReturnPointShopPurchaseSchemaState(db) {
    return inspectObjects(db, RETURN_POINT_SHOP_0029_LEGACY_OBJECTS);
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

function jsonWithLegacyFieldsSql(baseColumn, fields) {
    let expression = `COALESCE(NULLIF(${baseColumn}, ''), '{}')`;
    for (const [jsonPath, sqlValue] of fields) {
        expression = `json_set(${expression}, '${jsonPath}', ${sqlValue})`;
    }
    return expression;
}

async function assert0029RowsUpgradeable(db) {
    const orphanPurchase = await db.get(`
        SELECT p.id, p.player_id
        FROM clover_prereset_purchases p
        LEFT JOIN jogadores j ON j.id = p.player_id
        WHERE j.id IS NULL
        ORDER BY p.id LIMIT 1
    `);
    if (orphanPurchase) {
        const error = new Error('Compra 0029 referencia jogador inexistente e exige reconciliacao explicita.');
        error.code = 'return_point_shop_0029_data_reconciliation_required';
        error.row = orphanPurchase;
        throw error;
    }
    const orphanEntitlement = await db.get(`
        SELECT e.id, e.player_id, e.purchase_id
        FROM clover_prereset_entitlements e
        LEFT JOIN jogadores j ON j.id = e.player_id
        LEFT JOIN clover_prereset_purchases p ON p.id = e.purchase_id
        WHERE j.id IS NULL OR p.id IS NULL
        ORDER BY e.id LIMIT 1
    `);
    if (orphanEntitlement) {
        const error = new Error('Entitlement 0029 possui referencia invalida e exige reconciliacao explicita.');
        error.code = 'return_point_shop_0029_data_reconciliation_required';
        error.row = orphanEntitlement;
        throw error;
    }
}

async function migrate0029LegacyReturnPointShopPurchaseSchema(db) {
    const legacy = await inspect0029LegacyReturnPointShopPurchaseSchemaState(db);
    if (legacy.kind !== 'exact') throw reconciliationError(legacy);
    await assert0029RowsUpgradeable(db);

    const beforeCounts = await db.get(`
        SELECT
          (SELECT COUNT(*) FROM clover_prereset_purchases) AS purchases,
          (SELECT COUNT(*) FROM clover_prereset_entitlements) AS entitlements,
          (SELECT COALESCE(MAX(id),0) FROM clover_prereset_purchases) AS purchase_max_id,
          (SELECT COALESCE(MAX(id),0) FROM clover_prereset_entitlements) AS entitlement_max_id
    `);

    await db.exec('DROP INDEX idx_clover_prereset_entitlements_player');
    await db.exec('DROP INDEX idx_clover_prereset_purchases_player');
    await db.exec('ALTER TABLE clover_prereset_entitlements RENAME TO clover_prereset_entitlements_0029_legacy');
    await db.exec('ALTER TABLE clover_prereset_purchases RENAME TO clover_prereset_purchases_0029_legacy');

    await createReturnPointShopPurchaseObjects(db);

    const purchaseMetadata = jsonWithLegacyFieldsSql('metadata_json', [
        ['$.legacy_0029_refunded_at', 'refunded_at'],
    ]);
    await db.exec(`
        INSERT INTO clover_prereset_purchases
        (id,player_id,idempotency_key,catalog_item_key,entitlement_key,
         price_return_points,return_points_ledger_id,status,metadata_json,created_at)
        SELECT id,player_id,idempotency_key,catalog_item_key,entitlement_key,
               price_return_points,return_points_ledger_id,status,
               CASE WHEN refunded_at IS NULL THEN COALESCE(NULLIF(metadata_json,''),'{}')
                    ELSE ${purchaseMetadata} END,
               created_at
        FROM clover_prereset_purchases_0029_legacy
        ORDER BY id
    `);

    const entitlementMetadata = jsonWithLegacyFieldsSql('metadata_json', [
        ['$.legacy_0029_status', 'status'],
        ['$.legacy_0029_reserved_for_player_id', 'reserved_for_player_id'],
        ['$.legacy_0029_revoked_at', 'revoked_at'],
    ]);
    await db.exec(`
        INSERT INTO clover_prereset_entitlements
        (id,player_id,entitlement_key,purchase_id,status,metadata_json,created_at,consumed_at)
        SELECT id,player_id,entitlement_key,purchase_id,
               CASE status WHEN 'revoked' THEN 'revoked' ELSE 'active' END,
               ${entitlementMetadata},
               granted_at,
               NULL
        FROM clover_prereset_entitlements_0029_legacy
        ORDER BY id
    `);

    const afterCounts = await db.get(`
        SELECT
          (SELECT COUNT(*) FROM clover_prereset_purchases) AS purchases,
          (SELECT COUNT(*) FROM clover_prereset_entitlements) AS entitlements,
          (SELECT COALESCE(MAX(id),0) FROM clover_prereset_purchases) AS purchase_max_id,
          (SELECT COALESCE(MAX(id),0) FROM clover_prereset_entitlements) AS entitlement_max_id
    `);
    for (const key of ['purchases','entitlements','purchase_max_id','entitlement_max_id']) {
        if (Number(afterCounts[key] || 0) !== Number(beforeCounts[key] || 0)) {
            const error = new Error('Validacao de copia 0029->0041 falhou; transaction deve reverter integralmente.');
            error.code = 'return_point_shop_0029_copy_validation_failed';
            error.field = key;
            error.before = Number(beforeCounts[key] || 0);
            error.after = Number(afterCounts[key] || 0);
            throw error;
        }
    }

    await db.exec('DROP TABLE clover_prereset_entitlements_0029_legacy');
    await db.exec('DROP TABLE clover_prereset_purchases_0029_legacy');

    const after = await inspectReturnPointShopPurchaseSchemaState(db);
    if (after.kind !== 'exact') {
        const error = new Error('Upgrade 0029->0041 nao produziu o schema canonico da Loja de Retorno.');
        error.code = 'return_point_shop_purchase_schema_not_exact';
        error.state = after;
        throw error;
    }
}

const RETURN_POINT_SHOP_PURCHASE_MIGRATION = Object.freeze({
    version: RETURN_POINT_SHOP_PURCHASE_VERSION,
    key: RETURN_POINT_SHOP_PURCHASE_KEY,
    description: 'Persiste compras idempotentes da Loja de Retorno e os direitos adquiridos para a proxima vida.',
    checksumMaterial: Object.freeze({
        objects: RETURN_POINT_SHOP_PURCHASE_OBJECTS,
        legacy0029: RETURN_POINT_SHOP_0029_LEGACY_OBJECTS,
        revision: 'return-point-shop-purchases-v3-upgrade-0029-lineage',
    }),
    async up(db) {
        const before = await inspectReturnPointShopPurchaseSchemaState(db);
        if (before.kind === 'exact') return;

        const legacy0029 = await inspect0029LegacyReturnPointShopPurchaseSchemaState(db);
        if (legacy0029.kind === 'exact') {
            await migrate0029LegacyReturnPointShopPurchaseSchema(db);
            return;
        }

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
    RETURN_POINT_SHOP_0029_LEGACY_OBJECTS,
    RETURN_POINT_SHOP_PURCHASE_KEY,
    RETURN_POINT_SHOP_PURCHASE_MIGRATION,
    RETURN_POINT_SHOP_PURCHASE_OBJECTS,
    RETURN_POINT_SHOP_PURCHASE_VERSION,
    createMissingReturnPointShopPurchaseObjects,
    createReturnPointShopPurchaseObjects,
    inspect0029LegacyReturnPointShopPurchaseSchemaState,
    inspectReturnPointShopPurchaseSchemaState,
    migrate0029LegacyReturnPointShopPurchaseSchema,
    normalizeSql,
    schemaHasDivergentObject,
};