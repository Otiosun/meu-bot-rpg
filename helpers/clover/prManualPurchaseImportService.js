'use strict';

const crypto = require('crypto');

class PrManualPurchaseImportError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PrManualPurchaseImportError';
        this.code = code;
        this.details = details;
    }
}

function normalizeRequiredText(value, field) {
    const text = String(value || '').trim();
    if (!text) {
        throw new PrManualPurchaseImportError(
            'invalid_manual_purchase_entry',
            `Campo obrigatorio ausente: ${field}.`,
            { field }
        );
    }
    return text;
}

function normalizeOptionalText(value) {
    const text = String(value || '').trim();
    return text || null;
}

function normalizeQuantity(value) {
    const quantity = Number(value ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        throw new PrManualPurchaseImportError(
            'invalid_quantity',
            'A quantidade manual precisa ficar entre 1 e 100.'
        );
    }
    return quantity;
}

function stableHash(parts) {
    return crypto
        .createHash('sha256')
        .update(parts.map((part) => String(part ?? '')).join('\u001f'))
        .digest('hex')
        .slice(0, 16);
}

async function ensurePreresetManualPurchaseSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_prereset_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            catalog_item_key TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            price_return_points INTEGER NOT NULL DEFAULT 0,
            return_points_ledger_id INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'completed',
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS clover_prereset_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            entitlement_key TEXT NOT NULL,
            purchase_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            consumed_at TEXT DEFAULT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prereset_purchases_idempotency
        ON clover_prereset_purchases (idempotency_key);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_prereset_entitlements_purchase
        ON clover_prereset_entitlements (purchase_id);
        CREATE INDEX IF NOT EXISTS idx_prereset_entitlements_player_status
        ON clover_prereset_entitlements (player_id, status, entitlement_key);
    `);
}

function buildUnit(entry, options, unitIndex) {
    const playerId = normalizeRequiredText(entry.playerId, 'playerId');
    const catalogItemKey = normalizeRequiredText(
        entry.catalogItemKey,
        'catalogItemKey'
    ).toLowerCase();
    const importKey = normalizeRequiredText(options.importKey, 'importKey');
    const entitlementBase = normalizeRequiredText(
        entry.entitlementKey || catalogItemKey,
        'entitlementKey'
    );
    const quantity = normalizeQuantity(entry.quantity);
    const suffix = quantity === 1 ? '' : `#${unitIndex + 1}`;
    const entitlementKey = `${entitlementBase}${suffix}`;
    const targetRollNumber = entry.targetRollNumber ?? entry.rollNumber ?? null;
    const idempotencyKey = normalizeOptionalText(entry.idempotencyKey)
        || `manual:return-shop:${stableHash([
            importKey,
            playerId,
            catalogItemKey,
            entitlementKey,
            targetRollNumber,
        ])}`;

    return {
        playerId,
        catalogItemKey,
        entitlementKey,
        idempotencyKey,
        priceReturnPoints: Number(entry.priceReturnPoints || 0),
        createdBy: normalizeOptionalText(options.createdBy),
        metadata: {
            manual: true,
            source: 'return_shop_manual_import',
            source_import_key: importKey,
            source_row_id: normalizeOptionalText(entry.sourceRowId),
            external_reference: normalizeOptionalText(entry.externalReference),
            note: normalizeOptionalText(entry.note),
            fulfillment_status: 'pending',
            target_roll_number: targetRollNumber,
            original_quantity: quantity,
            unit_index: unitIndex + 1,
            created_by: normalizeOptionalText(options.createdBy),
        },
    };
}

async function findExistingPurchase(db, idempotencyKey) {
    return db.get(
        `SELECT p.*, e.id AS entitlement_id, e.status AS entitlement_status
         FROM clover_prereset_purchases p
         LEFT JOIN clover_prereset_entitlements e ON e.purchase_id = p.id
         WHERE p.idempotency_key = ?`,
        [idempotencyKey]
    );
}

function serialize(row, duplicate) {
    return {
        duplicate,
        purchaseId: row.id,
        entitlementId: row.entitlement_id || null,
        playerId: row.player_id,
        catalogItemKey: row.catalog_item_key,
        entitlementKey: row.entitlement_key,
        status: row.status,
        entitlementStatus: row.entitlement_status || null,
    };
}

async function insertUnit(db, unit) {
    const existing = await findExistingPurchase(db, unit.idempotencyKey);
    if (existing) {
        if (
            existing.player_id !== unit.playerId
            || existing.catalog_item_key !== unit.catalogItemKey
            || existing.entitlement_key !== unit.entitlementKey
        ) {
            throw new PrManualPurchaseImportError(
                'idempotency_conflict',
                'A chave manual ja existe para outra compra.',
                { idempotencyKey: unit.idempotencyKey }
            );
        }
        return serialize(existing, true);
    }

    const metadataJson = JSON.stringify(unit.metadata);
    const inserted = await db.run(
        `INSERT INTO clover_prereset_purchases (
            player_id, idempotency_key, catalog_item_key, entitlement_key,
            price_return_points, return_points_ledger_id, status,
            metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, 0, 'completed', ?, CURRENT_TIMESTAMP)`,
        [
            unit.playerId,
            unit.idempotencyKey,
            unit.catalogItemKey,
            unit.entitlementKey,
            unit.priceReturnPoints,
            metadataJson,
        ]
    );
    const purchaseId = inserted.lastID;
    const entitlement = await db.run(
        `INSERT INTO clover_prereset_entitlements (
            player_id, entitlement_key, purchase_id, status,
            metadata_json, created_at
         ) VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)`,
        [unit.playerId, unit.entitlementKey, purchaseId, metadataJson]
    );
    return {
        duplicate: false,
        purchaseId,
        entitlementId: entitlement.lastID,
        playerId: unit.playerId,
        catalogItemKey: unit.catalogItemKey,
        entitlementKey: unit.entitlementKey,
        status: 'completed',
        entitlementStatus: 'active',
    };
}

async function importManualReturnShopPurchases(db, entries, options = {}) {
    if (!Array.isArray(entries)) {
        throw new PrManualPurchaseImportError(
            'invalid_entries',
            'A importacao manual precisa receber uma lista.'
        );
    }
    await ensurePreresetManualPurchaseSchema(db);

    const units = [];
    for (const entry of entries) {
        const quantity = normalizeQuantity(entry?.quantity);
        for (let index = 0; index < quantity; index += 1) {
            units.push(buildUnit(entry, options, index));
        }
    }

    const result = {
        created: 0,
        duplicates: 0,
        entries: [],
    };

    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const unit of units) {
            const saved = await insertUnit(db, unit);
            if (saved.duplicate) {
                result.duplicates += 1;
            } else {
                result.created += 1;
            }
            result.entries.push(saved);
        }
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    PrManualPurchaseImportError,
    ensurePreresetManualPurchaseSchema,
    importManualReturnShopPurchases,
};
