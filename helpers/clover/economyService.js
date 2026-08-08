'use strict';

const crypto = require('crypto');

const { ensureCloverEconomySchema } = require('../../database');
const { hasSquad, resolvePatent } = require('./cavalierService');
const { getTemplate } = require('./economyItemCatalog');
const {
    InventoryServiceError,
    addCatalogItemInTransaction,
    calculateCondition,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    findAvailableCatalogItemInTransaction,
    recordHistory,
    releaseInventoryReservationInTransaction,
    reserveInventoryItemInTransaction,
    serializeItem,
} = require('./inventoryService');
const {
    addYullsInTransaction,
    ensureYullsState,
    getYullsHistory,
    getYullsSummary,
    releaseYullsReservationInTransaction,
    reserveYullsInTransaction,
    spendYullsInTransaction,
} = require('./yullsService');

const CONFIRMATION_SECONDS = 120;
const REGIONAL_FEE_PERCENT = 15;
const EXPRESS_FEE_PERCENT = 25;
const REGIONAL_DELIVERY_MINUTES = 240;
const EXPRESS_DELIVERY_MINUTES = 60;
const RETURN_WINDOW_MINUTES = 5;
const TIME_ZONE = 'America/Sao_Paulo';

class EconomyServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'EconomyServiceError';
        this.code = code;
        this.details = details;
    }
}

const SHOP_DEFINITIONS = Object.freeze([
    Object.freeze({ key: 'armazem_capital', name: 'Armazém da Capital', description: 'Kits, utilidades e vestimentas comuns.', order: 10 }),
    Object.freeze({ key: 'armeiro_clover', name: 'Armeiro de Clover', description: 'Armas, escudos, catalisadores mágicos e vassouras.', order: 20 }),
    Object.freeze({ key: 'forja_alianca', name: 'Forja da Aliança', description: 'Armaduras, armas pesadas e reparos.', order: 30 }),
    Object.freeze({ key: 'botica_heart', name: 'Botica de Heart', description: 'Poções, antídotos e consumíveis alquímicos por encomenda regional.', order: 40 }),
    Object.freeze({ key: 'casa_cura', name: 'Casa de Cura', description: 'Tratamentos narrativos registrados pelo narrador.', order: 50, metadata: { narrator_service: true } }),
    Object.freeze({ key: 'entreposto_alianca', name: 'Entreposto da Aliança', description: 'Exclusivos, restritos e lojas temporárias quando anunciados.', order: 60, metadata: { temporary_catalog: true } }),
]);

const SHOP_ITEMS = Object.freeze({
    armazem_capital: Object.freeze([
        'kit_campo', 'kit_viagem', 'kit_investigacao', 'kit_primeiros_socorros', 'kit_escalada',
        'roupas_comuns', 'roupas_aventureiro', 'roupas_inverno', 'traje_formal', 'roupas_nobres',
    ]),
    armeiro_clover: Object.freeze([
        'bastao', 'adaga', 'azagaia', 'lanca_caca', 'arco_caca', 'espada_curta', 'rapieira',
        'sabre', 'espada_longa', 'besta', 'arco_guerra', 'escudo_mao', 'escudo_guerra',
        'varinha_basica', 'cajado_basico', 'varinha_magica', 'bastao_magico',
        'vassoura_simples', 'vassoura_luxuosa', 'vassoura_corrida',
    ]),
    forja_alianca: Object.freeze([
        'armadura_couro', 'armadura_malha', 'armadura_half_plate', 'armadura_full_plate',
        'escudo_torre', 'machado_mao', 'maca', 'estrela_manha', 'lanca_guerra', 'alabarda',
        'machado_guerra', 'martelo_guerra', 'espada_grande',
    ]),
    botica_heart: Object.freeze([
        'pocao_antidoto', 'pocao_cura_basica', 'pocao_cura_avancada',
        'pocao_cura_extraordinaria', 'pocao_mana', 'pocao_agilidade', 'pocao_forca',
        'pocao_resistencia', 'pocao_velocidade',
    ]),
    casa_cura: Object.freeze([
        'tratamento_leve_npc', 'tratamento_moderado_npc', 'estabilizacao_grave_npc',
    ]),
});

const INITIAL_EQUIPMENT_KEYS = new Set([
    'bastao', 'adaga', 'machado_mao', 'azagaia', 'lanca_caca', 'arco_caca',
    'espada_curta', 'rapieira', 'sabre', 'espada_longa', 'maca', 'besta',
    'varinha_basica', 'cajado_basico',
]);

const SALARY_BY_TIER = Object.freeze({
    aspirante: 300,
    junior_5: 400,
    junior_4: 500,
    junior_3: 600,
    junior_2: 750,
    junior_1: 900,
    intermediario_5: 1100,
    intermediario_4: 1300,
    intermediario_3: 1500,
    intermediario_2: 1750,
    intermediario_1: 2000,
    senior_5: 2300,
    senior_4: 2650,
    senior_3: 3000,
    senior_2: 3500,
    senior_1: 4000,
});

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function sqliteDate(date = new Date()) {
    return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function addSeconds(date, seconds) {
    return new Date(new Date(date).getTime() + Number(seconds) * 1000);
}

function addMinutes(date, minutes) {
    return addSeconds(date, Number(minutes) * 60);
}

function generateKey(prefix) {
    return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function asPositiveInteger(value, field = 'quantidade', maximum = 50) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0 || number > maximum) {
        throw new EconomyServiceError('invalid_quantity', `${field} inválida.`, { maximum });
    }
    return number;
}

function qualityDurability(template, quality) {
    if (template.defaultDurability === null) return null;
    if (quality === 'refinada') return 7;
    if (quality === 'superior') return 9;
    return template.defaultDurability;
}

function serializeShop(row) {
    return {
        key: row.shop_key,
        name: row.name,
        description: row.description,
        active: Boolean(row.active),
        displayOrder: Number(row.display_order || 0),
        listingCount: Number(row.listing_count || 0),
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function serializeListing(row) {
    const globalStock = row.global_stock === null ? null : Number(row.global_stock);
    const pendingQuantity = Number(row.pending_quantity || 0);
    const soldQuantity = Number(row.sold_quantity || 0);
    return {
        key: row.listing_key,
        shopKey: row.shop_key,
        templateKey: row.template_key,
        itemName: row.item_name,
        description: row.description,
        category: row.category,
        kind: row.kind,
        origin: row.origin,
        quality: row.quality,
        availability: row.availability,
        unitPrice: Number(row.unit_price || 0),
        deliveryMinutes: Number(row.delivery_minutes || 0),
        regionalFeePercent: Number(row.regional_fee_percent || 0),
        personalWeeklyLimit: row.personal_weekly_limit === null ? null : Number(row.personal_weekly_limit),
        globalStock,
        soldQuantity,
        pendingQuantity,
        availableStock: globalStock === null ? null : Math.max(0, globalStock - soldQuantity - pendingQuantity),
        active: Boolean(row.active),
        properties: safeJsonParse(row.properties_json, {}),
        effects: safeJsonParse(row.effects_json, {}),
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function serializePurchase(row) {
    return {
        key: row.intent_key,
        playerId: row.player_id,
        listingKey: row.listing_key,
        quantity: Number(row.quantity),
        unitPrice: Number(row.unit_price),
        subtotal: Number(row.subtotal),
        regionalFee: Number(row.regional_fee),
        expressFee: Number(row.express_fee),
        discount: Number(row.discount),
        total: Number(row.total),
        express: Boolean(row.express),
        status: row.status,
        expiresAt: row.expires_at,
        deliverAt: row.deliver_at,
        confirmedAt: row.confirmed_at,
        completedAt: row.completed_at,
        inventoryItemIds: safeJsonParse(row.inventory_item_ids_json, []),
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

async function seedEconomyCatalog(db) {
    for (const shop of SHOP_DEFINITIONS) {
        await db.run(
            `INSERT INTO clover_economy_shops
             (shop_key, name, description, active, display_order, created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(shop_key) DO UPDATE SET
                 name = excluded.name,
                 description = excluded.description,
                 active = 1,
                 display_order = excluded.display_order,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = excluded.metadata_json`,
            [shop.key, shop.name, shop.description, shop.order, JSON.stringify(shop.metadata || {})]
        );
    }

    let order = 0;
    for (const [shopKey, templateKeys] of Object.entries(SHOP_ITEMS)) {
        for (const templateKey of templateKeys) {
            const item = getTemplate(templateKey);
            if (!item) continue;
            order += 1;
            const regional = shopKey === 'botica_heart';
            await db.run(
                `INSERT INTO clover_economy_listings
                 (listing_key, shop_key, template_key, quality, availability, unit_price,
                  delivery_minutes, regional_fee_percent, personal_weekly_limit, global_stock,
                  active, display_order, created_at, updated_at, metadata_json)
                 VALUES (?, ?, ?, 'comum', ?, ?, ?, ?, ?, NULL, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
                 ON CONFLICT(listing_key) DO UPDATE SET
                     shop_key = excluded.shop_key,
                     template_key = excluded.template_key,
                     quality = excluded.quality,
                     availability = excluded.availability,
                     unit_price = excluded.unit_price,
                     delivery_minutes = excluded.delivery_minutes,
                     regional_fee_percent = excluded.regional_fee_percent,
                     personal_weekly_limit = excluded.personal_weekly_limit,
                     active = excluded.active,
                     display_order = excluded.display_order,
                     updated_at = CURRENT_TIMESTAMP,
                     metadata_json = excluded.metadata_json`,
                [
                    templateKey,
                    shopKey,
                    templateKey,
                    regional ? 'regional' : 'comum',
                    item.basePrice,
                    regional ? REGIONAL_DELIVERY_MINUTES : 0,
                    regional ? REGIONAL_FEE_PERCENT : 0,
                    regional ? 5 : null,
                    order,
                    JSON.stringify({ catalog_version: item.catalogVersion }),
                ]
            );
        }
    }
}

async function ensureEconomyV1(db) {
    const cache = ensureEconomyV1.cache
        || (ensureEconomyV1.cache = new WeakMap());

    const existing = cache.get(db);
    if (existing) return existing;

    const initialization = (async () => {
        await ensureCloverEconomySchema(db);
        await ensureInventoryV1(db);
        await seedEconomyCatalog(db);
    })();

    cache.set(db, initialization);

    try {
        return await initialization;
    } catch (error) {
        if (cache.get(db) === initialization) cache.delete(db);
        throw error;
    }
}

async function listingRow(db, listingKey) {
    return db.get(
        `SELECT listing.*, template.item_name, template.description, template.category,
                template.kind, template.origin, template.properties_json, template.effects_json,
                COALESCE((
                    SELECT SUM(intent.quantity)
                    FROM clover_economy_purchase_intents intent
                    WHERE intent.listing_key = listing.listing_key
                      AND intent.status = 'pending'
                      AND datetime(intent.expires_at) > CURRENT_TIMESTAMP
                ), 0) AS pending_quantity
         FROM clover_economy_listings listing
         JOIN clover_item_templates template ON template.template_key = listing.template_key
         WHERE listing.listing_key = ?`,
        [listingKey]
    );
}

async function listShops(db) {
    await ensureEconomyV1(db);
    const rows = await db.all(
        `SELECT shop.*, COUNT(listing.listing_key) AS listing_count
         FROM clover_economy_shops shop
         LEFT JOIN clover_economy_listings listing
           ON listing.shop_key = shop.shop_key AND listing.active = 1
         WHERE shop.active = 1
         GROUP BY shop.shop_key
         ORDER BY shop.display_order ASC, shop.name ASC`
    );
    return rows.map(serializeShop);
}

async function getShopCatalog(db, shopKey) {
    await ensureEconomyV1(db);
    const shop = await db.get('SELECT * FROM clover_economy_shops WHERE shop_key = ? AND active = 1', [shopKey]);
    if (!shop) throw new EconomyServiceError('shop_not_found', 'Loja não encontrada.');
    const rows = await db.all(
        `SELECT listing.*, template.item_name, template.description, template.category,
                template.kind, template.origin, template.properties_json, template.effects_json,
                COALESCE((
                    SELECT SUM(intent.quantity)
                    FROM clover_economy_purchase_intents intent
                    WHERE intent.listing_key = listing.listing_key
                      AND intent.status = 'pending'
                      AND datetime(intent.expires_at) > CURRENT_TIMESTAMP
                ), 0) AS pending_quantity
         FROM clover_economy_listings listing
         JOIN clover_item_templates template ON template.template_key = listing.template_key
         WHERE listing.shop_key = ? AND listing.active = 1
           AND (listing.starts_at IS NULL OR datetime(listing.starts_at) <= CURRENT_TIMESTAMP)
           AND (listing.ends_at IS NULL OR datetime(listing.ends_at) > CURRENT_TIMESTAMP)
         ORDER BY listing.display_order ASC, template.item_name ASC`,
        [shopKey]
    );
    return { shop: serializeShop(shop), listings: rows.map(serializeListing) };
}

function zonedDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(new Date(date));
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getEconomicWeekKey(date = new Date()) {
    const parts = zonedDateParts(date);
    const weekdayIndex = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 })[parts.weekday] || 0;
    const anchor = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
    anchor.setUTCDate(anchor.getUTCDate() - weekdayIndex);
    return anchor.toISOString().slice(0, 10);
}

function shiftWeekKey(weekKey, weeks) {
    const date = new Date(`${weekKey}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + Number(weeks) * 7);
    return date.toISOString().slice(0, 10);
}

async function purchasedThisWeek(db, playerId, listingKey, weekKey) {
    const nextWeek = shiftWeekKey(weekKey, 1);
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_economy_purchase_intents
         WHERE player_id = ? AND listing_key = ?
           AND status IN ('confirmed', 'in_transport', 'completed')
           AND confirmed_at >= ? AND confirmed_at < ?`,
        [playerId, listingKey, `${weekKey} 03:00:00`, `${nextWeek} 03:00:00`]
    );
    return Number(row?.total || 0);
}

async function releasePendingPurchase(db, intent, status = 'expired') {
    if (intent.yulls_reservation_id) {
        await releaseYullsReservationInTransaction(db, intent.yulls_reservation_id, { metadata: { reason: status } });
    }
    if (intent.voucher_reservation_id) {
        await releaseInventoryReservationInTransaction(db, intent.voucher_reservation_id, { metadata: { reason: status } });
    }
    await db.run(
        `UPDATE clover_economy_purchase_intents
         SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
        [status, status, intent.id]
    );
}

async function processDueEconomyOperations(db) {
    await ensureCloverEconomySchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const expiredPurchases = await db.all(
            `SELECT * FROM clover_economy_purchase_intents
             WHERE status = 'pending' AND datetime(expires_at) <= CURRENT_TIMESTAMP`
        );
        for (const intent of expiredPurchases) await releasePendingPurchase(db, intent, 'expired');

        const expiredSales = await db.all(
            `SELECT * FROM clover_economy_sale_intents
             WHERE status = 'pending' AND datetime(expires_at) <= CURRENT_TIMESTAMP`
        );
        for (const intent of expiredSales) {
            await releaseInventoryReservationInTransaction(db, intent.inventory_reservation_id, { metadata: { reason: 'expired' } });
            await db.run("UPDATE clover_economy_sale_intents SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [intent.id]);
        }

        const expiredRepairs = await db.all(
            `SELECT * FROM clover_repair_orders
             WHERE status = 'pending' AND datetime(expires_at) <= CURRENT_TIMESTAMP`
        );
        for (const order of expiredRepairs) {
            if (order.yulls_reservation_id) await releaseYullsReservationInTransaction(db, order.yulls_reservation_id, { metadata: { reason: 'expired' } });
            if (order.inventory_reservation_id) await releaseInventoryReservationInTransaction(db, order.inventory_reservation_id, { metadata: { reason: 'expired' } });
            if (order.voucher_reservation_id) await releaseInventoryReservationInTransaction(db, order.voucher_reservation_id, { metadata: { reason: 'expired' } });
            await db.run("UPDATE clover_repair_orders SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [order.id]);
        }

        const deliveries = await db.all(
            `SELECT * FROM clover_economy_purchase_intents
             WHERE status = 'in_transport' AND datetime(deliver_at) <= CURRENT_TIMESTAMP`
        );
        for (const intent of deliveries) {
            const itemIds = safeJsonParse(intent.inventory_item_ids_json, []);
            for (const itemId of itemIds) {
                const beforeRow = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [itemId, intent.player_id]);
                if (!beforeRow || beforeRow.status !== 'em_transporte') continue;
                const before = serializeItem(beforeRow);
                await db.run("UPDATE clover_inventory_items SET status = 'disponivel', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [itemId]);
                const after = serializeItem(await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [itemId]));
                await recordHistory(db, {
                    itemId, playerId: intent.player_id, action: 'entregue', before, after,
                    source: 'loja_npc', relatedId: intent.intent_key, createdBy: 'system',
                });
            }
            await db.run(
                `UPDATE clover_economy_purchase_intents
                 SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'in_transport'`,
                [intent.id]
            );
        }

        const repairs = await db.all(
            `SELECT repair.*, repair.id AS repair_id, item.*
             FROM clover_repair_orders repair
             JOIN clover_inventory_items item ON item.id = repair.inventory_item_id
             WHERE repair.status = 'in_progress' AND datetime(repair.deliver_at) <= CURRENT_TIMESTAMP`
        );
        for (const row of repairs) {
            const itemRow = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [row.inventory_item_id]);
            if (!itemRow) continue;
            const before = serializeItem(itemRow);
            await db.run(
                `UPDATE clover_inventory_items
                 SET durability_current = durability_max, status = 'disponivel', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [row.inventory_item_id]
            );
            const after = serializeItem(await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [row.inventory_item_id]));
            await recordHistory(db, {
                itemId: row.inventory_item_id,
                playerId: row.player_id,
                action: 'reparado',
                durabilityDelta: Number(after.durability_current) - Number(before.durability_current),
                before,
                after,
                source: 'forja_alianca',
                relatedId: row.order_key,
                createdBy: 'system',
            });
            await db.run(
                `UPDATE clover_repair_orders
                 SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'in_progress'`,
                [row.repair_id]
            );
        }

        await db.exec('COMMIT');
        return { ok: true };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function resolveVoucher(db, playerId, templateKey, useVoucher) {
    if (!useVoucher) return null;
    const item = await findAvailableCatalogItemInTransaction(db, playerId, templateKey);
    if (!item) throw new EconomyServiceError('voucher_not_owned', 'Vale solicitado não está disponível.');
    return item;
}

async function previewPurchase(db, playerId, listingKey, quantity = 1, options = {}) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    await ensureYullsState(db, playerId);
    const amount = asPositiveInteger(quantity);
    const idempotencyKey = String(options.idempotencyKey || '').trim() || null;
    if (idempotencyKey) {
        const existing = await db.get('SELECT * FROM clover_economy_purchase_intents WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) {
            if (existing.player_id !== playerId) throw new EconomyServiceError('idempotency_conflict', 'A chave pertence a outra compra.');
            return { ok: true, duplicate: true, purchase: serializePurchase(existing) };
        }
    }
    const listing = await listingRow(db, listingKey);
    if (!listing || !listing.active) throw new EconomyServiceError('listing_not_found', 'Item não está disponível nas lojas.');
    if (listing.availability === 'exclusivo' || listing.availability === 'restrito') {
        throw new EconomyServiceError('listing_requires_release', 'Este item exige anúncio ou autorização específica.');
    }
    const serialized = serializeListing(listing);
    if (serialized.availableStock !== null && serialized.availableStock < amount) {
        throw new EconomyServiceError('stock_unavailable', 'Estoque insuficiente.', { available: serialized.availableStock });
    }
    const weekKey = getEconomicWeekKey(options.now || new Date());
    const weekUsed = await purchasedThisWeek(db, playerId, listingKey, weekKey);
    if (serialized.personalWeeklyLimit !== null && weekUsed + amount > serialized.personalWeeklyLimit) {
        throw new EconomyServiceError('weekly_purchase_limit', 'Essa compra ultrapassa o limite pessoal da semana.', {
            used: weekUsed,
            limit: serialized.personalWeeklyLimit,
        });
    }

    const subtotal = Number(listing.unit_price) * amount;
    const regionalFee = listing.availability === 'regional'
        ? Math.floor(subtotal * Number(listing.regional_fee_percent || REGIONAL_FEE_PERCENT) / 100)
        : 0;
    const orderedTotal = subtotal + regionalFee;
    const express = Boolean(options.express) && listing.availability === 'regional';
    const expressFee = express ? Math.floor(orderedTotal * EXPRESS_FEE_PERCENT / 100) : 0;
    const beforeDiscount = orderedTotal + expressFee;
    const intentKey = generateKey('compra');
    const expiresAt = addSeconds(options.now || new Date(), CONFIRMATION_SECONDS);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const voucher = await resolveVoucher(db, playerId, 'vale_compra_2000', options.useVoucher);
        const discount = voucher ? Math.min(2000, beforeDiscount) : 0;
        const total = Math.max(0, beforeDiscount - discount);
        let voucherReservation = null;
        if (voucher) {
            voucherReservation = await reserveInventoryItemInTransaction(db, playerId, voucher.id, 1, {
                reservationKey: `purchase-voucher:${intentKey}`,
                sourceType: 'npc_purchase', sourceId: intentKey, createdBy: playerId, expiresAt,
            });
        }
        const yullsReservation = total > 0
            ? await reserveYullsInTransaction(db, playerId, total, {
                reservationKey: `purchase:${intentKey}`,
                sourceType: 'npc_purchase', sourceId: intentKey, createdBy: playerId, expiresAt,
            })
            : null;
        await db.run(
            `INSERT INTO clover_economy_purchase_intents
             (intent_key, player_id, listing_key, quantity, unit_price, subtotal, regional_fee,
              express_fee, discount, total, express, status, yulls_reservation_id,
              voucher_item_id, voucher_reservation_id, idempotency_key, expires_at,
              created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
            [
                intentKey, playerId, listingKey, amount, Number(listing.unit_price), subtotal,
                regionalFee, expressFee, discount, total, express ? 1 : 0,
                yullsReservation?.id || null, voucher?.id || null, voucherReservation?.id || null,
                idempotencyKey, sqliteDate(expiresAt), JSON.stringify({ week_key: weekKey, via: options.via || 'bot' }),
            ]
        );
        const row = await db.get('SELECT * FROM clover_economy_purchase_intents WHERE intent_key = ?', [intentKey]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, purchase: serializePurchase(row), listing: serialized };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function confirmPurchase(db, playerId, intentKey, options = {}) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    const intent = await db.get(
        'SELECT * FROM clover_economy_purchase_intents WHERE intent_key = ? AND player_id = ?',
        [intentKey, playerId]
    );
    if (!intent) throw new EconomyServiceError('purchase_not_found', 'Compra pendente não encontrada.');
    if (['completed', 'in_transport'].includes(intent.status)) {
        return { ok: true, duplicate: true, purchase: serializePurchase(intent), wallet: await getYullsSummary(db, playerId) };
    }
    if (intent.status !== 'pending') throw new EconomyServiceError('purchase_not_pending', 'Esta compra não pode mais ser confirmada.');
    const listing = await listingRow(db, intent.listing_key);
    if (!listing || !listing.active) throw new EconomyServiceError('listing_not_found', 'O item saiu da loja antes da confirmação.');
    const serializedListing = serializeListing(listing);
    if (serializedListing.availableStock !== null && serializedListing.availableStock < Number(intent.quantity)) {
        throw new EconomyServiceError('stock_unavailable', 'O estoque acabou antes da confirmação.');
    }
    const weekKey = getEconomicWeekKey(options.now || new Date());
    const weekUsed = await purchasedThisWeek(db, playerId, intent.listing_key, weekKey);
    if (serializedListing.personalWeeklyLimit !== null && weekUsed + Number(intent.quantity) > serializedListing.personalWeeklyLimit) {
        throw new EconomyServiceError('weekly_purchase_limit', 'O limite pessoal da semana foi atingido.');
    }

    const deliveryMinutes = listing.availability === 'regional'
        ? (intent.express ? EXPRESS_DELIVERY_MINUTES : Number(listing.delivery_minutes || REGIONAL_DELIVERY_MINUTES))
        : 0;
    const deliverAt = deliveryMinutes ? addMinutes(options.now || new Date(), deliveryMinutes) : null;
    const template = getTemplate(listing.template_key);
    if (!template) throw new EconomyServiceError('template_not_found', 'O item da loja perdeu o catálogo.');

    await db.exec('BEGIN IMMEDIATE');
    try {
        let spend = null;
        if (Number(intent.total) > 0) {
            spend = await spendYullsInTransaction(
                db, playerId, Number(intent.total), 'loja_npc', `Compra: ${template.itemName}`, playerId,
                {
                    relatedId: intent.intent_key,
                    idempotencyKey: `yulls:purchase:${intent.id}`,
                    reservationId: intent.yulls_reservation_id,
                    metadata: { listing_key: listing.listing_key, quantity: Number(intent.quantity) },
                }
            );
        }
        if (intent.voucher_item_id) {
            const voucherRow = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [intent.voucher_item_id]);
            await consumeInventoryItemInTransaction(db, voucherRow, 1, {
                reservationId: intent.voucher_reservation_id,
                action: 'vale_usado', source: 'loja_npc', relatedId: intent.intent_key,
                idempotencyKey: `inventory:purchase-voucher:${intent.id}`, createdBy: playerId,
            });
        }
        const status = deliveryMinutes ? 'em_transporte' : 'disponivel';
        const added = template.kind === 'servico_npc'
            ? { ok: true, items: [], quantity: Number(intent.quantity), service: true }
            : await addCatalogItemInTransaction(db, playerId, listing.template_key, Number(intent.quantity), {
                quality: listing.quality,
                durabilityMax: qualityDurability(template, listing.quality),
                status,
                forceSeparate: Boolean(deliveryMinutes),
                source: 'loja_npc', relatedId: intent.intent_key, createdBy: playerId,
                metadata: { listing_key: listing.listing_key, deliver_at: deliverAt ? sqliteDate(deliverAt) : null },
            });
        const itemIds = added.items.map((item) => item.id);
        await db.run(
            'UPDATE clover_economy_listings SET sold_quantity = sold_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE listing_key = ?',
            [Number(intent.quantity), intent.listing_key]
        );
        await db.run(
            `UPDATE clover_economy_purchase_intents
             SET status = ?, inventory_item_ids_json = ?, deliver_at = ?, confirmed_at = CURRENT_TIMESTAMP,
                 completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pending'`,
            [deliveryMinutes ? 'in_transport' : 'completed', JSON.stringify(itemIds), deliverAt ? sqliteDate(deliverAt) : null, deliveryMinutes ? 'in_transport' : 'completed', intent.id]
        );
        const updated = await db.get('SELECT * FROM clover_economy_purchase_intents WHERE id = ?', [intent.id]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, purchase: serializePurchase(updated), spend, items: added.items };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelPurchase(db, playerId, intentKey, options = {}) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    const intent = await db.get(
        'SELECT * FROM clover_economy_purchase_intents WHERE intent_key = ? AND player_id = ?',
        [intentKey, playerId]
    );
    if (!intent) throw new EconomyServiceError('purchase_not_found', 'Compra não encontrada.');
    if (['cancelled', 'expired', 'refunded'].includes(intent.status)) {
        return { ok: true, duplicate: true, purchase: serializePurchase(intent) };
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        if (intent.status === 'pending') {
            await releasePendingPurchase(db, intent, 'cancelled');
            const updated = await db.get('SELECT * FROM clover_economy_purchase_intents WHERE id = ?', [intent.id]);
            await db.exec('COMMIT');
            return { ok: true, duplicate: false, refunded: 0, purchase: serializePurchase(updated) };
        }
        const withinWindow = await db.get(
            `SELECT CASE WHEN confirmed_at IS NOT NULL
                AND (julianday(CURRENT_TIMESTAMP) - julianday(confirmed_at)) * 1440 <= ?
                THEN 1 ELSE 0 END AS allowed
             FROM clover_economy_purchase_intents WHERE id = ?`,
            [RETURN_WINDOW_MINUTES, intent.id]
        );
        if (!withinWindow?.allowed) {
            throw new EconomyServiceError('return_window_closed', 'O prazo comum de devolução já encerrou.');
        }
        const itemIds = safeJsonParse(intent.inventory_item_ids_json, []);
        if (!itemIds.length) {
            throw new EconomyServiceError('item_not_returnable', 'Serviço de NPC já confirmado não aceita devolução comum.');
        }
        for (const itemId of itemIds) {
            const row = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [itemId, playerId]);
            if (!row || row.bound || row.equipped_slot || !['disponivel', 'em_transporte'].includes(row.status)) {
                throw new EconomyServiceError('item_not_returnable', 'O item comprado já não aceita devolução comum.');
            }
            const quantity = itemIds.length === 1 ? Number(intent.quantity) : 1;
            await consumeInventoryItemInTransaction(db, row, quantity, {
                action: 'devolvido', source: 'loja_npc', relatedId: intent.intent_key,
                idempotencyKey: `inventory:return:${intent.id}:${itemId}`, createdBy: playerId,
            });
        }
        const refund = Math.floor(Number(intent.total) * 0.9);
        let credit = null;
        if (refund > 0) {
            credit = await addYullsInTransaction(
                db, playerId, refund, 'devolucao_loja', 'Devolução com retenção de 10%', playerId,
                { relatedId: intent.intent_key, idempotencyKey: `yulls:return:${intent.id}` }
            );
        }
        await db.run(
            'UPDATE clover_economy_listings SET sold_quantity = MAX(0, sold_quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE listing_key = ?',
            [Number(intent.quantity), intent.listing_key]
        );
        await db.run(
            `UPDATE clover_economy_purchase_intents
             SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [intent.id]
        );
        const updated = await db.get('SELECT * FROM clover_economy_purchase_intents WHERE id = ?', [intent.id]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, refunded: refund, credit, purchase: serializePurchase(updated) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function serializeSale(row) {
    return {
        key: row.intent_key,
        playerId: row.player_id,
        inventoryItemId: Number(row.inventory_item_id),
        quantity: Number(row.quantity),
        referencePrice: Number(row.reference_price),
        offerPercent: Number(row.offer_percent),
        offerTotal: Number(row.offer_total),
        status: row.status,
        expiresAt: row.expires_at,
        confirmedAt: row.confirmed_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function npcSalePercent(item) {
    if (item.category !== 'equipamento') return 50;
    return ({ integro: 40, desgastado: 30, danificado: 15, quebrado: 5 })[item.condition] || 40;
}

async function previewNpcSale(db, playerId, inventoryItemId, quantity = 1, options = {}) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    const amount = asPositiveInteger(quantity);
    const idempotencyKey = String(options.idempotencyKey || '').trim() || null;
    if (idempotencyKey) {
        const existing = await db.get('SELECT * FROM clover_economy_sale_intents WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) {
            if (existing.player_id !== playerId) throw new EconomyServiceError('idempotency_conflict', 'A chave pertence a outra venda.');
            return { ok: true, duplicate: true, sale: serializeSale(existing) };
        }
    }
    const row = await db.get(
        'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
        [Number(inventoryItemId), playerId]
    );
    if (!row) throw new EconomyServiceError('item_not_found', 'Item não encontrado no inventário.');
    const item = serializeItem(row);
    if (item.bound || !item.transferable) throw new EconomyServiceError('item_bound', 'Item vinculado não pode ser vendido.');
    if (item.metadata?.template_flags?.marketable === false) throw new EconomyServiceError('item_not_marketable', 'Esse modelo não foi liberado para venda.');
    if (item.equipped_slot) throw new EconomyServiceError('item_equipped', 'Desequipe o item antes de vender.');
    if (!['disponivel', 'quebrado'].includes(item.status)) throw new EconomyServiceError('item_not_available', 'O item está indisponível para venda.');
    if (item.available_quantity < amount) throw new EconomyServiceError('insufficient_item_quantity', 'Quantidade disponível insuficiente.');
    const percent = npcSalePercent(item);
    const unitOffer = Math.floor(Number(item.reference_price || 0) * percent / 100);
    const offerTotal = unitOffer * amount;
    if (offerTotal <= 0) throw new EconomyServiceError('item_without_sale_value', 'Este item não possui valor de revenda para NPC.');
    const intentKey = generateKey('venda');
    const expiresAt = addSeconds(options.now || new Date(), CONFIRMATION_SECONDS);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const reservation = await reserveInventoryItemInTransaction(db, playerId, item.id, amount, {
            reservationKey: `npc-sale:${intentKey}`,
            sourceType: 'npc_sale', sourceId: intentKey, createdBy: playerId, expiresAt,
            allowedStatuses: ['disponivel', 'quebrado'],
        });
        await db.run(
            `INSERT INTO clover_economy_sale_intents
             (intent_key, player_id, inventory_item_id, quantity, reference_price, offer_percent,
              offer_total, status, inventory_reservation_id, idempotency_key, expires_at,
              created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
            [
                intentKey, playerId, item.id, amount, Number(item.reference_price), percent,
                offerTotal, reservation.id, idempotencyKey, sqliteDate(expiresAt),
                JSON.stringify({ item_name: item.item_name, condition: item.condition, via: options.via || 'bot' }),
            ]
        );
        const intent = await db.get('SELECT * FROM clover_economy_sale_intents WHERE intent_key = ?', [intentKey]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, sale: serializeSale(intent), item };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function confirmNpcSale(db, playerId, intentKey) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    await ensureYullsState(db, playerId);
    const intent = await db.get(
        'SELECT * FROM clover_economy_sale_intents WHERE intent_key = ? AND player_id = ?',
        [intentKey, playerId]
    );
    if (!intent) throw new EconomyServiceError('sale_not_found', 'Venda pendente não encontrada.');
    if (intent.status === 'confirmed') {
        return { ok: true, duplicate: true, sale: serializeSale(intent), wallet: await getYullsSummary(db, playerId) };
    }
    if (intent.status !== 'pending') throw new EconomyServiceError('sale_not_pending', 'Esta oferta não pode mais ser confirmada.');

    await db.exec('BEGIN IMMEDIATE');
    try {
        const item = await db.get(
            'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
            [intent.inventory_item_id, playerId]
        );
        if (!item) throw new EconomyServiceError('item_not_found', 'O item da venda não está mais no inventário.');
        const consumed = await consumeInventoryItemInTransaction(db, item, Number(intent.quantity), {
            reservationId: intent.inventory_reservation_id,
            action: 'vendido_npc', source: 'venda_npc', relatedId: intent.intent_key,
            idempotencyKey: `inventory:npc-sale:${intent.id}`, createdBy: playerId,
        });
        const credit = await addYullsInTransaction(
            db, playerId, Number(intent.offer_total), 'venda_npc', 'Venda de item para NPC', playerId,
            {
                relatedId: intent.intent_key,
                idempotencyKey: `yulls:npc-sale:${intent.id}`,
                metadata: { inventory_item_id: Number(intent.inventory_item_id), quantity: Number(intent.quantity) },
            }
        );
        await db.run(
            `UPDATE clover_economy_sale_intents
             SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pending'`,
            [intent.id]
        );
        const updated = await db.get('SELECT * FROM clover_economy_sale_intents WHERE id = ?', [intent.id]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, sale: serializeSale(updated), credit, consumed };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function serializeRepair(row) {
    return {
        key: row.order_key,
        playerId: row.player_id,
        inventoryItemId: Number(row.inventory_item_id),
        points: Number(row.points),
        pointCost: Number(row.point_cost),
        brokenSurcharge: Number(row.broken_surcharge),
        discount: Number(row.discount),
        total: Number(row.total),
        express: Boolean(row.express),
        status: row.status,
        expiresAt: row.expires_at,
        deliverAt: row.deliver_at,
        confirmedAt: row.confirmed_at,
        completedAt: row.completed_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function calculateRepairQuote(item, express = false) {
    if (item.durability_max === null) throw new EconomyServiceError('item_has_no_durability', 'Esse item não usa durabilidade na V1.');
    const points = Number(item.durability_max) - Number(item.durability_current);
    if (points <= 0) throw new EconomyServiceError('repair_not_needed', 'O item já está íntegro.');
    const pointCost = Math.max(20, Math.floor((Number(item.reference_price) * 0.5) / Number(item.durability_max)));
    const brokenSurcharge = Number(item.durability_current) === 0
        ? Math.floor(Number(item.reference_price) * 0.05)
        : 0;
    const normalTotal = pointCost * points + brokenSurcharge;
    const total = express ? normalTotal * 2 : normalTotal;
    const normalMinutes = points <= 2 ? 60 : points <= 4 ? 180 : 360;
    const durationMinutes = express ? Math.ceil(normalMinutes / 2) : normalMinutes;
    return { points, pointCost, brokenSurcharge, normalTotal, total, durationMinutes };
}

async function previewRepair(db, playerId, inventoryItemId, options = {}) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    await ensureYullsState(db, playerId);
    const idempotencyKey = String(options.idempotencyKey || '').trim() || null;
    if (idempotencyKey) {
        const existing = await db.get('SELECT * FROM clover_repair_orders WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) {
            if (existing.player_id !== playerId) throw new EconomyServiceError('idempotency_conflict', 'A chave pertence a outro reparo.');
            return { ok: true, duplicate: true, repair: serializeRepair(existing) };
        }
    }
    const row = await db.get(
        'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
        [Number(inventoryItemId), playerId]
    );
    if (!row) throw new EconomyServiceError('item_not_found', 'Item não encontrado no inventário.');
    const item = serializeItem(row);
    if (item.equipped_slot) throw new EconomyServiceError('item_equipped', 'Desequipe o item antes de reparar.');
    if (!['disponivel', 'quebrado'].includes(item.status)) throw new EconomyServiceError('item_not_available', 'O item está indisponível para reparo.');
    const quote = calculateRepairQuote(item, Boolean(options.express));
    const orderKey = generateKey('reparo');
    const expiresAt = addSeconds(options.now || new Date(), CONFIRMATION_SECONDS);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const voucher = await resolveVoucher(db, playerId, 'vale_reparo_5000', options.useVoucher);
        const discount = voucher ? Math.min(5000, quote.total) : 0;
        const total = Math.max(0, quote.total - discount);
        const itemReservation = await reserveInventoryItemInTransaction(db, playerId, item.id, 1, {
            reservationKey: `repair-item:${orderKey}`,
            sourceType: 'repair', sourceId: orderKey, createdBy: playerId, expiresAt,
            allowedStatuses: ['disponivel', 'quebrado'],
        });
        const voucherReservation = voucher
            ? await reserveInventoryItemInTransaction(db, playerId, voucher.id, 1, {
                reservationKey: `repair-voucher:${orderKey}`,
                sourceType: 'repair', sourceId: orderKey, createdBy: playerId, expiresAt,
            })
            : null;
        const yullsReservation = total > 0
            ? await reserveYullsInTransaction(db, playerId, total, {
                reservationKey: `repair:${orderKey}`,
                sourceType: 'repair', sourceId: orderKey, createdBy: playerId, expiresAt,
            })
            : null;
        await db.run(
            `INSERT INTO clover_repair_orders
             (order_key, player_id, inventory_item_id, points, point_cost, broken_surcharge,
              discount, total, express, status, yulls_reservation_id, inventory_reservation_id,
              voucher_item_id, voucher_reservation_id, idempotency_key, expires_at,
              created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
            [
                orderKey, playerId, item.id, quote.points, quote.pointCost, quote.brokenSurcharge,
                discount, total, options.express ? 1 : 0, yullsReservation?.id || null,
                itemReservation.id, voucher?.id || null, voucherReservation?.id || null,
                idempotencyKey, sqliteDate(expiresAt),
                JSON.stringify({ duration_minutes: quote.durationMinutes, item_name: item.item_name, via: options.via || 'bot' }),
            ]
        );
        const order = await db.get('SELECT * FROM clover_repair_orders WHERE order_key = ?', [orderKey]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, repair: serializeRepair(order), item };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function confirmRepair(db, playerId, orderKey, options = {}) {
    await ensureEconomyV1(db);
    await processDueEconomyOperations(db);
    const order = await db.get(
        'SELECT * FROM clover_repair_orders WHERE order_key = ? AND player_id = ?',
        [orderKey, playerId]
    );
    if (!order) throw new EconomyServiceError('repair_not_found', 'Reparo pendente não encontrado.');
    if (['in_progress', 'completed'].includes(order.status)) return { ok: true, duplicate: true, repair: serializeRepair(order) };
    if (order.status !== 'pending') throw new EconomyServiceError('repair_not_pending', 'Este reparo não pode mais ser confirmado.');
    const durationMinutes = Number(safeJsonParse(order.metadata_json, {}).duration_minutes || 60);
    const deliverAt = addMinutes(options.now || new Date(), durationMinutes);

    await db.exec('BEGIN IMMEDIATE');
    try {
        let spend = null;
        if (Number(order.total) > 0) {
            spend = await spendYullsInTransaction(
                db, playerId, Number(order.total), 'reparo', 'Serviço de reparo da Forja da Aliança', playerId,
                {
                    relatedId: order.order_key,
                    idempotencyKey: `yulls:repair:${order.id}`,
                    reservationId: order.yulls_reservation_id,
                    metadata: { inventory_item_id: Number(order.inventory_item_id), points: Number(order.points) },
                }
            );
        }
        if (order.voucher_item_id) {
            const voucher = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [order.voucher_item_id]);
            await consumeInventoryItemInTransaction(db, voucher, 1, {
                reservationId: order.voucher_reservation_id,
                action: 'vale_usado', source: 'reparo', relatedId: order.order_key,
                idempotencyKey: `inventory:repair-voucher:${order.id}`, createdBy: playerId,
            });
        }
        await releaseInventoryReservationInTransaction(db, order.inventory_reservation_id, {
            metadata: { reason: 'repair_confirmed' },
        });
        const itemBeforeRow = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [order.inventory_item_id, playerId]);
        if (!itemBeforeRow) throw new EconomyServiceError('item_not_found', 'Item do reparo não encontrado.');
        const before = serializeItem(itemBeforeRow);
        await db.run(
            "UPDATE clover_inventory_items SET status = 'em_reparo', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [order.inventory_item_id]
        );
        const after = serializeItem(await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [order.inventory_item_id]));
        await recordHistory(db, {
            itemId: Number(order.inventory_item_id), playerId, action: 'enviado_reparo', before, after,
            source: 'forja_alianca', relatedId: order.order_key, createdBy: playerId,
        });
        await db.run(
            `UPDATE clover_repair_orders
             SET status = 'in_progress', deliver_at = ?, confirmed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pending'`,
            [sqliteDate(deliverAt), order.id]
        );
        const updated = await db.get('SELECT * FROM clover_repair_orders WHERE id = ?', [order.id]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, repair: serializeRepair(updated), spend, item: after };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function useConsumable(db, playerId, inventoryItemId, options = {}) {
    await ensureEconomyV1(db);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new EconomyServiceError('missing_idempotency_key', 'O uso precisa de chave contra duplicidade.');
    const existing = await db.get('SELECT * FROM clover_consumable_uses WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) {
        if (existing.player_id !== playerId) throw new EconomyServiceError('idempotency_conflict', 'A chave pertence ao uso de outro player.');
        return { ok: true, duplicate: true, use: existing };
    }
    const row = await db.get(
        'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
        [Number(inventoryItemId), playerId]
    );
    if (!row) throw new EconomyServiceError('item_not_found', 'Item não encontrado no inventário.');
    const item = serializeItem(row);
    if (item.status !== 'disponivel' || item.available_quantity < 1) throw new EconomyServiceError('item_not_available', 'Item indisponível para uso.');
    if (item.category === 'caixa') throw new EconomyServiceError('use_box_command', 'Caixas devem ser abertas pelo sistema de caixas.');
    const usable = item.category === 'consumivel' || item.category === 'kit' || item.kind === 'consumivel_comum' || item.kind === 'kit';
    if (!usable) throw new EconomyServiceError('item_not_consumable', 'Esse item não é consumível na V1.');
    const contextType = String(options.contextType || 'livre').trim() || 'livre';
    const explicitContextId = String(options.contextId || '').trim();
    const contextId = explicitContextId || `${contextType}:${getEconomicWeekKey()}`;
    const tracksAlchemyLimit = ['raid', 'missao', 'cena'].includes(normalizeText(contextType))
        && Boolean(explicitContextId);
    const effectKey = item.effects.effectKey || item.template_key || item.item_name;
    const effectCategory = item.effects.category || null;

    await db.exec('BEGIN IMMEDIATE');
    try {
        let result = 'used';
        if (effectCategory === 'aprimoramento_fisico' && tracksAlchemyLimit) {
            const uses = await db.get(
                `SELECT COUNT(*) AS total FROM clover_consumable_uses
                 WHERE player_id = ? AND context_type = ? AND context_id = ?
                   AND effect_category = 'aprimoramento_fisico'`,
                [playerId, contextType, contextId]
            );
            if (Number(uses?.total || 0) >= 2) result = 'overload';
        }
        const consumed = await consumeInventoryItemInTransaction(db, row, 1, {
            action: 'consumido', source: 'uso_consumivel', relatedId: contextId,
            idempotencyKey: `inventory:${idempotencyKey}`, createdBy: playerId,
            metadata: { context_type: contextType, context_id: contextId },
        });
        const inserted = await db.run(
            `INSERT INTO clover_consumable_uses
             (player_id, inventory_item_id, template_key, quantity, context_type, context_id,
              effect_key, effect_category, result, idempotency_key, used_at, metadata_json)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                playerId, item.id, item.template_key, contextType, contextId, effectKey,
                effectCategory, result, idempotencyKey,
                JSON.stringify({ item_name: item.item_name, effects: item.effects, via: options.via || 'bot' }),
            ]
        );
        if (effectCategory === 'aprimoramento_fisico' && tracksAlchemyLimit) {
            await db.run(
                `UPDATE clover_active_item_effects
                 SET status = 'replaced', ended_at = CURRENT_TIMESTAMP
                 WHERE player_id = ? AND context_type = ? AND context_id = ?
                   AND effect_category = 'aprimoramento_fisico' AND status = 'active'`,
                [playerId, contextType, contextId]
            );
            await db.run(
                `INSERT INTO clover_active_item_effects
                 (player_id, inventory_item_id, template_key, effect_key, effect_category,
                  context_type, context_id, status, started_at, metadata_json)
                 VALUES (?, ?, ?, ?, 'aprimoramento_fisico', ?, ?, 'active', CURRENT_TIMESTAMP, ?)`,
                [
                    playerId, item.id, item.template_key,
                    result === 'overload' ? 'cansado_sobrecarga_alquimica' : effectKey,
                    contextType, contextId,
                    JSON.stringify(result === 'overload'
                        ? { condition: 'Cansado por Sobrecarga Alquímica', narrator_applies: true }
                        : item.effects),
                ]
            );
        }
        const use = await db.get('SELECT * FROM clover_consumable_uses WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            use,
            consumed,
            result,
            narratorApplies: true,
            effect: result === 'overload'
                ? { label: 'Cansado por Sobrecarga Alquímica', active: false }
                : item.effects,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function salaryTier(patent) {
    const normalized = normalizeText(patent);
    const classMatch = normalized.match(/([1-5])/);
    const classNumber = classMatch ? classMatch[1] : null;
    if (normalized.includes('senior') && classNumber) return `senior_${classNumber}`;
    if ((normalized.includes('intermediario') || normalized.includes('intermedio')) && classNumber) return `intermediario_${classNumber}`;
    if (normalized.includes('junior') && classNumber) return `junior_${classNumber}`;
    return 'aspirante';
}

function salaryForPatent(patent) {
    const tier = salaryTier(patent);
    return { tier, amount: SALARY_BY_TIER[tier] || SALARY_BY_TIER.aspirante };
}

async function findSalaryService(db, playerId, weekKey) {
    const evaluation = await db.get(
        `SELECT id, modality_key, modality_label, scene_sent_at, week_key
         FROM clover_quick_evaluations
         WHERE player_id = ? AND week_key = ?
           AND (
               salary_eligible = 1
               OR (salary_eligible IS NULL AND modality_key IN ('missao_auto_narrada', 'missao_desenvolvimento'))
           )
         ORDER BY COALESCE(scene_sent_at, created_at) ASC, id ASC LIMIT 1`,
        [playerId, weekKey]
    );
    if (evaluation) {
        return {
            source: 'quick_evaluation',
            id: String(evaluation.id),
            label: evaluation.modality_label,
            occurredAt: evaluation.scene_sent_at,
        };
    }
    const nextWeek = shiftWeekKey(weekKey, 1);
    const raid = await db.get(
        `SELECT raid.id, raid.raid_key, raid.name, raid.completed_at
         FROM clover_raid_participants participant
         JOIN clover_raids raid ON raid.id = participant.raid_id
         WHERE participant.player_id = ? AND participant.status = 'completed'
           AND raid.status = 'completed' AND raid.salary_eligible = 1
           AND raid.completed_at >= ? AND raid.completed_at < ?
         ORDER BY raid.completed_at ASC, raid.id ASC LIMIT 1`,
        [playerId, `${weekKey} 03:00:00`, `${nextWeek} 03:00:00`]
    );
    if (raid) return { source: 'raid', id: String(raid.id), label: raid.name, occurredAt: raid.completed_at, raidKey: raid.raid_key };
    return null;
}

async function getSalaryEligibility(db, playerId, weekKey = getEconomicWeekKey()) {
    await ensureEconomyV1(db);
    const player = await db.get(
        `SELECT id, personagem_nome, nome, patente, esquadrao, estrelas, jogo_status
         FROM jogadores WHERE id = ?`,
        [playerId]
    );
    if (!player) throw new EconomyServiceError('player_not_found', 'Player não encontrado.');
    const released = normalizeText(player.jogo_status) === 'liberado';
    const resolvedPatent = resolvePatent(player);
    const patentKey = normalizeText(resolvedPatent);
    const military = hasSquad(player)
        && !['', 'n a', 'na', 'civil', 'civil sem patente'].includes(patentKey);
    const service = released && military ? await findSalaryService(db, playerId, weekKey) : null;
    const salary = salaryForPatent(resolvedPatent);
    const claim = await db.get(
        'SELECT * FROM clover_salary_claims WHERE player_id = ? AND week_key = ?',
        [playerId, weekKey]
    );
    return {
        playerId,
        weekKey,
        patent: resolvedPatent,
        tier: salary.tier,
        amount: salary.amount,
        gameReleased: released,
        military,
        eligible: Boolean(released && military && service),
        service,
        paid: Boolean(claim && claim.status === 'paid'),
        claim,
    };
}

async function paySalaryForWeek(db, playerId, weekKey, options = {}) {
    await ensureEconomyV1(db);
    const eligibility = await getSalaryEligibility(db, playerId, weekKey);
    if (!eligibility.eligible) return { ok: true, paid: false, reason: 'not_eligible', eligibility };
    if (eligibility.paid) return { ok: true, paid: true, duplicate: true, eligibility };
    await ensureYullsState(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await db.get(
            'SELECT * FROM clover_salary_claims WHERE player_id = ? AND week_key = ?',
            [playerId, weekKey]
        );
        if (existing) {
            await db.exec('COMMIT');
            return { ok: true, paid: existing.status === 'paid', duplicate: true, claim: existing, eligibility };
        }
        const credit = await addYullsInTransaction(
            db, playerId, eligibility.amount, 'salario_cavaleiro', `Salário semanal — ${eligibility.patent}`, options.actorId || 'system',
            {
                relatedId: `salary:${weekKey}:${playerId}`,
                idempotencyKey: `yulls:salary:${weekKey}:${playerId}`,
                metadata: { week_key: weekKey, service: eligibility.service, patent: eligibility.patent },
            }
        );
        const inserted = await db.run(
            `INSERT INTO clover_salary_claims
             (player_id, week_key, patent, amount, service_source, service_id, status,
              yulls_ledger_id, paid_at, created_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
            [
                playerId, weekKey, eligibility.patent, eligibility.amount,
                eligibility.service.source, eligibility.service.id, credit.ledgerId,
                JSON.stringify({ service_label: eligibility.service.label, automatic: options.automatic !== false }),
            ]
        );
        const claim = await db.get('SELECT * FROM clover_salary_claims WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, paid: true, duplicate: false, claim, credit, eligibility };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function processDueSalaries(db, options = {}) {
    await ensureEconomyV1(db);
    const currentWeek = getEconomicWeekKey(options.now || new Date());
    const weekKey = options.weekKey || shiftWeekKey(currentWeek, -1);
    const candidates = await db.all(
        `SELECT candidate.player_id
         FROM (
             SELECT DISTINCT player_id
             FROM clover_quick_evaluations
             WHERE week_key = ? AND (
                 salary_eligible = 1
                 OR (salary_eligible IS NULL AND modality_key IN ('missao_auto_narrada', 'missao_desenvolvimento'))
             )
             UNION
             SELECT DISTINCT participant.player_id
             FROM clover_raid_participants participant
             JOIN clover_raids raid ON raid.id = participant.raid_id
             WHERE participant.status = 'completed'
               AND raid.status = 'completed'
               AND raid.salary_eligible = 1
               AND raid.completed_at >= ?
               AND raid.completed_at < ?
         ) candidate
         WHERE NOT EXISTS (
             SELECT 1
             FROM clover_salary_claims claim
             WHERE claim.player_id = candidate.player_id
               AND claim.week_key = ?
         )`,
        [
            weekKey,
            `${weekKey} 03:00:00`,
            `${shiftWeekKey(weekKey, 1)} 03:00:00`,
            weekKey,
        ]
    );
    const results = [];
    for (const candidate of candidates) {
        results.push(await paySalaryForWeek(db, candidate.player_id, weekKey, {
            actorId: options.actorId || 'system', automatic: true,
        }));
    }
    return {
        ok: true,
        weekKey,
        candidates: candidates.length,
        paid: results.filter((result) => result.paid && !result.duplicate).length,
        results,
    };
}

async function getSalaryDashboard(db, playerId, options = {}) {
    const currentWeek = getEconomicWeekKey(options.now || new Date());
    const previousWeek = shiftWeekKey(currentWeek, -1);
    await paySalaryForWeek(db, playerId, previousWeek, { actorId: 'system', automatic: true });
    return {
        current: await getSalaryEligibility(db, playerId, currentWeek),
        previous: await getSalaryEligibility(db, playerId, previousWeek),
        nextPayment: `${shiftWeekKey(currentWeek, 1)} 00:00 BRT`,
    };
}

async function grantInitialPackage(db, playerId, equipmentTemplateKey, options = {}) {
    await ensureEconomyV1(db);
    if (!INITIAL_EQUIPMENT_KEYS.has(equipmentTemplateKey)) {
        throw new EconomyServiceError('invalid_initial_equipment', 'Escolha uma arma mundana, cajado ou varinha básica permitida.');
    }
    const player = await db.get('SELECT id, jogo_status FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new EconomyServiceError('player_not_found', 'Player não encontrado.');
    if (normalizeText(player.jogo_status) !== 'liberado') throw new EconomyServiceError('game_blocked', 'O jogo precisa estar liberado.');
    const existing = await db.get('SELECT * FROM clover_economy_initial_packages WHERE player_id = ?', [playerId]);
    if (existing) return { ok: true, duplicate: true, package: existing };
    await ensureYullsState(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const credit = await addYullsInTransaction(
            db, playerId, 500, 'pacote_inicial_economia', 'Pacote inicial da Economia V1', options.actorId || playerId,
            { relatedId: `initial-package:${playerId}`, idempotencyKey: `yulls:initial-package:${playerId}` }
        );
        const granted = [];
        for (const [templateKey, sourceLabel] of [
            ['roupas_comuns', 'roupa_inicial'],
            [equipmentTemplateKey, 'equipamento_inicial'],
            ['kit_campo', 'kit_inicial'],
        ]) {
            const result = await addCatalogItemInTransaction(db, playerId, templateKey, 1, {
                bound: true,
                source: 'pacote_inicial_economia',
                relatedId: `initial-package:${playerId}`,
                createdBy: options.actorId || playerId,
                metadata: { initial_package: true, initial_type: sourceLabel, no_resale_value: true },
            });
            granted.push(...result.items);
        }
        const inserted = await db.run(
            `INSERT INTO clover_economy_initial_packages
             (player_id, equipment_template_key, status, yulls_ledger_id,
              inventory_item_ids_json, granted_at, metadata_json)
             VALUES (?, ?, 'completed', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                playerId, equipmentTemplateKey, credit.ledgerId,
                JSON.stringify(granted.map((item) => item.id)),
                JSON.stringify({ via: options.via || 'site' }),
            ]
        );
        const packageRow = await db.get('SELECT * FROM clover_economy_initial_packages WHERE rowid = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, package: packageRow, credit, items: granted };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getEconomyDashboard(db, playerId) {
    await ensureEconomyV1(db);
    const wallet = await getYullsSummary(db, playerId);
    const history = await getYullsHistory(db, playerId, 20);
    const shops = await listShops(db);
    const purchases = await db.all('SELECT * FROM clover_economy_purchase_intents WHERE player_id = ? ORDER BY id DESC LIMIT 20', [playerId]);
    const repairs = await db.all('SELECT * FROM clover_repair_orders WHERE player_id = ? ORDER BY id DESC LIMIT 20', [playerId]);
    const effects = await db.all("SELECT * FROM clover_active_item_effects WHERE player_id = ? AND status = 'active' ORDER BY id DESC", [playerId]);
    const salary = await getSalaryDashboard(db, playerId);
    const initialPackage = await db.get('SELECT * FROM clover_economy_initial_packages WHERE player_id = ?', [playerId]);
    return {
        wallet,
        history,
        shops,
        purchases: purchases.map(serializePurchase),
        repairs: repairs.map(serializeRepair),
        activeEffects: effects,
        salary,
        initialPackage: initialPackage || null,
        initialEquipmentOptions: [...INITIAL_EQUIPMENT_KEYS],
        market: { enabled: true, status: 'ativo', endpoint: '/economy/market' },
        auctions: { enabled: true, status: 'ativo', endpoint: '/economy/market?type=auction' },
        weeklyRequests: { enabled: true, status: 'ativo', endpoint: '/economy/weekly-requests' },
    };
}

module.exports = {
    CONFIRMATION_SECONDS,
    EconomyServiceError,
    INITIAL_EQUIPMENT_KEYS,
    SALARY_BY_TIER,
    SHOP_DEFINITIONS,
    calculateRepairQuote,
    cancelPurchase,
    confirmNpcSale,
    confirmPurchase,
    confirmRepair,
    ensureEconomyV1,
    getEconomicWeekKey,
    getEconomyDashboard,
    getSalaryDashboard,
    getSalaryEligibility,
    getShopCatalog,
    grantInitialPackage,
    listShops,
    paySalaryForWeek,
    previewNpcSale,
    previewPurchase,
    previewRepair,
    processDueEconomyOperations,
    processDueSalaries,
    salaryForPatent,
    seedEconomyCatalog,
    shiftWeekKey,
    useConsumable,
};
