'use strict';

const {
    ensureInventoryV1,
    getInventoryHistory,
    getReservedQuantityInTransaction,
    getStructuredInventory,
    recordHistory,
    releaseInventoryReservationInTransaction,
    serializeItem,
} = require('./inventoryService');

class AdminInventoryInstanceError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminInventoryInstanceError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function positiveId(value, field = 'itemId') {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        throw new AdminInventoryInstanceError('invalid_inventory_instance_id', `${field} inválido.`, 400, { field, value });
    }
    return id;
}

function asBoolean(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'sim', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function normalizeExpiry(value) {
    if (value === undefined) return undefined;
    if (value === null || String(value).trim() === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new AdminInventoryInstanceError('invalid_inventory_expiry', 'Validade do item inválida.');
    }
    return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function instanceSnapshot(row) {
    if (!row) return null;
    const serialized = serializeItem(row);
    return {
        id: Number(serialized.id),
        playerId: serialized.player_id,
        itemName: serialized.item_name,
        description: serialized.description || null,
        quantity: Number(serialized.quantity || 0),
        reservedQuantity: Number(serialized.reserved_quantity || 0),
        availableQuantity: Number(serialized.available_quantity || 0),
        kind: serialized.kind || null,
        source: serialized.source || null,
        relatedId: serialized.related_id || null,
        createdBy: serialized.created_by || null,
        createdAt: serialized.created_at || null,
        metadata: serialized.metadata || {},
        templateKey: serialized.template_key || null,
        catalogVersion: Number(serialized.catalog_version || 1),
        category: serialized.category || null,
        origin: serialized.origin || null,
        status: serialized.status || 'disponivel',
        quality: serialized.quality || 'comum',
        basePrice: Number(serialized.base_price || 0),
        referencePrice: Number(serialized.reference_price || 0),
        durabilityCurrent: serialized.durability_current === null ? null : Number(serialized.durability_current),
        durabilityMax: serialized.durability_max === null ? null : Number(serialized.durability_max),
        condition: serialized.condition || null,
        conditionDescription: serialized.condition_description || null,
        bound: Boolean(serialized.bound),
        transferable: Boolean(serialized.transferable),
        equippedSlot: serialized.equipped_slot || null,
        expiresAt: serialized.expires_at || null,
        updatedAt: serialized.updated_at || null,
        properties: serialized.properties || {},
        effects: serialized.effects || {},
    };
}

async function tableExists(db, table) {
    const row = await db.get(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [table]
    ).catch(() => null);
    return Boolean(row?.ok);
}

async function getRawInstance(db, playerId, itemId) {
    await ensureInventoryV1(db);
    const id = positiveId(itemId);
    const row = await db.get(
        `SELECT item.*,
                COALESCE((
                    SELECT SUM(reservation.quantity)
                    FROM clover_inventory_reservations reservation
                    WHERE reservation.inventory_item_id = item.id
                      AND reservation.status = 'active'
                ), 0) AS reserved_quantity
         FROM clover_inventory_items item
         WHERE item.id = ? AND item.player_id = ?`,
        [id, String(playerId || '').trim()]
    );
    if (!row) {
        throw new AdminInventoryInstanceError('inventory_instance_not_found', 'Exemplar de item não encontrado para este personagem.', 404, { itemId: id });
    }
    return row;
}

async function getInstanceLocks(db, row) {
    const locks = [];
    if (row.equipped_slot) {
        locks.push({ type: 'equipped', label: `Equipado em ${row.equipped_slot}`, ref: row.equipped_slot });
    }

    const reservations = await db.all(
        `SELECT id, reservation_key, quantity, source_type, source_id, expires_at, created_at
         FROM clover_inventory_reservations
         WHERE inventory_item_id = ? AND player_id = ? AND status = 'active'
         ORDER BY id ASC`,
        [row.id, row.player_id]
    );
    for (const reservation of reservations) {
        locks.push({
            type: 'reservation',
            label: `Reserva ativa (${reservation.source_type || 'generic'})`,
            ref: Number(reservation.id),
            quantity: Number(reservation.quantity || 0),
            sourceType: reservation.source_type || null,
            sourceId: reservation.source_id || null,
            expiresAt: reservation.expires_at || null,
        });
    }

    const optionalQueries = [
        ['clover_item_redemptions', "SELECT id, status FROM clover_item_redemptions WHERE inventory_item_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1", 'redemption', 'Resgate de item em andamento'],
        ['clover_market_listings', "SELECT id, status FROM clover_market_listings WHERE inventory_item_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", 'market', 'Anúncio ativo no mercado'],
        ['clover_economy_sale_intents', "SELECT id, status FROM clover_economy_sale_intents WHERE inventory_item_id = ? AND status IN ('pending', 'confirmed') ORDER BY id DESC LIMIT 1", 'sale_intent', 'Venda em andamento'],
        ['clover_repair_orders', "SELECT id, status FROM clover_repair_orders WHERE inventory_item_id = ? AND status IN ('pending', 'in_progress') ORDER BY id DESC LIMIT 1", 'repair', 'Reparo em andamento'],
        ['clover_active_item_effects', "SELECT id, status FROM clover_active_item_effects WHERE inventory_item_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", 'active_effect', 'Efeito ativo vinculado ao item'],
    ];
    for (const [table, sql, type, label] of optionalQueries) {
        if (!(await tableExists(db, table))) continue;
        const ref = await db.get(sql, [row.id]);
        if (ref) locks.push({ type, label, ref: Number(ref.id), status: ref.status || null });
    }

    return { blocking: locks.length > 0, locks, reservations };
}

async function listAdminPlayerInventory(db, playerId, options = {}) {
    const items = await getStructuredInventory(db, String(playerId || '').trim(), {
        limit: Math.max(1, Math.min(200, Number(options.limit) || 100)),
    });
    return { ok: true, items: items.map((item) => instanceSnapshot(item)) };
}

async function getAdminInventoryInstance(db, playerId, itemId, options = {}) {
    const row = await getRawInstance(db, playerId, itemId);
    const lockState = await getInstanceLocks(db, row);
    const history = await getInventoryHistory(db, row.player_id, row.id, Math.max(1, Math.min(100, Number(options.historyLimit) || 30)));
    return {
        ok: true,
        item: instanceSnapshot({ ...row, reserved_quantity: lockState.reservations.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0) }),
        locks: lockState.locks,
        reservations: lockState.reservations.map((entry) => ({
            id: Number(entry.id),
            quantity: Number(entry.quantity || 0),
            sourceType: entry.source_type || null,
            sourceId: entry.source_id || null,
            expiresAt: entry.expires_at || null,
            createdAt: entry.created_at || null,
        })),
        history: history.map((entry) => ({
            id: Number(entry.id),
            action: entry.action,
            quantityDelta: Number(entry.quantity_delta || 0),
            durabilityDelta: Number(entry.durability_delta || 0),
            source: entry.source || null,
            relatedId: entry.related_id || null,
            createdBy: entry.created_by || null,
            createdAt: entry.created_at || null,
            metadata: (() => { try { return entry.metadata_json ? JSON.parse(entry.metadata_json) : {}; } catch { return {}; } })(),
        })),
    };
}

function normalizeUpdatePayload(payload, before) {
    const next = { ...before };
    let changed = false;

    if (payload.quantity !== undefined || payload.quantidade !== undefined) {
        const quantity = Number(payload.quantity ?? payload.quantidade);
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1_000_000) {
            throw new AdminInventoryInstanceError('invalid_inventory_quantity', 'Quantidade precisa ser um inteiro positivo.');
        }
        if (quantity < Number(before.reservedQuantity || 0)) {
            throw new AdminInventoryInstanceError(
                'inventory_quantity_below_reserved',
                'A quantidade não pode ficar abaixo do total reservado.',
                409,
                { reserved: before.reservedQuantity, requested: quantity }
            );
        }
        next.quantity = quantity;
        next.availableQuantity = Math.max(0, quantity - Number(before.reservedQuantity || 0));
        changed ||= quantity !== before.quantity;
    }

    const durabilityValue = payload.durabilityCurrent ?? payload.durability_current ?? payload.durabilidadeAtual;
    if (durabilityValue !== undefined) {
        if (before.durabilityMax === null) {
            throw new AdminInventoryInstanceError('inventory_item_has_no_durability', 'Este item não possui durabilidade.');
        }
        const durability = Number(durabilityValue);
        if (!Number.isInteger(durability) || durability < 0 || durability > before.durabilityMax) {
            throw new AdminInventoryInstanceError('invalid_inventory_durability', 'Durabilidade fora do intervalo permitido.', 400, {
                minimum: 0,
                maximum: before.durabilityMax,
            });
        }
        next.durabilityCurrent = durability;
        next.status = durability === 0 ? 'quebrado' : (before.status === 'quebrado' ? 'disponivel' : before.status);
        changed ||= durability !== before.durabilityCurrent;
    }

    if (payload.bound !== undefined || payload.vinculado !== undefined) {
        const bound = asBoolean(payload.bound ?? payload.vinculado, before.bound);
        next.bound = bound;
        if (bound) next.transferable = false;
        changed ||= bound !== before.bound || next.transferable !== before.transferable;
    }
    if (payload.transferable !== undefined || payload.transferivel !== undefined) {
        const transferable = asBoolean(payload.transferable ?? payload.transferivel, before.transferable);
        next.transferable = transferable;
        if (transferable) next.bound = false;
        changed ||= transferable !== before.transferable || next.bound !== before.bound;
    }

    const expiry = normalizeExpiry(payload.expiresAt ?? payload.expires_at ?? payload.validade);
    if (expiry !== undefined) {
        next.expiresAt = expiry;
        changed ||= expiry !== before.expiresAt;
    }

    if (!changed) {
        throw new AdminInventoryInstanceError('empty_inventory_instance_update', 'Nenhuma alteração foi informada.');
    }
    return next;
}

function comparableSnapshot(snapshot) {
    if (!snapshot) return snapshot;
    const { availableQuantity, condition, conditionDescription, reservedQuantity, updatedAt, ...stable } = snapshot;
    return stable;
}

async function assertUnlocked(db, row) {
    const state = await getInstanceLocks(db, row);
    if (state.blocking) {
        throw new AdminInventoryInstanceError(
            'inventory_instance_locked',
            'O item possui vínculo operacional ativo. Resolva o vínculo antes de editar ou remover.',
            409,
            { locks: state.locks }
        );
    }
    return state;
}

async function assertCurrentMatches(db, playerId, expected) {
    const row = await getRawInstance(db, playerId, expected.id);
    const current = instanceSnapshot(row);
    if (!valuesMatch(comparableSnapshot(current), comparableSnapshot(expected))) {
        throw new AdminInventoryInstanceError(
            'inventory_instance_changed_after_preview',
            'O exemplar mudou depois da prévia. Gere uma nova prévia.',
            409,
            { itemId: expected.id }
        );
    }
    return row;
}

async function restoreSnapshot(db, snapshot) {
    await db.run(
        `UPDATE clover_inventory_items
         SET player_id = ?, item_name = ?, description = ?, quantity = ?, kind = ?, source = ?, related_id = ?,
             created_by = ?, created_at = ?, metadata_json = ?, template_key = ?, catalog_version = ?, category = ?, origin = ?,
             status = ?, quality = ?, base_price = ?, reference_price = ?, durability_current = ?, durability_max = ?,
             bound = ?, transferable = ?, equipped_slot = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP,
             properties_json = ?, effects_json = ?
         WHERE id = ?`,
        [
            snapshot.playerId, snapshot.itemName, snapshot.description, snapshot.quantity, snapshot.kind, snapshot.source,
            snapshot.relatedId, snapshot.createdBy, snapshot.createdAt, JSON.stringify(snapshot.metadata || {}), snapshot.templateKey,
            snapshot.catalogVersion, snapshot.category, snapshot.origin, snapshot.status, snapshot.quality, snapshot.basePrice,
            snapshot.referencePrice, snapshot.durabilityCurrent, snapshot.durabilityMax, snapshot.bound ? 1 : 0,
            snapshot.transferable ? 1 : 0, snapshot.equippedSlot, snapshot.expiresAt,
            JSON.stringify(snapshot.properties || {}), JSON.stringify(snapshot.effects || {}), snapshot.id,
        ]
    );
}

async function insertSnapshot(db, snapshot) {
    await db.run(
        `INSERT INTO clover_inventory_items
         (id, player_id, item_name, description, quantity, kind, source, related_id, created_by, created_at,
          metadata_json, template_key, catalog_version, category, origin, status, quality, base_price, reference_price,
          durability_current, durability_max, bound, transferable, equipped_slot, expires_at, updated_at,
          properties_json, effects_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
            snapshot.id, snapshot.playerId, snapshot.itemName, snapshot.description, snapshot.quantity, snapshot.kind,
            snapshot.source, snapshot.relatedId, snapshot.createdBy, snapshot.createdAt, JSON.stringify(snapshot.metadata || {}),
            snapshot.templateKey, snapshot.catalogVersion, snapshot.category, snapshot.origin, snapshot.status, snapshot.quality,
            snapshot.basePrice, snapshot.referencePrice, snapshot.durabilityCurrent, snapshot.durabilityMax,
            snapshot.bound ? 1 : 0, snapshot.transferable ? 1 : 0, snapshot.equippedSlot, snapshot.expiresAt,
            JSON.stringify(snapshot.properties || {}), JSON.stringify(snapshot.effects || {}),
        ]
    );
}

async function assertNoHistoryAfter(db, itemId, historyId) {
    const later = await db.get(
        'SELECT id, action FROM clover_inventory_item_history WHERE item_id = ? AND id > ? ORDER BY id ASC LIMIT 1',
        [itemId, Number(historyId || 0)]
    );
    if (later) {
        throw new AdminInventoryInstanceError(
            'inventory_instance_history_changed',
            'O exemplar recebeu alteração posterior e não pode ser desfeito automaticamente.',
            409,
            { itemId, laterHistoryId: Number(later.id), laterAction: later.action }
        );
    }
}

function createInventoryInstanceExecutors() {
    return {
        'player.item.update': {
            async preview({ db, action, target }) {
                const detail = await getAdminInventoryInstance(db, target.playerId, action.payload?.itemId || action.payload?.item_id || action.payload?.id);
                if (detail.locks.length) {
                    throw new AdminInventoryInstanceError('inventory_instance_locked', 'O item possui vínculo operacional ativo.', 409, { locks: detail.locks });
                }
                const after = normalizeUpdatePayload(action.payload || {}, detail.item);
                return {
                    summary: `${target.characterName || target.playerId}: corrigir ${detail.item.itemName}`,
                    before: detail.item,
                    after,
                };
            },
            async apply({ db, operation, unit, target, before, after }) {
                const row = await assertCurrentMatches(db, target.playerId, before);
                await assertUnlocked(db, row);
                await db.run(
                    `UPDATE clover_inventory_items
                     SET quantity = ?, durability_current = ?, status = ?, bound = ?, transferable = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND player_id = ?`,
                    [
                        after.quantity, after.durabilityCurrent, after.status, after.bound ? 1 : 0,
                        after.transferable ? 1 : 0, after.expiresAt, before.id, target.playerId,
                    ]
                );
                const current = instanceSnapshot(await getRawInstance(db, target.playerId, before.id));
                const historyId = await recordHistory(db, {
                    itemId: before.id,
                    playerId: target.playerId,
                    action: 'ajuste_admin',
                    quantityDelta: current.quantity - before.quantity,
                    durabilityDelta: Number(current.durabilityCurrent || 0) - Number(before.durabilityCurrent || 0),
                    before,
                    after: current,
                    source: 'admin_operation',
                    relatedId: operation.code,
                    idempotencyKey: `${operation.code}:unit:${unit.id}:inventory-update`,
                    createdBy: operation.actor.id,
                    metadata: { fields: ['quantity', 'durability_current', 'status', 'bound', 'transferable', 'expires_at'] },
                });
                return { after: { ...current, historyId }, summary: `${current.itemName}: exemplar corrigido.` };
            },
            async undo({ db, operation, unit, target, before, after }) {
                const row = await assertCurrentMatches(db, target.playerId, after);
                await assertUnlocked(db, row);
                const appliedHistoryId = after?.historyId ?? unit?.after?.historyId ?? 0;
                await assertNoHistoryAfter(db, after.id, appliedHistoryId);
                await restoreSnapshot(db, before);
                await recordHistory(db, {
                    itemId: before.id,
                    playerId: target.playerId,
                    action: 'ajuste_admin_desfeito',
                    quantityDelta: before.quantity - after.quantity,
                    durabilityDelta: Number(before.durabilityCurrent || 0) - Number(after.durabilityCurrent || 0),
                    before: after,
                    after: before,
                    source: 'admin_operation_undo',
                    relatedId: operation.code,
                    idempotencyKey: `${operation.code}:inventory-update-undo:${before.id}`,
                    createdBy: operation.actor.id,
                });
            },
        },
        'player.item.remove': {
            async preview({ db, action, target }) {
                const detail = await getAdminInventoryInstance(db, target.playerId, action.payload?.itemId || action.payload?.item_id || action.payload?.id);
                if (detail.locks.length) {
                    throw new AdminInventoryInstanceError('inventory_instance_locked', 'O item possui vínculo operacional ativo e não pode ser removido.', 409, { locks: detail.locks });
                }
                return {
                    summary: `${target.characterName || target.playerId}: remover ${detail.item.itemName}`,
                    before: detail.item,
                    after: null,
                };
            },
            async apply({ db, operation, unit, target, before }) {
                const row = await assertCurrentMatches(db, target.playerId, before);
                await assertUnlocked(db, row);
                await db.run('DELETE FROM clover_inventory_items WHERE id = ? AND player_id = ?', [before.id, target.playerId]);
                const historyId = await recordHistory(db, {
                    itemId: before.id,
                    playerId: target.playerId,
                    action: 'removido_admin',
                    quantityDelta: -before.quantity,
                    durabilityDelta: 0,
                    before,
                    after: null,
                    source: 'admin_operation',
                    relatedId: operation.code,
                    idempotencyKey: `${operation.code}:unit:${unit.id}:inventory-remove`,
                    createdBy: operation.actor.id,
                });
                return {
                    after: { removed: true, itemId: before.id, itemName: before.itemName, snapshot: before, historyId },
                    summary: `${before.itemName}: exemplar removido.`,
                };
            },
            async undo({ db, operation, target, after }) {
                const existing = await db.get('SELECT id FROM clover_inventory_items WHERE id = ?', [after.itemId]);
                if (existing) {
                    throw new AdminInventoryInstanceError('inventory_instance_id_reused', 'O identificador do exemplar já voltou a existir e não pode ser restaurado automaticamente.', 409);
                }
                await assertNoHistoryAfter(db, after.itemId, after.historyId);
                await insertSnapshot(db, after.snapshot);
                await recordHistory(db, {
                    itemId: after.itemId,
                    playerId: target.playerId,
                    action: 'remocao_admin_desfeita',
                    quantityDelta: after.snapshot.quantity,
                    before: null,
                    after: after.snapshot,
                    source: 'admin_operation_undo',
                    relatedId: operation.code,
                    idempotencyKey: `${operation.code}:inventory-remove-undo:${after.itemId}`,
                    createdBy: operation.actor.id,
                });
            },
        },
        'player.item.release_reservation': {
            async preview({ db, action, target }) {
                await ensureInventoryV1(db);
                const reservationId = positiveId(action.payload?.reservationId || action.payload?.reservation_id, 'reservationId');
                const reservation = await db.get(
                    `SELECT reservation.*, item.item_name
                     FROM clover_inventory_reservations reservation
                     JOIN clover_inventory_items item ON item.id = reservation.inventory_item_id
                     WHERE reservation.id = ? AND reservation.player_id = ?`,
                    [reservationId, target.playerId]
                );
                if (!reservation) throw new AdminInventoryInstanceError('inventory_reservation_not_found', 'Reserva não encontrada.', 404);
                if (reservation.status !== 'active') throw new AdminInventoryInstanceError('inventory_reservation_not_active', 'A reserva já não está ativa.', 409);
                const before = {
                    id: Number(reservation.id),
                    itemId: Number(reservation.inventory_item_id),
                    itemName: reservation.item_name,
                    playerId: reservation.player_id,
                    quantity: Number(reservation.quantity || 0),
                    sourceType: reservation.source_type,
                    sourceId: reservation.source_id,
                    status: reservation.status,
                    expiresAt: reservation.expires_at || null,
                    metadataJson: reservation.metadata_json || null,
                };
                return {
                    summary: `${target.characterName || target.playerId}: liberar reserva de ${reservation.item_name}`,
                    before,
                    after: { ...before, status: 'released' },
                };
            },
            async apply({ db, operation, before }) {
                const current = await db.get('SELECT * FROM clover_inventory_reservations WHERE id = ?', [before.id]);
                if (!current || current.status !== 'active') {
                    throw new AdminInventoryInstanceError('inventory_reservation_changed_after_preview', 'A reserva mudou depois da prévia.', 409);
                }
                const released = await releaseInventoryReservationInTransaction(db, before.id, {
                    metadata: { adminOperation: operation.code, adminReason: operation.reason || null },
                });
                return {
                    after: { ...before, status: released.status, releasedAt: released.released_at || null },
                    summary: `${before.itemName}: reserva liberada.`,
                };
            },
            async undo({ db, operation, before, after }) {
                const current = await db.get('SELECT * FROM clover_inventory_reservations WHERE id = ?', [before.id]);
                if (!current || current.status !== 'released') {
                    throw new AdminInventoryInstanceError('inventory_reservation_changed_since_release', 'A reserva mudou depois da liberação e não pode ser reativada automaticamente.', 409);
                }
                if (before.expiresAt && new Date(before.expiresAt.replace(' ', 'T') + 'Z').getTime() <= Date.now()) {
                    throw new AdminInventoryInstanceError('inventory_reservation_expired', 'A reserva original já expirou e não pode ser reativada.', 409);
                }
                const item = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [before.itemId, before.playerId]);
                if (!item) throw new AdminInventoryInstanceError('inventory_instance_not_found', 'O item da reserva não existe mais.', 409);
                const reservedByOthers = await getReservedQuantityInTransaction(db, before.itemId);
                if (Number(item.quantity || 0) - reservedByOthers < before.quantity) {
                    throw new AdminInventoryInstanceError('inventory_reservation_capacity_changed', 'A quantidade disponível já não comporta reativar a reserva.', 409);
                }
                await db.run(
                    `UPDATE clover_inventory_reservations
                     SET status = 'active', released_at = NULL, updated_at = CURRENT_TIMESTAMP, metadata_json = ?
                     WHERE id = ? AND status = 'released'`,
                    [before.metadataJson, before.id]
                );
                await recordHistory(db, {
                    itemId: before.itemId,
                    playerId: before.playerId,
                    action: 'reserva_admin_reativada',
                    before: after,
                    after: before,
                    source: 'admin_operation_undo',
                    relatedId: operation.code,
                    idempotencyKey: `${operation.code}:reservation-release-undo:${before.id}`,
                    createdBy: operation.actor.id,
                });
            },
        },
    };
}

module.exports = {
    AdminInventoryInstanceError,
    createInventoryInstanceExecutors,
    getAdminInventoryInstance,
    getInstanceLocks,
    instanceSnapshot,
    listAdminPlayerInventory,
    normalizeUpdatePayload,
};
