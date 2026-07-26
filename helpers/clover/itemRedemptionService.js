'use strict';

const crypto = require('crypto');
const { ensurePossessionsV1Schema } = require('./possessionsSchema');
const {
    consumeInventoryItemInTransaction,
    getReservedQuantityInTransaction,
    releaseInventoryReservationInTransaction,
    reserveInventoryItemInTransaction,
    serializeItem,
} = require('./inventoryService');
const { getItemUseAction } = require('./itemUseCatalog');
const { requireItemManager } = require('./itemAdminService');

class ItemRedemptionServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ItemRedemptionServiceError';
        this.code = code;
        this.details = details;
    }
}

function safeJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeRedemption(row) {
    if (!row) return null;
    const action = getItemUseAction({
        template_key: row.template_key,
        kind: row.redemption_kind,
    });
    return {
        id: Number(row.id),
        key: row.redemption_key,
        playerId: row.player_id,
        characterName:
            row.personagem_nome
            || row.nome
            || row.display_name
            || null,
        inventoryItemId: Number(row.inventory_item_id),
        reservationId: Number(row.reservation_id),
        templateKey: row.template_key,
        itemName: row.item_name,
        kind: row.redemption_kind,
        action,
        requestNote: row.request_note,
        resolutionNote: row.resolution_note,
        status: row.status,
        reservationStatus: row.reservation_status || null,
        requestedAt: row.requested_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        metadata: safeJson(row.metadata_json, {}),
    };
}

const REDEMPTION_SELECT = `
    SELECT
        redemption.*,
        reservation.status AS reservation_status,
        player.personagem_nome,
        player.nome,
        player.display_name
    FROM clover_item_redemptions redemption
    LEFT JOIN clover_inventory_reservations reservation
      ON reservation.id = redemption.reservation_id
    LEFT JOIN jogadores player
      ON player.id = redemption.player_id
`;

async function getRedemptionByKey(db, redemptionKey) {
    return db.get(
        `${REDEMPTION_SELECT}
         WHERE redemption.redemption_key = ? COLLATE NOCASE`,
        [String(redemptionKey || '').trim()]
    );
}

async function requestItemRedemption(db, playerId, inventoryItemId, note = null, options = {}) {
    await ensurePossessionsV1Schema(db);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) {
        throw new ItemRedemptionServiceError(
            'missing_idempotency_key',
            'O pedido precisa de uma chave contra duplicidade.'
        );
    }

    const itemId = Number(inventoryItemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new ItemRedemptionServiceError('invalid_item_id', 'Informe um item válido.');
    }

    const duplicate = await db.get(
        `${REDEMPTION_SELECT}
         WHERE redemption.idempotency_key = ?`,
        [idempotencyKey]
    );
    if (duplicate) {
        if (
            duplicate.player_id !== playerId
            || Number(duplicate.inventory_item_id) !== itemId
        ) {
            throw new ItemRedemptionServiceError(
                'idempotency_conflict',
                'Essa chave já pertence a outro pedido.'
            );
        }
        return {
            ok: true,
            duplicate: true,
            redemption: serializeRedemption(duplicate),
        };
    }

    const row = await db.get(
        'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
        [itemId, playerId]
    );
    if (!row) {
        throw new ItemRedemptionServiceError(
            'item_not_found',
            'Item não encontrado no inventário.'
        );
    }

    const reserved = await getReservedQuantityInTransaction(db, row.id);
    const item = serializeItem({ ...row, reserved_quantity: reserved });
    const action = getItemUseAction(item);
    if (!action || action.mode !== 'review_request') {
        throw new ItemRedemptionServiceError(
            'item_not_redeemable',
            action?.mode === 'contextual'
                ? 'Esse item é usado dentro da atividade correspondente, sem criar pedido de resgate.'
                : 'Esse item não usa a fila de resgate.',
            { action: action || null }
        );
    }
    if (item.status !== 'disponivel' || item.available_quantity < 1) {
        throw new ItemRedemptionServiceError(
            'item_not_available',
            'Item indisponível para resgate.'
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const active = await db.get(
            `${REDEMPTION_SELECT}
             WHERE redemption.inventory_item_id = ?
               AND redemption.status = 'pending'`,
            [item.id]
        );
        if (active) {
            await db.exec('COMMIT');
            return {
                ok: true,
                duplicate: true,
                redemption: serializeRedemption(active),
            };
        }

        const key = `RES-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        const reservation = await reserveInventoryItemInTransaction(
            db,
            playerId,
            item.id,
            1,
            {
                reservationKey: `item-redemption:${key}`,
                sourceType: 'item_redemption',
                sourceId: key,
                createdBy: playerId,
                metadata: {
                    action_key: action.actionKey,
                    via: options.metadata?.via || options.via || null,
                },
            }
        );

        const inserted = await db.run(
            `INSERT INTO clover_item_redemptions (
                redemption_key, player_id, inventory_item_id, reservation_id,
                template_key, item_name, redemption_kind, request_note,
                status, idempotency_key, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                key,
                playerId,
                item.id,
                reservation.id,
                item.template_key,
                item.item_name,
                item.kind,
                String(note || '').trim().slice(0, 500) || null,
                idempotencyKey,
                JSON.stringify({
                    action_key: action.actionKey,
                    action_destination: action.destination,
                    effect_status: action.effectStatus,
                    ...(options.metadata || {}),
                }),
            ]
        );
        const redemption = await db.get(
            `${REDEMPTION_SELECT}
             WHERE redemption.id = ?`,
            [inserted.lastID]
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            redemption: serializeRedemption(redemption),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listOwnItemRedemptions(db, playerId, limit = 20) {
    await ensurePossessionsV1Schema(db);
    const rows = await db.all(
        `${REDEMPTION_SELECT}
         WHERE redemption.player_id = ?
         ORDER BY redemption.id DESC
         LIMIT ?`,
        [playerId, Math.max(1, Math.min(100, Number(limit) || 20))]
    );
    return rows.map(serializeRedemption);
}

async function listPendingItemRedemptions(db, actorId, limit = 50) {
    await ensurePossessionsV1Schema(db);
    await requireItemManager(db, actorId);
    const rows = await db.all(
        `${REDEMPTION_SELECT}
         WHERE redemption.status = 'pending'
         ORDER BY redemption.requested_at ASC, redemption.id ASC
         LIMIT ?`,
        [Math.max(1, Math.min(200, Number(limit) || 50))]
    );
    return rows.map(serializeRedemption);
}

async function cancelItemRedemption(db, playerId, redemptionKey, options = {}) {
    await ensurePossessionsV1Schema(db);
    const row = await db.get(
        `${REDEMPTION_SELECT}
         WHERE redemption.player_id = ?
           AND redemption.redemption_key = ? COLLATE NOCASE
           AND redemption.status = 'pending'`,
        [playerId, String(redemptionKey || '').trim()]
    );
    if (!row) {
        throw new ItemRedemptionServiceError(
            'redemption_not_pending',
            'Pedido pendente não encontrado.'
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        await releaseInventoryReservationInTransaction(
            db,
            row.reservation_id,
            {
                metadata: {
                    cancelled_by: playerId,
                    reason: String(options.reason || '').trim() || null,
                },
            }
        );
        await db.run(
            `UPDATE clover_item_redemptions
             SET status = 'cancelled',
                 resolution_note = ?,
                 resolved_at = CURRENT_TIMESTAMP,
                 resolved_by = ?
             WHERE id = ? AND status = 'pending'`,
            [
                String(options.reason || '').trim().slice(0, 500) || 'Cancelado pelo jogador',
                playerId,
                row.id,
            ]
        );
        const updated = await getRedemptionByKey(db, row.redemption_key);
        await db.exec('COMMIT');
        return {
            ok: true,
            redemption: serializeRedemption(updated),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function resolveItemRedemption(db, actorId, redemptionKey, decision, note = null) {
    await ensurePossessionsV1Schema(db);
    const manager = await requireItemManager(db, actorId);
    const normalizedDecision = String(decision || '').toLowerCase();
    if (!['approved', 'rejected'].includes(normalizedDecision)) {
        throw new ItemRedemptionServiceError(
            'invalid_decision',
            'Decisão de resgate inválida.'
        );
    }

    const resolutionNote = String(note || '').trim().slice(0, 500);
    if (!resolutionNote) {
        throw new ItemRedemptionServiceError(
            'resolution_note_required',
            'Informe o resultado aplicado ou o motivo da recusa.'
        );
    }

    const row = await db.get(
        `${REDEMPTION_SELECT}
         WHERE redemption.redemption_key = ? COLLATE NOCASE
           AND redemption.status = 'pending'`,
        [String(redemptionKey || '').trim()]
    );
    if (!row) {
        throw new ItemRedemptionServiceError(
            'redemption_not_pending',
            'Pedido pendente não encontrado.'
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        if (normalizedDecision === 'approved') {
            const item = await db.get(
                'SELECT * FROM clover_inventory_items WHERE id = ?',
                [row.inventory_item_id]
            );
            if (!item) {
                throw new ItemRedemptionServiceError(
                    'item_not_found',
                    'Item reservado não foi encontrado.'
                );
            }
            await consumeInventoryItemInTransaction(db, item, 1, {
                reservationId: row.reservation_id,
                action: 'resgate_aprovado',
                source: 'item_redemption',
                relatedId: row.redemption_key,
                createdBy: manager.actorId,
                metadata: {
                    resolution_note: resolutionNote,
                    action_key: safeJson(row.metadata_json, {}).action_key || null,
                },
            });
        } else {
            await releaseInventoryReservationInTransaction(
                db,
                row.reservation_id,
                {
                    metadata: {
                        rejected_by: manager.actorId,
                        reason: resolutionNote,
                    },
                }
            );
        }

        await db.run(
            `UPDATE clover_item_redemptions
             SET status = ?,
                 resolution_note = ?,
                 resolved_at = CURRENT_TIMESTAMP,
                 resolved_by = ?
             WHERE id = ? AND status = 'pending'`,
            [normalizedDecision, resolutionNote, manager.actorId, row.id]
        );
        const updated = await getRedemptionByKey(db, row.redemption_key);
        await db.exec('COMMIT');
        return {
            ok: true,
            redemption: serializeRedemption(updated),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ItemRedemptionServiceError,
    cancelItemRedemption,
    getRedemptionByKey,
    listOwnItemRedemptions,
    listPendingItemRedemptions,
    requestItemRedemption,
    resolveItemRedemption,
    serializeRedemption,
};
