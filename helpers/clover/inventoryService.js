'use strict';

const { ensureCloverInventorySchema } = require('../../database');
const { ITEM_TEMPLATES } = require('./economyItemCatalog');

const QUALITY_MULTIPLIERS = Object.freeze({
    comum: 1,
    refinada: 1.5,
    superior: 2.5,
});

class InventoryServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'InventoryServiceError';
        this.code = code;
        this.details = details;
    }
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function calculateReferencePrice(basePrice, quality = 'comum', ownPrice = null) {
    const base = Math.max(0, Number(basePrice) || 0);
    if (quality === 'obra_prima') {
        const value = Number(ownPrice);
        if (!Number.isInteger(value) || value < 0) {
            throw new InventoryServiceError('missing_masterpiece_price', 'Obra-prima precisa de valor próprio.');
        }
        return value;
    }
    const multiplier = QUALITY_MULTIPLIERS[quality];
    if (!multiplier) throw new InventoryServiceError('invalid_quality', 'Qualidade de item inválida.');
    return Math.floor(base * multiplier);
}

function calculateCondition(current, maximum) {
    if (current === null || current === undefined || maximum === null || maximum === undefined) return null;
    const max = Math.max(0, Number(maximum) || 0);
    const value = Math.max(0, Math.min(max, Number(current) || 0));
    if (value === 0) return 'quebrado';
    if (value * 3 > max * 2) return 'integro';
    if (value * 3 > max) return 'desgastado';
    return 'danificado';
}

function formatSqliteDate(date) {
    const value = new Date(date);
    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function expiryFromDays(days, from = new Date()) {
    if (!days) return null;
    const date = new Date(from);
    date.setDate(date.getDate() + Number(days));
    return formatSqliteDate(date);
}

async function seedItemCatalog(db) {
    await ensureCloverInventorySchema(db);
    for (const item of ITEM_TEMPLATES) {
        const requestable = item.basePrice > 0
            && item.transferable
            && !['servico', 'caixa', 'titulo', 'missao'].includes(item.category);
        await db.run(
            `INSERT INTO clover_item_templates (
                template_key, catalog_version, item_name, description, category, kind, origin,
                base_price, default_quality, default_durability, stackable, transferable,
                properties_json, effects_json, metadata_json, active, is_custom, requestable,
                marketable, duplicable, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 1, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(template_key) DO UPDATE SET
                catalog_version = excluded.catalog_version,
                item_name = excluded.item_name,
                description = excluded.description,
                category = excluded.category,
                kind = excluded.kind,
                origin = excluded.origin,
                base_price = excluded.base_price,
                default_quality = excluded.default_quality,
                default_durability = excluded.default_durability,
                stackable = excluded.stackable,
                transferable = excluded.transferable,
                properties_json = excluded.properties_json,
                effects_json = excluded.effects_json,
                metadata_json = excluded.metadata_json,
                active = 1,
                is_custom = 0,
                requestable = excluded.requestable,
                marketable = excluded.marketable,
                duplicable = 1,
                updated_at = CURRENT_TIMESTAMP`,
            [
                item.key,
                item.catalogVersion,
                item.itemName,
                item.description,
                item.category,
                item.kind,
                item.origin,
                item.basePrice,
                item.defaultQuality,
                item.defaultDurability,
                item.stackable ? 1 : 0,
                item.transferable ? 1 : 0,
                JSON.stringify(item.properties),
                JSON.stringify(item.effects),
                JSON.stringify(item.metadata),
                requestable ? 1 : 0,
                item.transferable ? 1 : 0,
            ]
        );
    }
}

function serializeTemplateRow(row) {
    if (!row) return null;
    return {
        key: row.template_key,
        catalogVersion: Number(row.catalog_version || 1),
        itemName: row.item_name,
        description: row.description,
        category: row.category,
        kind: row.kind,
        origin: row.origin || 'Clover',
        basePrice: Number(row.base_price || 0),
        defaultQuality: row.default_quality || 'comum',
        defaultDurability: row.default_durability === null ? null : Number(row.default_durability),
        stackable: Boolean(row.stackable),
        transferable: Boolean(row.transferable),
        requestable: Boolean(row.requestable),
        marketable: Boolean(row.marketable),
        duplicable: Boolean(row.duplicable),
        custom: Boolean(row.is_custom),
        active: Boolean(row.active),
        properties: safeJsonParse(row.properties_json, {}),
        effects: safeJsonParse(row.effects_json, {}),
        metadata: safeJsonParse(row.metadata_json, {}),
        createdBy: row.created_by || null,
        updatedBy: row.updated_by || null,
    };
}

async function getItemTemplateInTransaction(db, templateKey) {
    const key = String(templateKey || '').trim();
    if (!key) return null;
    const row = await db.get(
        `SELECT * FROM clover_item_templates
         WHERE active = 1 AND (template_key = ? COLLATE NOCASE OR item_name = ? COLLATE NOCASE)
         ORDER BY CASE WHEN template_key = ? COLLATE NOCASE THEN 0 ELSE 1 END, is_custom DESC
         LIMIT 1`,
        [key, key, key]
    );
    return serializeTemplateRow(row);
}

async function getItemTemplate(db, templateKey) {
    await ensureInventoryV1(db);
    return getItemTemplateInTransaction(db, templateKey);
}

async function hydrateLegacyInventory(db) {
    const byName = new Map(ITEM_TEMPLATES.map((item) => [normalizeName(item.itemName), item]));
    const rows = await db.all(
        `SELECT * FROM clover_inventory_items
         WHERE template_key IS NULL
         ORDER BY id ASC`
    );
    for (const row of rows) {
        if (row.kind === 'caixa_pa') continue;
        const item = byName.get(normalizeName(row.item_name));
        if (!item) continue;
        const durability = item.defaultDurability;
        const bound = item.transferable ? Number(row.bound || 0) : 1;
        await db.run(
            `UPDATE clover_inventory_items
             SET template_key = ?, catalog_version = ?, category = ?, kind = ?, origin = ?,
                 quality = 'comum', base_price = ?, reference_price = ?,
                 durability_current = COALESCE(durability_current, ?),
                 durability_max = COALESCE(durability_max, ?),
                 bound = ?, transferable = ?, status = COALESCE(NULLIF(status, ''), 'disponivel'),
                 properties_json = COALESCE(properties_json, ?),
                 effects_json = COALESCE(effects_json, ?),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                item.key,
                item.catalogVersion,
                item.category,
                item.kind,
                item.origin,
                item.basePrice,
                calculateReferencePrice(item.basePrice, 'comum'),
                durability,
                durability,
                bound,
                item.transferable && !bound ? 1 : 0,
                JSON.stringify(item.properties),
                JSON.stringify(item.effects),
                row.id,
            ]
        );
    }
}

async function ensureInventoryV1(db) {
    await ensureCloverInventorySchema(db);
    await seedItemCatalog(db);
    await hydrateLegacyInventory(db);
}

function serializeItem(row) {
    if (!row) return null;
    const quantity = Number(row.quantity || 0);
    const reservedQuantity = Math.max(0, Number(row.reserved_quantity || 0));
    const properties = safeJsonParse(row.properties_json, {});
    const condition = calculateCondition(row.durability_current, row.durability_max);
    return {
        ...row,
        quantity,
        reserved_quantity: reservedQuantity,
        available_quantity: Math.max(0, quantity - reservedQuantity),
        catalog_version: Number(row.catalog_version || 1),
        base_price: Number(row.base_price || 0),
        reference_price: Number(row.reference_price || 0),
        durability_current: row.durability_current === null ? null : Number(row.durability_current),
        durability_max: row.durability_max === null ? null : Number(row.durability_max),
        bound: Boolean(row.bound),
        transferable: Boolean(row.transferable),
        condition,
        condition_description: condition ? properties.conditionDescriptions?.[condition] || null : null,
        properties,
        effects: safeJsonParse(row.effects_json, {}),
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

async function recordHistory(db, entry) {
    const result = await db.run(
        `INSERT INTO clover_inventory_item_history
         (item_id, player_id, action, quantity_delta, durability_delta, before_json,
          after_json, source, related_id, idempotency_key, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            entry.itemId || null,
            entry.playerId,
            entry.action,
            Number(entry.quantityDelta || 0),
            Number(entry.durabilityDelta || 0),
            entry.before ? JSON.stringify(entry.before) : null,
            entry.after ? JSON.stringify(entry.after) : null,
            entry.source || null,
            entry.relatedId || null,
            entry.idempotencyKey || null,
            entry.createdBy || null,
            JSON.stringify(entry.metadata || {}),
        ]
    );
    return result.lastID;
}

async function ensurePlayer(db, playerId) {
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new InventoryServiceError('player_not_found', 'Player não encontrado.');
}

async function insertCatalogRow(db, playerId, item, quantity, options) {
    const quality = options.quality || item.defaultQuality || 'comum';
    const durability = options.durabilityMax ?? item.defaultDurability;
    const bound = options.bound === undefined ? !item.transferable : Boolean(options.bound);
    const ownPrice = quality === 'obra_prima' && options.ownPrice === undefined
        ? item.basePrice
        : options.ownPrice;
    const referencePrice = calculateReferencePrice(item.basePrice, quality, ownPrice);
    const expiresAt = options.expiresAt || expiryFromDays(options.expiresInDays, options.now || new Date());
    const inserted = await db.run(
        `INSERT INTO clover_inventory_items (
            player_id, item_name, description, quantity, kind, source, related_id, created_by,
            created_at, metadata_json, template_key, catalog_version, category, origin, status,
            quality, base_price, reference_price, durability_current, durability_max, bound,
            transferable, equipped_slot, expires_at, updated_at, properties_json, effects_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
            playerId,
            options.itemName || item.itemName,
            options.description || item.description,
            quantity,
            item.kind,
            options.source || 'economia_v1',
            options.relatedId || null,
            options.createdBy || null,
            JSON.stringify({
                ...item.metadata,
                template_flags: {
                    custom: Boolean(item.custom),
                    marketable: item.marketable !== false,
                    requestable: Boolean(item.requestable),
                    duplicable: item.duplicable !== false,
                },
                ...(options.metadata || {}),
            }),
            item.key,
            item.catalogVersion,
            item.category,
            item.origin,
            options.status || 'disponivel',
            quality,
            item.basePrice,
            referencePrice,
            durability,
            durability,
            bound ? 1 : 0,
            item.transferable && !bound ? 1 : 0,
            expiresAt,
            JSON.stringify({ ...item.properties, ...(options.properties || {}) }),
            JSON.stringify({ ...item.effects, ...(options.effects || {}) }),
        ]
    );
    return db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [inserted.lastID]);
}

async function addCatalogItemInTransaction(db, playerId, templateKey, quantity = 1, options = {}) {
    await ensurePlayer(db, playerId);
    const item = await getItemTemplateInTransaction(db, templateKey);
    if (!item) throw new InventoryServiceError('template_not_found', 'Item não existe no catálogo.');
    const amount = Number(quantity);
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new InventoryServiceError('invalid_quantity', 'Quantidade de item inválida.');
    }
    if (item.duplicable === false) {
        if (amount !== 1) throw new InventoryServiceError('unique_item_quantity', 'Item único só pode existir em uma unidade.');
        const existingUnique = await db.get(
            'SELECT COALESCE(SUM(quantity), 0) AS total FROM clover_inventory_items WHERE template_key = ?',
            [item.key]
        );
        if (Number(existingUnique?.total || 0) > 0) {
            throw new InventoryServiceError('unique_item_exists', 'Já existe um exemplar ativo desse item único.');
        }
    }

    const expiresAt = options.expiresAt || expiryFromDays(options.expiresInDays, options.now || new Date());
    if (item.stackable && item.defaultDurability === null && !options.forceSeparate) {
        const existing = await db.get(
            `SELECT * FROM clover_inventory_items
             WHERE player_id = ? AND template_key = ? AND status = ?
               AND quality = ? AND bound = ?
               AND COALESCE(expires_at, '') = COALESCE(?, '')
             ORDER BY id ASC LIMIT 1`,
            [
                playerId,
                item.key,
                options.status || 'disponivel',
                options.quality || item.defaultQuality,
                options.bound === undefined ? (item.transferable ? 0 : 1) : (options.bound ? 1 : 0),
                expiresAt,
            ]
        );
        if (existing) {
            const before = serializeItem(existing);
            await db.run(
                `UPDATE clover_inventory_items
                 SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [amount, existing.id]
            );
            const updated = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [existing.id]);
            await recordHistory(db, {
                itemId: existing.id,
                playerId,
                action: 'adicionado',
                quantityDelta: amount,
                before,
                after: serializeItem(updated),
                ...options,
            });
            return { ok: true, stacked: true, items: [serializeItem(updated)], quantity: amount };
        }
    }

    const rows = [];
    const insertCount = item.stackable ? 1 : amount;
    const rowQuantity = item.stackable ? amount : 1;
    for (let index = 0; index < insertCount; index += 1) {
        const row = await insertCatalogRow(db, playerId, item, rowQuantity, { ...options, expiresAt });
        const serialized = serializeItem(row);
        await recordHistory(db, {
            itemId: row.id,
            playerId,
            action: 'adicionado',
            quantityDelta: rowQuantity,
            before: null,
            after: serialized,
            ...options,
        });
        rows.push(serialized);
    }
    return { ok: true, stacked: false, items: rows, quantity: amount };
}

async function addCatalogItem(db, playerId, templateKey, quantity = 1, options = {}) {
    await ensureInventoryV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await addCatalogItemInTransaction(db, playerId, templateKey, quantity, options);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function findAvailableCatalogItem(db, playerId, templateKey) {
    await ensureInventoryV1(db);
    return findAvailableCatalogItemInTransaction(db, playerId, templateKey);
}

async function findAvailableCatalogItemInTransaction(db, playerId, templateKey) {
    await releaseExpiredInventoryReservationsInTransaction(db);
    const row = await db.get(
        `SELECT * FROM clover_inventory_items
         WHERE player_id = ? AND template_key = ? AND quantity > 0
           AND status = 'disponivel'
           AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
           AND quantity > COALESCE((
               SELECT SUM(reservation.quantity)
               FROM clover_inventory_reservations reservation
               WHERE reservation.inventory_item_id = clover_inventory_items.id
                 AND reservation.status = 'active'
           ), 0)
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        [playerId, templateKey]
    );
    return serializeItem(row);
}

async function releaseExpiredInventoryReservationsInTransaction(db) {
    await db.run(
        `UPDATE clover_inventory_reservations
         SET status = 'released', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
             metadata_json = CASE
                 WHEN metadata_json IS NULL OR metadata_json = '' THEN '{"reason":"expired"}'
                 ELSE metadata_json
             END
         WHERE status = 'active' AND expires_at IS NOT NULL
           AND datetime(expires_at) <= CURRENT_TIMESTAMP`
    );
}

async function getReservedQuantityInTransaction(db, inventoryItemId, excludeReservationId = null) {
    await releaseExpiredInventoryReservationsInTransaction(db);
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_inventory_reservations
         WHERE inventory_item_id = ?
           AND status = 'active'
           AND (? IS NULL OR id != ?)`,
        [inventoryItemId, excludeReservationId, excludeReservationId]
    );
    return Math.max(0, Number(row?.total || 0));
}

async function getAvailableInventoryQuantity(db, playerId, inventoryItemId) {
    await ensureInventoryV1(db);
    const row = await db.get(
        `SELECT * FROM clover_inventory_items
         WHERE id = ? AND player_id = ?`,
        [inventoryItemId, playerId]
    );
    if (!row) return { item: null, owned: 0, reserved: 0, available: 0 };
    const reserved = await getReservedQuantityInTransaction(db, row.id);
    return {
        item: serializeItem(row),
        owned: Number(row.quantity || 0),
        reserved,
        available: Math.max(0, Number(row.quantity || 0) - reserved),
    };
}

async function reserveInventoryItemInTransaction(db, playerId, inventoryItemId, quantity, options = {}) {
    const amount = Number(quantity);
    const reservationKey = String(options.reservationKey || '').trim();
    if (!reservationKey) {
        throw new InventoryServiceError('missing_reservation_key', 'A reserva precisa de uma identificação única.');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new InventoryServiceError('invalid_quantity', 'Quantidade de reserva inválida.');
    }
    await releaseExpiredInventoryReservationsInTransaction(db);
    const existing = await db.get(
        'SELECT * FROM clover_inventory_reservations WHERE reservation_key = ?',
        [reservationKey]
    );
    if (existing) {
        if (existing.player_id !== playerId || Number(existing.inventory_item_id) !== Number(inventoryItemId)) {
            throw new InventoryServiceError('reservation_conflict', 'Essa identificação já pertence a outra reserva.');
        }
        return existing;
    }
    const allowedStatuses = Array.isArray(options.allowedStatuses) && options.allowedStatuses.length
        ? options.allowedStatuses.map((value) => String(value || '').trim()).filter(Boolean)
        : ['disponivel'];
    const statusPlaceholders = allowedStatuses.map(() => '?').join(', ');
    const row = await db.get(
        `SELECT * FROM clover_inventory_items
         WHERE id = ? AND player_id = ? AND status IN (${statusPlaceholders})
           AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`,
        [inventoryItemId, playerId, ...allowedStatuses]
    );
    if (!row) throw new InventoryServiceError('item_not_available', 'Item indisponível para reserva.');
    const reserved = await getReservedQuantityInTransaction(db, row.id);
    if (Number(row.quantity || 0) - reserved < amount) {
        throw new InventoryServiceError('insufficient_available_quantity', 'Parte dessa quantidade já está reservada.');
    }
    const inserted = await db.run(
        `INSERT INTO clover_inventory_reservations
         (reservation_key, inventory_item_id, player_id, quantity, source_type, source_id,
          status, created_by, expires_at, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [
            reservationKey,
            row.id,
            playerId,
            amount,
            options.sourceType || 'generic',
            String(options.sourceId || ''),
            options.createdBy || playerId,
            options.expiresAt ? formatSqliteDate(options.expiresAt) : null,
            JSON.stringify(options.metadata || {}),
        ]
    );
    return db.get('SELECT * FROM clover_inventory_reservations WHERE id = ?', [inserted.lastID]);
}

async function releaseInventoryReservationInTransaction(db, reservationId, options = {}) {
    const reservation = await db.get(
        'SELECT * FROM clover_inventory_reservations WHERE id = ?',
        [reservationId]
    );
    if (!reservation || reservation.status !== 'active') return reservation || null;
    await db.run(
        `UPDATE clover_inventory_reservations
         SET status = 'released', released_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP,
             metadata_json = ?
         WHERE id = ? AND status = 'active'`,
        [JSON.stringify({ ...safeJsonParse(reservation.metadata_json), ...(options.metadata || {}) }), reservation.id]
    );
    return db.get('SELECT * FROM clover_inventory_reservations WHERE id = ?', [reservation.id]);
}

async function consumeInventoryItemInTransaction(db, row, quantity = 1, options = {}) {
    const item = row?.id
        ? await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [row.id])
        : null;
    if (!item) throw new InventoryServiceError('item_not_found', 'Item não encontrado.');
    const amount = Number(quantity);
    const current = Number(item.quantity || 0);
    if (!Number.isInteger(amount) || amount <= 0 || current < amount) {
        throw new InventoryServiceError('insufficient_item_quantity', 'Quantidade do item insuficiente.');
    }
    let reservation = null;
    if (options.reservationId) {
        reservation = await db.get(
            `SELECT * FROM clover_inventory_reservations
             WHERE id = ? AND inventory_item_id = ? AND player_id = ? AND status = 'active'`,
            [options.reservationId, item.id, item.player_id]
        );
        if (!reservation || Number(reservation.quantity || 0) < amount) {
            throw new InventoryServiceError('reservation_quantity_exceeded', 'A quantidade supera a reserva ativa.');
        }
        const reservedByOthers = await getReservedQuantityInTransaction(db, item.id, reservation.id);
        if (current - reservedByOthers < amount) {
            throw new InventoryServiceError('insufficient_item_quantity', 'Quantidade do item insuficiente.');
        }
    } else {
        const reserved = await getReservedQuantityInTransaction(db, item.id);
        if (current - reserved < amount) {
            throw new InventoryServiceError('item_reserved', 'Essa quantidade está reservada em uma atividade.');
        }
    }
    const before = serializeItem(item);
    let after = null;
    if (current === amount) {
        await db.run('DELETE FROM clover_inventory_items WHERE id = ?', [item.id]);
    } else {
        await db.run(
            `UPDATE clover_inventory_items
             SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [amount, item.id]
        );
        after = serializeItem(await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [item.id]));
    }
    await recordHistory(db, {
        itemId: item.id,
        playerId: item.player_id,
        action: options.action || 'consumido',
        quantityDelta: -amount,
        before,
        after,
        ...options,
    });
    if (reservation) {
        const remainingReserved = Number(reservation.quantity || 0) - amount;
        await db.run(
            `UPDATE clover_inventory_reservations
             SET quantity = ?, status = ?, released_at = CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE released_at END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                Math.max(0, remainingReserved),
                remainingReserved === 0 ? 'consumed' : 'active',
                remainingReserved,
                reservation.id,
            ]
        );
    }
    return { ok: true, consumed: amount, before, after };
}

async function transferReservedInventoryItemInTransaction(db, reservationId, recipientId, options = {}) {
    const reservation = await db.get(
        `SELECT reservation.*, item.*,
                reservation.id AS reservation_id,
                reservation.quantity AS reserved_quantity,
                reservation.player_id AS reservation_player_id
         FROM clover_inventory_reservations reservation
         JOIN clover_inventory_items item ON item.id = reservation.inventory_item_id
         WHERE reservation.id = ? AND reservation.status = 'active'`,
        [reservationId]
    );
    if (!reservation) {
        throw new InventoryServiceError('reservation_not_active', 'A reserva do item não está ativa.');
    }
    if (reservation.reservation_player_id === recipientId) {
        throw new InventoryServiceError('same_transfer_target', 'O item já pertence a esse jogador.');
    }
    await ensurePlayer(db, recipientId);
    const quantity = Number(options.quantity || reservation.reserved_quantity || 0);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > Number(reservation.reserved_quantity || 0)) {
        throw new InventoryServiceError('invalid_transfer_quantity', 'Quantidade de transferência inválida.');
    }

    const sourceItem = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [reservation.inventory_item_id]);
    if (!sourceItem || sourceItem.bound || !sourceItem.transferable) {
        throw new InventoryServiceError('item_not_transferable', 'Esse item não pode ser transferido.');
    }
    if (sourceItem.equipped_slot || !['disponivel', 'quebrado'].includes(sourceItem.status)) {
        throw new InventoryServiceError('item_not_available', 'Esse item não está disponível para transferência.');
    }

    const inserted = await db.run(
        `INSERT INTO clover_inventory_items (
            player_id, item_name, description, quantity, kind, source, related_id, created_by,
            created_at, metadata_json, template_key, catalog_version, category, origin, status,
            quality, base_price, reference_price, durability_current, durability_max, bound,
            transferable, equipped_slot, expires_at, updated_at, properties_json, effects_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
            recipientId,
            sourceItem.item_name,
            sourceItem.description,
            quantity,
            sourceItem.kind,
            options.source || 'player_transfer',
            options.relatedId || null,
            options.createdBy || sourceItem.player_id,
            JSON.stringify({
                ...safeJsonParse(sourceItem.metadata_json, {}),
                original_source: safeJsonParse(sourceItem.metadata_json, {}).original_source || sourceItem.source,
                original_acquired_at: safeJsonParse(sourceItem.metadata_json, {}).original_acquired_at || sourceItem.created_at,
                transferred_from: sourceItem.player_id,
                transfer_source: options.source || 'player_transfer',
                ...(options.metadata || {}),
            }),
            sourceItem.template_key,
            Number(sourceItem.catalog_version || 1),
            sourceItem.category,
            sourceItem.origin,
            sourceItem.status === 'quebrado' ? 'quebrado' : 'disponivel',
            sourceItem.quality,
            Number(sourceItem.base_price || 0),
            Number(sourceItem.reference_price || 0),
            sourceItem.durability_current,
            sourceItem.durability_max,
            0,
            1,
            sourceItem.expires_at,
            sourceItem.properties_json,
            sourceItem.effects_json,
        ]
    );
    const recipientItem = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [inserted.lastID]);
    await recordHistory(db, {
        itemId: recipientItem.id,
        playerId: recipientId,
        action: 'transferido_entrada',
        quantityDelta: quantity,
        before: null,
        after: serializeItem(recipientItem),
        source: options.source || 'player_transfer',
        relatedId: options.relatedId || null,
        idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:in` : null,
        createdBy: options.createdBy || sourceItem.player_id,
        metadata: { from_player_id: sourceItem.player_id, ...(options.metadata || {}) },
    });
    await consumeInventoryItemInTransaction(db, sourceItem, quantity, {
        reservationId,
        action: 'transferido_saida',
        source: options.source || 'player_transfer',
        relatedId: options.relatedId || null,
        idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:out` : null,
        createdBy: options.createdBy || sourceItem.player_id,
        metadata: { to_player_id: recipientId, ...(options.metadata || {}) },
    });
    return {
        ok: true,
        quantity,
        senderId: sourceItem.player_id,
        recipientId,
        recipientItem: serializeItem(recipientItem),
    };
}

async function getStructuredInventory(db, playerId, options = {}) {
    await ensureInventoryV1(db);
    await releaseExpiredInventoryReservationsInTransaction(db);
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const rows = await db.all(
        `SELECT item.*,
                COALESCE((
                    SELECT SUM(reservation.quantity)
                    FROM clover_inventory_reservations reservation
                    WHERE reservation.inventory_item_id = item.id
                      AND reservation.status = 'active'
                ), 0) AS reserved_quantity
         FROM clover_inventory_items item
         WHERE item.player_id = ?
         ORDER BY item.created_at DESC, item.id DESC
         LIMIT ?`,
        [playerId, limit]
    );
    return rows.map(serializeItem);
}

async function getInventoryHistory(db, playerId, itemId = null, limit = 30) {
    await ensureInventoryV1(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    if (itemId) {
        return db.all(
            `SELECT * FROM clover_inventory_item_history
             WHERE player_id = ? AND item_id = ?
             ORDER BY id DESC LIMIT ?`,
            [playerId, itemId, safeLimit]
        );
    }
    return db.all(
        `SELECT * FROM clover_inventory_item_history
         WHERE player_id = ?
         ORDER BY id DESC LIMIT ?`,
        [playerId, safeLimit]
    );
}

async function applyDurabilityLoss(db, playerId, itemId, amount, cause, createdBy, options = {}) {
    await ensureInventoryV1(db);
    const loss = Number(amount);
    if (![1, 2, 3].includes(loss)) {
        throw new InventoryServiceError('invalid_durability_loss', 'Desgaste deve ser leve (1), sério (2) ou crítico (3).');
    }
    if (!String(cause || '').trim()) {
        throw new InventoryServiceError('missing_cause', 'Informe a causa do desgaste.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const row = await db.get(
            'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
            [itemId, playerId]
        );
        if (!row) throw new InventoryServiceError('item_not_found', 'Item não encontrado.');
        if (row.durability_max === null) {
            throw new InventoryServiceError('item_has_no_durability', 'Esse item não usa durabilidade na V1.');
        }
        const before = serializeItem(row);
        const next = Math.max(0, Number(row.durability_current || 0) - loss);
        await db.run(
            `UPDATE clover_inventory_items
             SET durability_current = ?, status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [next, next === 0 ? 'quebrado' : row.status, row.id]
        );
        const updated = serializeItem(await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [row.id]));
        await recordHistory(db, {
            itemId: row.id,
            playerId,
            action: 'desgaste',
            durabilityDelta: next - Number(row.durability_current || 0),
            before,
            after: updated,
            source: options.source || 'narrador',
            relatedId: options.relatedId || null,
            idempotencyKey: options.idempotencyKey || null,
            createdBy,
            metadata: { cause: String(cause).trim(), intensity: loss, ...(options.metadata || {}) },
        });
        await db.exec('COMMIT');
        return { ok: true, item: updated, conditionBefore: before.condition, conditionAfter: updated.condition };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    InventoryServiceError,
    QUALITY_MULTIPLIERS,
    addCatalogItem,
    addCatalogItemInTransaction,
    applyDurabilityLoss,
    calculateCondition,
    calculateReferencePrice,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    expiryFromDays,
    findAvailableCatalogItem,
    findAvailableCatalogItemInTransaction,
    getAvailableInventoryQuantity,
    getReservedQuantityInTransaction,
    getInventoryHistory,
    getItemTemplate,
    getItemTemplateInTransaction,
    getStructuredInventory,
    recordHistory,
    releaseExpiredInventoryReservationsInTransaction,
    releaseInventoryReservationInTransaction,
    reserveInventoryItemInTransaction,
    seedItemCatalog,
    serializeTemplateRow,
    serializeItem,
    transferReservedInventoryItemInTransaction,
};
