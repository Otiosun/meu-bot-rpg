'use strict';

const crypto = require('crypto');
const { ensureCloverInventorySchema } = require('../../database');
const {
    consumeInventoryItemInTransaction,
    releaseInventoryReservationInTransaction,
    reserveInventoryItemInTransaction,
    serializeItem,
} = require('./inventoryService');
const { requireItemManager } = require('./itemAdminService');

const REDEEMABLE_KINDS = new Set(['ticket_feitico', 'acesso_missao']);

class ItemRedemptionServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ItemRedemptionServiceError';
        this.code = code;
        this.details = details;
    }
}

function serializeRedemption(row) {
    return row ? {
        id: Number(row.id),
        key: row.redemption_key,
        playerId: row.player_id,
        inventoryItemId: Number(row.inventory_item_id),
        templateKey: row.template_key,
        itemName: row.item_name,
        kind: row.redemption_kind,
        requestNote: row.request_note,
        resolutionNote: row.resolution_note,
        status: row.status,
        requestedAt: row.requested_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
    } : null;
}

async function requestItemRedemption(db, playerId, inventoryItemId, note = null, options = {}) {
    await ensureCloverInventorySchema(db);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new ItemRedemptionServiceError('missing_idempotency_key', 'O pedido precisa de uma chave contra duplicidade.');
    const duplicate = await db.get('SELECT * FROM clover_item_redemptions WHERE idempotency_key = ?', [idempotencyKey]);
    if (duplicate) return { ok: true, duplicate: true, redemption: serializeRedemption(duplicate) };
    const row = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [Number(inventoryItemId), playerId]);
    if (!row) throw new ItemRedemptionServiceError('item_not_found', 'Item não encontrado no inventário.');
    const item = serializeItem(row);
    if (!REDEEMABLE_KINDS.has(item.kind)) throw new ItemRedemptionServiceError('item_not_redeemable', 'Esse item não usa a fila de resgate.');
    if (item.status !== 'disponivel' || item.available_quantity < 1) throw new ItemRedemptionServiceError('item_not_available', 'Item indisponível para resgate.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        const active = await db.get("SELECT * FROM clover_item_redemptions WHERE inventory_item_id = ? AND status = 'pending'", [item.id]);
        if (active) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, redemption: serializeRedemption(active) };
        }
        const key = `RES-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        const reservation = await reserveInventoryItemInTransaction(db, playerId, item.id, 1, {
            reservationKey: `item-redemption:${key}`,
            sourceType: 'item_redemption', sourceId: key, createdBy: playerId,
        });
        const inserted = await db.run(
            `INSERT INTO clover_item_redemptions
             (redemption_key, player_id, inventory_item_id, reservation_id, template_key,
              item_name, redemption_kind, request_note, status, idempotency_key, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [key, playerId, item.id, reservation.id, item.template_key, item.item_name, item.kind,
                String(note || '').trim().slice(0, 500) || null, idempotencyKey, JSON.stringify(options.metadata || {})]
        );
        const redemption = await db.get('SELECT * FROM clover_item_redemptions WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, redemption: serializeRedemption(redemption) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listOwnItemRedemptions(db, playerId, limit = 20) {
    await ensureCloverInventorySchema(db);
    const rows = await db.all(
        'SELECT * FROM clover_item_redemptions WHERE player_id = ? ORDER BY id DESC LIMIT ?',
        [playerId, Math.max(1, Math.min(100, Number(limit) || 20))]
    );
    return rows.map(serializeRedemption);
}

async function listPendingItemRedemptions(db, actorId, limit = 50) {
    await ensureCloverInventorySchema(db);
    await requireItemManager(db, actorId);
    const rows = await db.all(
        "SELECT * FROM clover_item_redemptions WHERE status = 'pending' ORDER BY requested_at ASC, id ASC LIMIT ?",
        [Math.max(1, Math.min(200, Number(limit) || 50))]
    );
    return rows.map(serializeRedemption);
}

async function cancelItemRedemption(db, playerId, redemptionKey) {
    await ensureCloverInventorySchema(db);
    const row = await db.get(
        "SELECT * FROM clover_item_redemptions WHERE player_id = ? AND redemption_key = ? COLLATE NOCASE AND status = 'pending'",
        [playerId, String(redemptionKey || '').trim()]
    );
    if (!row) throw new ItemRedemptionServiceError('redemption_not_pending', 'Pedido pendente não encontrado.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        await releaseInventoryReservationInTransaction(db, row.reservation_id, { metadata: { cancelled_by: playerId } });
        await db.run(
            "UPDATE clover_item_redemptions SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?",
            [playerId, row.id]
        );
        await db.exec('COMMIT');
        return { ok: true };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function resolveItemRedemption(db, actorId, redemptionKey, decision, note = null) {
    await ensureCloverInventorySchema(db);
    const manager = await requireItemManager(db, actorId);
    const normalizedDecision = String(decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(normalizedDecision)) {
        throw new ItemRedemptionServiceError('invalid_decision', 'Decisão de resgate inválida.');
    }
    const row = await db.get(
        "SELECT * FROM clover_item_redemptions WHERE redemption_key = ? COLLATE NOCASE AND status = 'pending'",
        [String(redemptionKey || '').trim()]
    );
    if (!row) throw new ItemRedemptionServiceError('redemption_not_pending', 'Pedido pendente não encontrado.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        if (normalizedDecision === 'approved') {
            const item = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [row.inventory_item_id]);
            if (!item) throw new ItemRedemptionServiceError('item_not_found', 'Item reservado não foi encontrado.');
            await consumeInventoryItemInTransaction(db, item, 1, {
                reservationId: row.reservation_id,
                action: 'resgate_aprovado', source: 'item_redemption', relatedId: row.redemption_key,
                createdBy: manager.actorId,
            });
        } else {
            await releaseInventoryReservationInTransaction(db, row.reservation_id, { metadata: { rejected_by: manager.actorId } });
        }
        await db.run(
            `UPDATE clover_item_redemptions
             SET status = ?, resolution_note = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
             WHERE id = ?`,
            [normalizedDecision, String(note || '').trim().slice(0, 500) || null, manager.actorId, row.id]
        );
        const updated = await db.get('SELECT * FROM clover_item_redemptions WHERE id = ?', [row.id]);
        await db.exec('COMMIT');
        return { ok: true, redemption: serializeRedemption(updated) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ItemRedemptionServiceError,
    cancelItemRedemption,
    listOwnItemRedemptions,
    listPendingItemRedemptions,
    requestItemRedemption,
    resolveItemRedemption,
};
