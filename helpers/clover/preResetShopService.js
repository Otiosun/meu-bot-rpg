'use strict';

const {
    ReturnPointsServiceError,
    appendReturnPointsInTransaction,
    getReturnPointsBalance,
    requiredText,
} = require('./returnPointsService');

class PreResetShopError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetShopError';
        this.code = code;
        this.details = details;
    }
}

function normalizeCatalog(catalog) {
    if (!Array.isArray(catalog)) throw new PreResetShopError('catalog_disabled', 'O catalogo pre-reset ainda nao esta publicado.');
    const entries = new Map();
    for (const raw of catalog) {
        const itemKey = requiredText(raw?.itemKey, 'itemKey', 120);
        const entitlementKey = requiredText(raw?.entitlementKey, 'entitlementKey', 120);
        const price = Number(raw?.priceReturnPoints);
        if (!Number.isInteger(price) || price <= 0) {
            throw new PreResetShopError('invalid_catalog', 'Preco de catalogo invalido.');
        }
        if (entries.has(itemKey)) throw new PreResetShopError('invalid_catalog', 'Item duplicado no catalogo.');
        entries.set(itemKey, Object.freeze({ itemKey, entitlementKey, priceReturnPoints: price }));
    }
    return entries;
}

function disabledPreResetCatalog() {
    return Object.freeze([]);
}

async function getPreResetEntitlements(db, playerId) {
    return db.all(
        `SELECT * FROM clover_prereset_entitlements WHERE player_id = ? ORDER BY id ASC`,
        [String(playerId)]
    );
}

async function purchasePreResetEntitlement(db, playerId, request = {}, options = {}) {
    const id = requiredText(playerId, 'playerId', 255);
    const itemKey = requiredText(request.itemKey, 'itemKey', 120);
    const idempotencyKey = requiredText(request.idempotencyKey, 'idempotencyKey', 160);
    const actorId = requiredText(request.actorId || playerId, 'actorId', 255);
    const item = normalizeCatalog(options.catalog).get(itemKey);
    if (!item) throw new PreResetShopError('catalog_item_not_found', 'Opcao pre-reset indisponivel.');

    await db.exec('BEGIN IMMEDIATE');
    try {
        const prior = await db.get('SELECT * FROM clover_prereset_purchases WHERE idempotency_key = ?', [idempotencyKey]);
        if (prior) {
            if (prior.player_id !== id || prior.catalog_item_key !== itemKey) {
                throw new PreResetShopError('idempotency_conflict', 'Chave de compra reutilizada com outro pedido.');
            }
            const entitlement = await db.get('SELECT * FROM clover_prereset_entitlements WHERE purchase_id = ?', [prior.id]);
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, purchase: prior, entitlement };
        }
        const existingEntitlement = await db.get(
            'SELECT id FROM clover_prereset_entitlements WHERE player_id = ? AND entitlement_key = ?',
            [id, item.entitlementKey]
        );
        if (existingEntitlement) {
            throw new PreResetShopError('entitlement_already_owned', 'Esse direito futuro ja foi adquirido.');
        }
        const debit = await appendReturnPointsInTransaction(db, id, {
            amount: item.priceReturnPoints,
            entryKind: 'debit',
            operationKey: `prereset-purchase:${idempotencyKey}`,
            source: 'prereset_shop',
            reason: `Aquisicao pre-reset: ${item.itemKey}`,
            relatedId: item.itemKey,
            correlationId: idempotencyKey,
            createdBy: actorId,
            metadata: { catalog_item_key: item.itemKey, entitlement_key: item.entitlementKey },
        });
        if (typeof options.transactionHook === 'function') await options.transactionHook('after_debit');
        const purchaseInsert = await db.run(
            `INSERT INTO clover_prereset_purchases
             (player_id, idempotency_key, catalog_item_key, entitlement_key, price_return_points,
              return_points_ledger_id, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, idempotencyKey, item.itemKey, item.entitlementKey, item.priceReturnPoints, debit.ledgerId,
                JSON.stringify({ catalog_item_key: item.itemKey })]
        );
        if (typeof options.transactionHook === 'function') await options.transactionHook('before_entitlement');
        const purchaseId = Number(purchaseInsert.lastID);
        await db.run(
            `INSERT INTO clover_prereset_entitlements
             (player_id, entitlement_key, purchase_id, metadata_json)
             VALUES (?, ?, ?, ?)`,
            [id, item.entitlementKey, purchaseId, JSON.stringify({ catalog_item_key: item.itemKey })]
        );
        const [purchase, entitlement] = await Promise.all([
            db.get('SELECT * FROM clover_prereset_purchases WHERE id = ?', [purchaseId]),
            db.get('SELECT * FROM clover_prereset_entitlements WHERE purchase_id = ?', [purchaseId]),
        ]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, purchase, entitlement, balanceAfter: await getReturnPointsBalance(db, id) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        if (error instanceof ReturnPointsServiceError) throw error;
        throw error;
    }
}

async function refundPreResetPurchase() {
    throw new PreResetShopError('refund_policy_required', 'A politica de estorno pre-reset ainda exige decisao de produto.');
}

module.exports = {
    PreResetShopError,
    disabledPreResetCatalog,
    getPreResetEntitlements,
    normalizeCatalog,
    purchasePreResetEntitlement,
    refundPreResetPurchase,
};
