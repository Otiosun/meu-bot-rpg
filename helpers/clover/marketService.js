'use strict';

const crypto = require('crypto');

const { ensureCloverEconomySchema } = require('../../database');
const {
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    getItemTemplateInTransaction,
    releaseInventoryReservationInTransaction,
    reserveInventoryItemInTransaction,
    serializeItem,
    transferReservedInventoryItemInTransaction,
} = require('./inventoryService');
const {
    addYullsInTransaction,
    getYullsSummary,
    releaseYullsReservationInTransaction,
    reserveYullsInTransaction,
    spendYullsInTransaction,
} = require('./yullsService');
const { requireItemManager } = require('./itemAdminService');

const CONFIRMATION_SECONDS = 120;
const FIXED_LISTING_HOURS = 168;
const TRADE_HOURS = 24;
const PUBLICATION_PERCENT = 10;
const PUBLICATION_MINIMUM = 20;
const SALE_PERCENT = 5;
const AUCTION_DURATIONS = new Set([24, 48, 72]);

class MarketServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'MarketServiceError';
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

function sqliteDate(date = new Date()) {
    return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

function addSeconds(date, seconds) {
    return new Date(new Date(date).getTime() + Number(seconds) * 1000);
}

function addHours(date, hours) {
    return addSeconds(date, Number(hours) * 3600);
}

function generateKey(prefix) {
    return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function positiveInteger(value, field, maximum = 100000000) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0 || number > maximum) {
        throw new MarketServiceError('invalid_value', `${field} inválido.`, { field, maximum });
    }
    return number;
}

function nonNegativeInteger(value, field, maximum = 100000000) {
    const number = Number(value || 0);
    if (!Number.isInteger(number) || number < 0 || number > maximum) {
        throw new MarketServiceError('invalid_value', `${field} inválido.`, { field, maximum });
    }
    return number;
}

function publicationFee(total) {
    return Math.max(PUBLICATION_MINIMUM, Math.floor(Number(total) * PUBLICATION_PERCENT / 100));
}

function saleFee(total) {
    return Math.floor(Number(total) * SALE_PERCENT / 100);
}

function serializePayment(row) {
    return row ? {
        key: row.payment_key,
        senderId: row.sender_id,
        recipientId: row.recipient_id,
        amount: Number(row.amount),
        reason: row.reason,
        status: row.status,
        expiresAt: row.expires_at,
        completedAt: row.completed_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    } : null;
}

function serializeListing(row) {
    if (!row) return null;
    const quantity = Number(row.quantity || 0);
    const soldQuantity = Number(row.sold_quantity || 0);
    const pendingQuantity = Number(row.pending_quantity || 0);
    return {
        key: row.listing_key,
        sellerId: row.seller_id,
        type: row.listing_type,
        inventoryItemId: Number(row.inventory_item_id),
        itemName: row.item_name || null,
        description: row.item_description || null,
        quality: row.item_quality || null,
        condition: row.durability_max === null || row.durability_max === undefined
            ? null
            : serializeItem({
                durability_current: row.durability_current,
                durability_max: row.durability_max,
                quantity: 1,
                transferable: 1,
            }).condition,
        quantity,
        soldQuantity,
        pendingQuantity,
        availableQuantity: Math.max(0, quantity - soldQuantity - pendingQuantity),
        unitPrice: row.unit_price === null ? null : Number(row.unit_price),
        startingBid: row.starting_bid === null ? null : Number(row.starting_bid),
        publicationFee: Number(row.publication_fee),
        saleFeePercent: Number(row.sale_fee_percent),
        currentBid: row.current_bid === null || row.current_bid === undefined ? null : Number(row.current_bid),
        currentBidderId: row.current_bidder_id || null,
        status: row.status,
        originalEndsAt: row.original_ends_at,
        endsAt: row.ends_at,
        extensionMinutes: Number(row.extension_minutes || 0),
        winnerId: row.winner_id || null,
        winningBid: row.winning_bid === null ? null : Number(row.winning_bid),
        createdAt: row.created_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function serializeTrade(row) {
    return row ? {
        key: row.trade_key,
        creatorId: row.creator_id,
        targetId: row.target_id,
        creatorItems: safeJsonParse(row.creator_items_json, []),
        targetItems: safeJsonParse(row.target_items_json, []),
        creatorYulls: Number(row.creator_yulls || 0),
        targetYulls: Number(row.target_yulls || 0),
        creatorConfirmed: Boolean(row.creator_confirmed),
        targetConfirmed: Boolean(row.target_confirmed),
        revision: Number(row.revision),
        note: row.note,
        status: row.status,
        expiresAt: row.expires_at,
        completedAt: row.completed_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    } : null;
}

function serializeWeeklyRequest(row) {
    return row ? {
        key: row.request_key,
        weekKey: row.week_key,
        npcName: row.npc_name,
        templateKey: row.template_key,
        itemName: row.item_name,
        description: row.description,
        pricePercent: Number(row.price_percent),
        unitPrice: Number(row.unit_price),
        globalQuantity: Number(row.global_quantity),
        deliveredQuantity: Number(row.delivered_quantity),
        availableQuantity: Math.max(0, Number(row.global_quantity) - Number(row.delivered_quantity)),
        personalLimit: Number(row.personal_limit),
        playerDelivered: Number(row.player_delivered || 0),
        playerRemaining: Math.max(0, Number(row.personal_limit) - Number(row.player_delivered || 0)),
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    } : null;
}

async function ensurePlayer(db, playerId) {
    const row = await db.get('SELECT id, personagem_nome, nome FROM jogadores WHERE id = ?', [playerId]);
    if (!row) throw new MarketServiceError('player_not_found', 'Jogador não encontrado.');
    return row;
}

async function ensureMarketV1(db) {
    await ensureCloverEconomySchema(db);
    await ensureInventoryV1(db);
}

async function expirePaymentIntentsInTransaction(db) {
    const rows = await db.all(
        `SELECT * FROM clover_economy_payment_intents
         WHERE status = 'pending' AND datetime(expires_at) <= CURRENT_TIMESTAMP`
    );
    for (const row of rows) {
        if (row.yulls_reservation_id) {
            await releaseYullsReservationInTransaction(db, row.yulls_reservation_id, { metadata: { reason: 'payment_expired' } });
        }
        await db.run(
            `UPDATE clover_economy_payment_intents
             SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
            [row.id]
        );
    }
    return rows.length;
}

async function previewPayment(db, senderId, recipientId, amount, reason, options = {}) {
    await ensureMarketV1(db);
    const value = positiveInteger(amount, 'Valor');
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) throw new MarketServiceError('missing_reason', 'Informe o motivo do pagamento.');
    if (senderId === recipientId) throw new MarketServiceError('same_player', 'Você não pode pagar a si mesmo.');
    await ensurePlayer(db, senderId);
    await ensurePlayer(db, recipientId);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new MarketServiceError('missing_idempotency_key', 'A operação precisa de uma chave única.');

    await db.exec('BEGIN IMMEDIATE');
    try {
        await expirePaymentIntentsInTransaction(db);
        const existing = await db.get('SELECT * FROM clover_economy_payment_intents WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, payment: serializePayment(existing) };
        }
        const key = generateKey('PAG');
        const expiresAt = addSeconds(options.now || new Date(), CONFIRMATION_SECONDS);
        const reservation = await reserveYullsInTransaction(db, senderId, value, {
            reservationKey: `payment:${key}`,
            sourceType: 'player_payment',
            sourceId: key,
            createdBy: senderId,
            expiresAt,
        });
        const inserted = await db.run(
            `INSERT INTO clover_economy_payment_intents
             (payment_key, sender_id, recipient_id, amount, reason, status,
              yulls_reservation_id, idempotency_key, expires_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            [key, senderId, recipientId, value, cleanReason, reservation.id, idempotencyKey, sqliteDate(expiresAt), JSON.stringify({ via: options.via || 'site' })]
        );
        const row = await db.get('SELECT * FROM clover_economy_payment_intents WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, payment: serializePayment(row) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function confirmPayment(db, senderId, paymentKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        await expirePaymentIntentsInTransaction(db);
        const row = await db.get(
            'SELECT * FROM clover_economy_payment_intents WHERE payment_key = ? AND sender_id = ?',
            [String(paymentKey || '').trim(), senderId]
        );
        if (!row) throw new MarketServiceError('payment_not_found', 'Pagamento não encontrado.');
        if (row.status === 'completed') {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, payment: serializePayment(row) };
        }
        if (row.status !== 'pending') throw new MarketServiceError('payment_not_pending', 'Esse pagamento não pode mais ser confirmado.');
        await spendYullsInTransaction(db, row.sender_id, Number(row.amount), 'pagamento_jogador', row.reason, row.sender_id, {
            reservationId: row.yulls_reservation_id,
            relatedId: row.payment_key,
            idempotencyKey: `yulls:payment:out:${row.id}`,
            metadata: { recipient_id: row.recipient_id },
        });
        await addYullsInTransaction(db, row.recipient_id, Number(row.amount), 'pagamento_jogador', row.reason, row.sender_id, {
            relatedId: row.payment_key,
            idempotencyKey: `yulls:payment:in:${row.id}`,
            metadata: { sender_id: row.sender_id },
        });
        await db.run(
            `UPDATE clover_economy_payment_intents
             SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [row.id]
        );
        const updated = await db.get('SELECT * FROM clover_economy_payment_intents WHERE id = ?', [row.id]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, payment: serializePayment(updated) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelPayment(db, senderId, paymentKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const row = await db.get(
            'SELECT * FROM clover_economy_payment_intents WHERE payment_key = ? AND sender_id = ?',
            [String(paymentKey || '').trim(), senderId]
        );
        if (!row) throw new MarketServiceError('payment_not_found', 'Pagamento não encontrado.');
        if (row.status !== 'pending') throw new MarketServiceError('payment_not_pending', 'Esse pagamento não está pendente.');
        await releaseYullsReservationInTransaction(db, row.yulls_reservation_id, { metadata: { reason: 'payment_cancelled' } });
        await db.run(
            `UPDATE clover_economy_payment_intents
             SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [row.id]
        );
        const updated = await db.get('SELECT * FROM clover_economy_payment_intents WHERE id = ?', [row.id]);
        await db.exec('COMMIT');
        return { ok: true, payment: serializePayment(updated) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getListingRow(db, listingKey) {
    const row = await db.get(
        `SELECT listing.*, item.item_name, item.description AS item_description,
                item.quality AS item_quality, item.durability_current, item.durability_max,
                COALESCE((
                    SELECT SUM(intent.quantity) FROM clover_market_purchase_intents intent
                    WHERE intent.listing_id = listing.id AND intent.status = 'pending'
                      AND datetime(intent.expires_at) > CURRENT_TIMESTAMP
                ), 0) AS pending_quantity,
                (SELECT bid.amount FROM clover_market_bids bid
                 WHERE bid.listing_id = listing.id AND bid.status = 'current'
                 ORDER BY bid.amount DESC, bid.id DESC LIMIT 1) AS current_bid,
                (SELECT bid.bidder_id FROM clover_market_bids bid
                 WHERE bid.listing_id = listing.id AND bid.status = 'current'
                 ORDER BY bid.amount DESC, bid.id DESC LIMIT 1) AS current_bidder_id
         FROM clover_market_listings listing
         LEFT JOIN clover_inventory_items item ON item.id = listing.inventory_item_id
         WHERE listing.listing_key = ? COLLATE NOCASE OR CAST(listing.id AS TEXT) = ?`,
        [String(listingKey || '').trim(), String(listingKey || '').trim()]
    );
    if (!row) throw new MarketServiceError('listing_not_found', 'Anúncio não encontrado.');
    return row;
}

async function createMarketListing(db, sellerId, input = {}, options = {}) {
    await ensureMarketV1(db);
    await ensurePlayer(db, sellerId);
    const type = input.type === 'auction' || input.tipo === 'leilao' ? 'auction' : 'fixed';
    const inventoryItemId = positiveInteger(input.inventoryItemId || input.inventory_item_id || input.itemId, 'Item');
    const quantity = positiveInteger(input.quantity || input.quantidade || 1, 'Quantidade', 50);
    const price = positiveInteger(
        type === 'auction' ? (input.startingBid || input.starting_bid || input.lanceInicial) : (input.unitPrice || input.unit_price || input.preco),
        type === 'auction' ? 'Lance inicial' : 'Preço'
    );
    const durationHours = type === 'auction'
        ? positiveInteger(input.durationHours || input.duration_hours || input.duracao || 24, 'Duração', 72)
        : positiveInteger(input.durationHours || input.duration_hours || FIXED_LISTING_HOURS, 'Duração', 720);
    if (type === 'auction' && !AUCTION_DURATIONS.has(durationHours)) {
        throw new MarketServiceError('invalid_auction_duration', 'Leilões duram 24, 48 ou 72 horas.');
    }
    const totalReference = price * quantity;
    const fee = publicationFee(totalReference);
    const key = generateKey(type === 'auction' ? 'LEI' : 'ANU');
    const now = options.now || new Date();
    const endsAt = addHours(now, durationHours);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const item = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [inventoryItemId, sellerId]);
        if (!item) throw new MarketServiceError('item_not_found', 'Item não encontrado no seu inventário.');
        if (item.bound || !item.transferable) throw new MarketServiceError('item_bound', 'Item vinculado não pode ser anunciado.');
        if (safeJsonParse(item.metadata_json, {}).template_flags?.marketable === false) {
            throw new MarketServiceError('item_not_marketable', 'Esse modelo não foi liberado para o mercado.');
        }
        if (item.equipped_slot || !['disponivel', 'quebrado'].includes(item.status)) {
            throw new MarketServiceError('item_not_available', 'Item equipado, em trânsito, reparo ou indisponível não pode ser anunciado.');
        }
        const reservation = await reserveInventoryItemInTransaction(db, sellerId, item.id, quantity, {
            reservationKey: `market-listing:${key}`,
            sourceType: type === 'auction' ? 'market_auction' : 'market_fixed',
            sourceId: key,
            createdBy: sellerId,
            expiresAt: endsAt,
            allowedStatuses: ['disponivel', 'quebrado'],
        });
        await spendYullsInTransaction(db, sellerId, fee, 'taxa_publicacao_mercado', `Publicação ${key}`, sellerId, {
            relatedId: key,
            idempotencyKey: `yulls:market:publication:${key}`,
            metadata: { listing_type: type, announced_total: totalReference },
        });
        const inserted = await db.run(
            `INSERT INTO clover_market_listings
             (listing_key, seller_id, listing_type, inventory_item_id, quantity,
              unit_price, starting_bid, publication_fee, sale_fee_percent,
              inventory_reservation_id, status, original_ends_at, ends_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            [
                key, sellerId, type, item.id, quantity,
                type === 'fixed' ? price : null,
                type === 'auction' ? price : null,
                fee, SALE_PERCENT, reservation.id,
                sqliteDate(endsAt), sqliteDate(endsAt),
                JSON.stringify({ via: options.via || 'site', duration_hours: durationHours }),
            ]
        );
        const row = await getListingRow(db, key);
        await db.exec('COMMIT');
        return { ok: true, listing: serializeListing(row), publicationFee: fee, id: inserted.lastID };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listMarket(db, actorId, options = {}) {
    await ensureMarketV1(db);
    const type = ['fixed', 'auction'].includes(options.type) ? options.type : null;
    const mine = Boolean(options.mine);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const rows = await db.all(
        `SELECT listing.*, item.item_name, item.description AS item_description,
                item.quality AS item_quality, item.durability_current, item.durability_max,
                COALESCE((SELECT SUM(intent.quantity) FROM clover_market_purchase_intents intent
                          WHERE intent.listing_id = listing.id AND intent.status = 'pending'
                            AND datetime(intent.expires_at) > CURRENT_TIMESTAMP), 0) AS pending_quantity,
                (SELECT bid.amount FROM clover_market_bids bid WHERE bid.listing_id = listing.id AND bid.status = 'current'
                 ORDER BY bid.amount DESC, bid.id DESC LIMIT 1) AS current_bid,
                (SELECT bid.bidder_id FROM clover_market_bids bid WHERE bid.listing_id = listing.id AND bid.status = 'current'
                 ORDER BY bid.amount DESC, bid.id DESC LIMIT 1) AS current_bidder_id
         FROM clover_market_listings listing
         LEFT JOIN clover_inventory_items item ON item.id = listing.inventory_item_id
         WHERE (? IS NULL OR listing.listing_type = ?)
           AND (? = 0 OR listing.seller_id = ?)
           AND (listing.status = 'active' OR ? = 1)
         ORDER BY CASE WHEN listing.status = 'active' THEN 0 ELSE 1 END, listing.ends_at ASC, listing.id DESC
         LIMIT ?`,
        [type, type, mine ? 1 : 0, actorId, mine ? 1 : 0, limit]
    );
    return rows.map(serializeListing);
}

async function expireMarketPurchasesInTransaction(db) {
    const rows = await db.all(
        `SELECT * FROM clover_market_purchase_intents
         WHERE status = 'pending' AND datetime(expires_at) <= CURRENT_TIMESTAMP`
    );
    for (const row of rows) {
        await releaseYullsReservationInTransaction(db, row.yulls_reservation_id, { metadata: { reason: 'market_purchase_expired' } });
        await db.run("UPDATE clover_market_purchase_intents SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    }
    return rows.length;
}

async function previewMarketPurchase(db, buyerId, listingKey, quantity = 1, options = {}) {
    await ensureMarketV1(db);
    const amount = positiveInteger(quantity, 'Quantidade', 50);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new MarketServiceError('missing_idempotency_key', 'A operação precisa de uma chave única.');
    await ensurePlayer(db, buyerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        await expireMarketPurchasesInTransaction(db);
        const existing = await db.get('SELECT * FROM clover_market_purchase_intents WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) {
            const listing = await getListingRow(db, String(existing.listing_id));
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, intent: existing, listing: serializeListing(listing) };
        }
        const listing = await getListingRow(db, listingKey);
        if (listing.listing_type !== 'fixed' || listing.status !== 'active' || new Date(`${listing.ends_at}Z`) <= new Date(options.now || Date.now())) {
            throw new MarketServiceError('listing_not_available', 'Esse anúncio não está disponível para compra.');
        }
        if (listing.seller_id === buyerId) throw new MarketServiceError('own_listing', 'Você não pode comprar o próprio anúncio.');
        const available = Number(listing.quantity) - Number(listing.sold_quantity) - Number(listing.pending_quantity || 0);
        if (amount > available) throw new MarketServiceError('listing_quantity_unavailable', 'Quantidade indisponível no anúncio.', { available });
        const total = Number(listing.unit_price) * amount;
        const key = generateKey('CMP');
        const expiresAt = addSeconds(options.now || new Date(), CONFIRMATION_SECONDS);
        const reservation = await reserveYullsInTransaction(db, buyerId, total, {
            reservationKey: `market-purchase:${key}`,
            sourceType: 'market_purchase', sourceId: key, createdBy: buyerId, expiresAt,
        });
        const inserted = await db.run(
            `INSERT INTO clover_market_purchase_intents
             (intent_key, listing_id, buyer_id, quantity, total, status,
              yulls_reservation_id, idempotency_key, expires_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            [key, listing.id, buyerId, amount, total, reservation.id, idempotencyKey, sqliteDate(expiresAt), JSON.stringify({ via: options.via || 'site' })]
        );
        const intent = await db.get('SELECT * FROM clover_market_purchase_intents WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, intent, listing: serializeListing(listing) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function releaseOtherPendingPurchasesInTransaction(db, listingId, excludeId = null) {
    const rows = await db.all(
        `SELECT * FROM clover_market_purchase_intents
         WHERE listing_id = ? AND status = 'pending' AND (? IS NULL OR id != ?)`,
        [listingId, excludeId, excludeId]
    );
    for (const row of rows) {
        await releaseYullsReservationInTransaction(db, row.yulls_reservation_id, { metadata: { reason: 'listing_sold_out' } });
        await db.run("UPDATE clover_market_purchase_intents SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    }
}

async function confirmMarketPurchase(db, buyerId, intentKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        await expireMarketPurchasesInTransaction(db);
        const intent = await db.get(
            'SELECT * FROM clover_market_purchase_intents WHERE intent_key = ? AND buyer_id = ?',
            [String(intentKey || '').trim(), buyerId]
        );
        if (!intent) throw new MarketServiceError('market_purchase_not_found', 'Compra do mercado não encontrada.');
        if (intent.status === 'completed') {
            const listing = await getListingRow(db, String(intent.listing_id));
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, intent, listing: serializeListing(listing) };
        }
        if (intent.status !== 'pending') throw new MarketServiceError('market_purchase_not_pending', 'Essa compra não está pendente.');
        const listing = await getListingRow(db, String(intent.listing_id));
        const remaining = Number(listing.quantity) - Number(listing.sold_quantity);
        if (listing.status !== 'active' || Number(intent.quantity) > remaining) {
            throw new MarketServiceError('listing_quantity_unavailable', 'O anúncio não possui mais essa quantidade.');
        }
        await spendYullsInTransaction(db, buyerId, Number(intent.total), 'compra_mercado', `Compra ${listing.listing_key}`, buyerId, {
            reservationId: intent.yulls_reservation_id,
            relatedId: intent.intent_key,
            idempotencyKey: `yulls:market:purchase:${intent.id}`,
            metadata: { seller_id: listing.seller_id, listing_key: listing.listing_key },
        });
        const fee = saleFee(intent.total);
        const sellerNet = Number(intent.total) - fee;
        await addYullsInTransaction(db, listing.seller_id, sellerNet, 'venda_mercado', `Venda ${listing.listing_key}`, buyerId, {
            relatedId: intent.intent_key,
            idempotencyKey: `yulls:market:sale:${intent.id}`,
            metadata: { buyer_id: buyerId, gross: Number(intent.total), fee },
        });
        const transfer = await transferReservedInventoryItemInTransaction(db, listing.inventory_reservation_id, buyerId, {
            quantity: Number(intent.quantity), source: 'market_purchase', relatedId: intent.intent_key,
            idempotencyKey: `inventory:market:purchase:${intent.id}`, createdBy: buyerId,
            metadata: { listing_key: listing.listing_key, seller_id: listing.seller_id },
        });
        const soldQuantity = Number(listing.sold_quantity) + Number(intent.quantity);
        const soldOut = soldQuantity >= Number(listing.quantity);
        await db.run(
            `UPDATE clover_market_listings
             SET sold_quantity = ?, status = ?, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END,
                 updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [soldQuantity, soldOut ? 'sold' : 'active', soldOut ? 1 : 0, listing.id]
        );
        await db.run(
            `UPDATE clover_market_purchase_intents
             SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [intent.id]
        );
        if (soldOut) await releaseOtherPendingPurchasesInTransaction(db, listing.id, intent.id);
        const updated = await db.get('SELECT * FROM clover_market_purchase_intents WHERE id = ?', [intent.id]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, intent: updated, listing: serializeListing(await getListingRow(db, listing.listing_key)), fee, sellerNet, transfer };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelMarketPurchase(db, buyerId, intentKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const row = await db.get('SELECT * FROM clover_market_purchase_intents WHERE intent_key = ? AND buyer_id = ?', [String(intentKey || '').trim(), buyerId]);
        if (!row) throw new MarketServiceError('market_purchase_not_found', 'Compra do mercado não encontrada.');
        if (row.status !== 'pending') throw new MarketServiceError('market_purchase_not_pending', 'Essa compra não está pendente.');
        await releaseYullsReservationInTransaction(db, row.yulls_reservation_id, { metadata: { reason: 'market_purchase_cancelled' } });
        await db.run("UPDATE clover_market_purchase_intents SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        await db.exec('COMMIT');
        return { ok: true, intent: await db.get('SELECT * FROM clover_market_purchase_intents WHERE id = ?', [row.id]) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function placeAuctionBid(db, bidderId, listingKey, amount, options = {}) {
    await ensureMarketV1(db);
    const value = positiveInteger(amount, 'Lance');
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new MarketServiceError('missing_idempotency_key', 'A operação precisa de uma chave única.');
    await ensurePlayer(db, bidderId);
    const now = new Date(options.now || Date.now());
    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get('SELECT * FROM clover_market_bids WHERE idempotency_key = ?', [idempotencyKey]);
        if (duplicate) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, bid: duplicate, listing: serializeListing(await getListingRow(db, String(duplicate.listing_id))) };
        }
        const listing = await getListingRow(db, listingKey);
        if (listing.listing_type !== 'auction' || listing.status !== 'active' || new Date(`${listing.ends_at}Z`) <= now) {
            throw new MarketServiceError('auction_not_active', 'Esse leilão não está ativo.');
        }
        if (listing.seller_id === bidderId) throw new MarketServiceError('own_listing', 'Você não pode dar lance no próprio leilão.');
        const current = await db.get(
            `SELECT * FROM clover_market_bids WHERE listing_id = ? AND status = 'current'
             ORDER BY amount DESC, id DESC LIMIT 1`,
            [listing.id]
        );
        const minimum = current
            ? Number(current.amount) + Math.max(Math.floor(Number(current.amount) * 5 / 100), 100)
            : Number(listing.starting_bid);
        if (value < minimum) throw new MarketServiceError('bid_too_low', `O lance mínimo é ${minimum}¥.`, { minimum });
        if (current?.bidder_id === bidderId) {
            await releaseYullsReservationInTransaction(db, current.yulls_reservation_id, { metadata: { reason: 'bid_increased' } });
        }
        const reservation = await reserveYullsInTransaction(db, bidderId, value, {
            reservationKey: `auction-bid:${listing.listing_key}:${generateKey('R')}`,
            sourceType: 'auction_bid', sourceId: listing.listing_key, createdBy: bidderId,
            expiresAt: addHours(new Date(`${listing.ends_at}Z`), 1),
        });
        if (current) {
            if (current.bidder_id !== bidderId) {
                await releaseYullsReservationInTransaction(db, current.yulls_reservation_id, { metadata: { reason: 'outbid' } });
            }
            await db.run("UPDATE clover_market_bids SET status = 'outbid', released_at = CURRENT_TIMESTAMP WHERE id = ?", [current.id]);
        }
        const bidKey = generateKey('LAN');
        const inserted = await db.run(
            `INSERT INTO clover_market_bids
             (bid_key, listing_id, bidder_id, amount, status, yulls_reservation_id, idempotency_key, metadata_json)
             VALUES (?, ?, ?, ?, 'current', ?, ?, ?)`,
            [bidKey, listing.id, bidderId, value, reservation.id, idempotencyKey, JSON.stringify({ via: options.via || 'site' })]
        );
        const secondsLeft = (new Date(`${listing.ends_at}Z`).getTime() - now.getTime()) / 1000;
        let extended = false;
        if (secondsLeft <= 300 && Number(listing.extension_minutes || 0) < 30) {
            const addMinutes = Math.min(5, 30 - Number(listing.extension_minutes || 0));
            const nextEnd = addSeconds(new Date(`${listing.ends_at}Z`), addMinutes * 60);
            await db.run(
                `UPDATE clover_market_listings
                 SET ends_at = ?, extension_minutes = extension_minutes + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [sqliteDate(nextEnd), addMinutes, listing.id]
            );
            extended = true;
        }
        const bid = await db.get('SELECT * FROM clover_market_bids WHERE id = ?', [inserted.lastID]);
        const updatedListing = await getListingRow(db, listing.listing_key);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, bid, minimumNext: value + Math.max(Math.floor(value * 5 / 100), 100), extended, listing: serializeListing(updatedListing) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function finalizeAuction(db, listingId, options = {}) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const listing = await getListingRow(db, String(listingId));
        if (listing.listing_type !== 'auction' || listing.status !== 'active') {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, listing: serializeListing(listing) };
        }
        if (!options.force && new Date(`${listing.ends_at}Z`) > new Date(options.now || Date.now())) {
            throw new MarketServiceError('auction_not_ended', 'O leilão ainda não terminou.');
        }
        const bid = await db.get(
            `SELECT * FROM clover_market_bids WHERE listing_id = ? AND status = 'current'
             ORDER BY amount DESC, id DESC LIMIT 1`,
            [listing.id]
        );
        if (!bid) {
            await releaseInventoryReservationInTransaction(db, listing.inventory_reservation_id, { metadata: { reason: 'auction_without_bids' } });
            await db.run("UPDATE clover_market_listings SET status = 'ended_no_bids', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [listing.id]);
            await db.exec('COMMIT');
            return { ok: true, sold: false, listing: serializeListing(await getListingRow(db, listing.listing_key)) };
        }
        await spendYullsInTransaction(db, bid.bidder_id, Number(bid.amount), 'arremate_leilao', `Leilão ${listing.listing_key}`, bid.bidder_id, {
            reservationId: bid.yulls_reservation_id,
            relatedId: listing.listing_key,
            idempotencyKey: `yulls:auction:purchase:${listing.id}`,
            metadata: { seller_id: listing.seller_id },
        });
        const fee = saleFee(bid.amount);
        const sellerNet = Number(bid.amount) - fee;
        await addYullsInTransaction(db, listing.seller_id, sellerNet, 'venda_leilao', `Leilão ${listing.listing_key}`, bid.bidder_id, {
            relatedId: listing.listing_key,
            idempotencyKey: `yulls:auction:sale:${listing.id}`,
            metadata: { winner_id: bid.bidder_id, gross: Number(bid.amount), fee },
        });
        const transfer = await transferReservedInventoryItemInTransaction(db, listing.inventory_reservation_id, bid.bidder_id, {
            quantity: Number(listing.quantity), source: 'auction_purchase', relatedId: listing.listing_key,
            idempotencyKey: `inventory:auction:${listing.id}`, createdBy: bid.bidder_id,
            metadata: { seller_id: listing.seller_id, bid: Number(bid.amount) },
        });
        await db.run("UPDATE clover_market_bids SET status = 'won' WHERE id = ?", [bid.id]);
        await db.run(
            `UPDATE clover_market_listings
             SET status = 'sold', sold_quantity = quantity, winner_id = ?, winning_bid = ?,
                 completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [bid.bidder_id, Number(bid.amount), listing.id]
        );
        await db.exec('COMMIT');
        return { ok: true, sold: true, fee, sellerNet, transfer, listing: serializeListing(await getListingRow(db, listing.listing_key)) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelMarketListing(db, sellerId, listingKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const listing = await getListingRow(db, listingKey);
        if (listing.seller_id !== sellerId) throw new MarketServiceError('listing_owner_required', 'Apenas o vendedor pode cancelar o anúncio.');
        if (listing.status !== 'active') throw new MarketServiceError('listing_not_active', 'Esse anúncio não está ativo.');
        if (listing.listing_type === 'auction' && listing.current_bid !== null) {
            throw new MarketServiceError('auction_has_bid', 'Leilão com lance não pode ser cancelado.');
        }
        await releaseOtherPendingPurchasesInTransaction(db, listing.id);
        await releaseInventoryReservationInTransaction(db, listing.inventory_reservation_id, { metadata: { reason: 'listing_cancelled' } });
        await db.run("UPDATE clover_market_listings SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [listing.id]);
        await db.exec('COMMIT');
        return { ok: true, publicationFeeRefunded: 0, listing: serializeListing(await getListingRow(db, listing.listing_key)) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function normalizeTradeItems(value) {
    if (!Array.isArray(value)) return [];
    const map = new Map();
    for (const entry of value.slice(0, 20)) {
        const itemId = positiveInteger(entry.inventoryItemId || entry.inventory_item_id || entry.itemId || entry.id, 'Item');
        const quantity = positiveInteger(entry.quantity || entry.quantidade || 1, 'Quantidade', 50);
        map.set(itemId, (map.get(itemId) || 0) + quantity);
    }
    return [...map.entries()].map(([inventoryItemId, quantity]) => ({ inventoryItemId, quantity }));
}

async function validateTradeSide(db, playerId, items, yulls) {
    await ensurePlayer(db, playerId);
    for (const spec of items) {
        const row = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [spec.inventoryItemId, playerId]);
        if (!row) throw new MarketServiceError('trade_item_not_found', 'Um item da troca não pertence ao jogador.', spec);
        if (row.bound || !row.transferable || row.equipped_slot || !['disponivel', 'quebrado'].includes(row.status)) {
            throw new MarketServiceError('trade_item_unavailable', `${row.item_name} não pode entrar na troca.`);
        }
        if (safeJsonParse(row.metadata_json, {}).template_flags?.marketable === false) {
            throw new MarketServiceError('trade_item_unavailable', `${row.item_name} não foi liberado para negociação.`);
        }
        const reserved = await db.get(
            `SELECT COALESCE(SUM(quantity), 0) AS total FROM clover_inventory_reservations
             WHERE inventory_item_id = ? AND status = 'active'`,
            [row.id]
        );
        if (Number(row.quantity) - Number(reserved?.total || 0) < Number(spec.quantity)) {
            throw new MarketServiceError('trade_item_quantity_unavailable', `Quantidade indisponível de ${row.item_name}.`);
        }
    }
    if (yulls > 0) {
        const wallet = await db.get(
            `SELECT COALESCE(player.dinheiro, 0) AS balance,
                    COALESCE((SELECT SUM(reservation.amount) FROM clover_yulls_reservations reservation
                              WHERE reservation.player_id = player.id AND reservation.status = 'active'
                                AND (reservation.expires_at IS NULL OR datetime(reservation.expires_at) > CURRENT_TIMESTAMP)), 0) AS reserved
             FROM jogadores player WHERE player.id = ?`,
            [playerId]
        );
        if (!wallet || Number(wallet.balance) - Number(wallet.reserved) < yulls) {
            throw new MarketServiceError('insufficient_available_yulls', 'Saldo disponível insuficiente para a troca.');
        }
    }
}

async function releaseTradeReservationsInTransaction(db, reservations, reason) {
    const data = reservations && typeof reservations === 'object' ? reservations : {};
    if (data.yullsReservationId) {
        await releaseYullsReservationInTransaction(db, data.yullsReservationId, { metadata: { reason } });
    }
    for (const entry of Array.isArray(data.items) ? data.items : []) {
        await releaseInventoryReservationInTransaction(db, entry.reservationId, { metadata: { reason } });
    }
}

async function reserveTradeSideInTransaction(db, trade, side) {
    const isCreator = side === 'creator';
    const playerId = isCreator ? trade.creator_id : trade.target_id;
    const items = safeJsonParse(isCreator ? trade.creator_items_json : trade.target_items_json, []);
    const yulls = Number(isCreator ? trade.creator_yulls : trade.target_yulls);
    const reservations = { yullsReservationId: null, items: [] };
    if (yulls > 0) {
        const row = await reserveYullsInTransaction(db, playerId, yulls, {
            reservationKey: `trade:${trade.trade_key}:r${trade.revision}:${side}:yulls`,
            sourceType: 'secure_trade', sourceId: trade.trade_key, createdBy: playerId,
            expiresAt: new Date(`${trade.expires_at}Z`),
        });
        reservations.yullsReservationId = row.id;
    }
    for (const spec of items) {
        const row = await reserveInventoryItemInTransaction(db, playerId, spec.inventoryItemId, spec.quantity, {
            reservationKey: `trade:${trade.trade_key}:r${trade.revision}:${side}:item:${spec.inventoryItemId}`,
            sourceType: 'secure_trade', sourceId: trade.trade_key, createdBy: playerId,
            expiresAt: new Date(`${trade.expires_at}Z`), allowedStatuses: ['disponivel', 'quebrado'],
        });
        reservations.items.push({ reservationId: row.id, inventoryItemId: spec.inventoryItemId, quantity: spec.quantity });
    }
    return reservations;
}

async function createSecureTrade(db, creatorId, targetId, input = {}, options = {}) {
    await ensureMarketV1(db);
    if (creatorId === targetId) throw new MarketServiceError('same_player', 'Você não pode trocar consigo mesmo.');
    const creatorItems = normalizeTradeItems(input.creatorItems || input.creator_items || input.giveItems || []);
    const targetItems = normalizeTradeItems(input.targetItems || input.target_items || input.requestItems || []);
    const creatorYulls = nonNegativeInteger(input.creatorYulls || input.creator_yulls || input.giveYulls, 'Yulls oferecidos');
    const targetYulls = nonNegativeInteger(input.targetYulls || input.target_yulls || input.requestYulls, 'Yulls pedidos');
    if (!creatorItems.length && !targetItems.length && creatorYulls === 0 && targetYulls === 0) {
        throw new MarketServiceError('empty_trade', 'A troca precisa possuir ao menos um item ou valor.');
    }
    await validateTradeSide(db, creatorId, creatorItems, creatorYulls);
    await validateTradeSide(db, targetId, targetItems, targetYulls);
    const key = generateKey('TRO');
    const expiresAt = addHours(options.now || new Date(), TRADE_HOURS);
    const inserted = await db.run(
        `INSERT INTO clover_secure_trades
         (trade_key, creator_id, target_id, creator_items_json, target_items_json,
          creator_yulls, target_yulls, note, status, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
            key, creatorId, targetId, JSON.stringify(creatorItems), JSON.stringify(targetItems),
            creatorYulls, targetYulls, String(input.note || input.motivo || '').trim() || null,
            sqliteDate(expiresAt), JSON.stringify({ via: options.via || 'site' }),
        ]
    );
    return { ok: true, trade: serializeTrade(await db.get('SELECT * FROM clover_secure_trades WHERE id = ?', [inserted.lastID])) };
}

async function getTradeRow(db, tradeKey) {
    const row = await db.get(
        `SELECT * FROM clover_secure_trades WHERE trade_key = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?`,
        [String(tradeKey || '').trim(), String(tradeKey || '').trim()]
    );
    if (!row) throw new MarketServiceError('trade_not_found', 'Troca não encontrada.');
    return row;
}

async function updateTradeSide(db, actorId, tradeKey, input = {}) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const trade = await getTradeRow(db, tradeKey);
        if (![trade.creator_id, trade.target_id].includes(actorId)) throw new MarketServiceError('trade_actor_required', 'Você não participa dessa troca.');
        if (trade.status !== 'pending') throw new MarketServiceError('trade_not_pending', 'Essa troca não está pendente.');
        await releaseTradeReservationsInTransaction(db, safeJsonParse(trade.creator_reservations_json, {}), 'trade_changed');
        await releaseTradeReservationsInTransaction(db, safeJsonParse(trade.target_reservations_json, {}), 'trade_changed');
        const creator = actorId === trade.creator_id;
        const items = normalizeTradeItems(input.items || input.itens || []);
        const yulls = nonNegativeInteger(input.yulls, 'Yulls');
        await validateTradeSide(db, actorId, items, yulls);
        await db.run(
            `UPDATE clover_secure_trades
             SET ${creator ? 'creator_items_json' : 'target_items_json'} = ?,
                 ${creator ? 'creator_yulls' : 'target_yulls'} = ?,
                 creator_reservations_json = '{}', target_reservations_json = '{}',
                 creator_confirmed = 0, target_confirmed = 0, revision = revision + 1,
                 note = COALESCE(?, note), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(items), yulls, input.note === undefined ? null : String(input.note || '').trim(), trade.id]
        );
        const updated = await getTradeRow(db, trade.trade_key);
        await db.exec('COMMIT');
        return { ok: true, confirmationsReset: true, trade: serializeTrade(updated) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function executeTradeInTransaction(db, trade) {
    const creatorReservations = safeJsonParse(trade.creator_reservations_json, {});
    const targetReservations = safeJsonParse(trade.target_reservations_json, {});
    for (const entry of creatorReservations.items || []) {
        await transferReservedInventoryItemInTransaction(db, entry.reservationId, trade.target_id, {
            quantity: entry.quantity, source: 'secure_trade', relatedId: trade.trade_key,
            idempotencyKey: `inventory:trade:${trade.id}:creator:${entry.reservationId}`,
            createdBy: trade.creator_id, metadata: { revision: Number(trade.revision) },
        });
    }
    for (const entry of targetReservations.items || []) {
        await transferReservedInventoryItemInTransaction(db, entry.reservationId, trade.creator_id, {
            quantity: entry.quantity, source: 'secure_trade', relatedId: trade.trade_key,
            idempotencyKey: `inventory:trade:${trade.id}:target:${entry.reservationId}`,
            createdBy: trade.target_id, metadata: { revision: Number(trade.revision) },
        });
    }
    if (Number(trade.creator_yulls) > 0) {
        await spendYullsInTransaction(db, trade.creator_id, Number(trade.creator_yulls), 'troca_segura', `Troca ${trade.trade_key}`, trade.creator_id, {
            reservationId: creatorReservations.yullsReservationId, relatedId: trade.trade_key,
            idempotencyKey: `yulls:trade:${trade.id}:creator:out`, metadata: { target_id: trade.target_id },
        });
        await addYullsInTransaction(db, trade.target_id, Number(trade.creator_yulls), 'troca_segura', `Troca ${trade.trade_key}`, trade.creator_id, {
            relatedId: trade.trade_key, idempotencyKey: `yulls:trade:${trade.id}:creator:in`, metadata: { creator_id: trade.creator_id },
        });
    }
    if (Number(trade.target_yulls) > 0) {
        await spendYullsInTransaction(db, trade.target_id, Number(trade.target_yulls), 'troca_segura', `Troca ${trade.trade_key}`, trade.target_id, {
            reservationId: targetReservations.yullsReservationId, relatedId: trade.trade_key,
            idempotencyKey: `yulls:trade:${trade.id}:target:out`, metadata: { target_id: trade.creator_id },
        });
        await addYullsInTransaction(db, trade.creator_id, Number(trade.target_yulls), 'troca_segura', `Troca ${trade.trade_key}`, trade.target_id, {
            relatedId: trade.trade_key, idempotencyKey: `yulls:trade:${trade.id}:target:in`, metadata: { creator_id: trade.target_id },
        });
    }
    await db.run(
        `UPDATE clover_secure_trades
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [trade.id]
    );
}

async function confirmSecureTrade(db, actorId, tradeKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        let trade = await getTradeRow(db, tradeKey);
        if (![trade.creator_id, trade.target_id].includes(actorId)) throw new MarketServiceError('trade_actor_required', 'Você não participa dessa troca.');
        if (trade.status === 'completed') {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, trade: serializeTrade(trade) };
        }
        if (trade.status !== 'pending' || new Date(`${trade.expires_at}Z`) <= new Date()) {
            throw new MarketServiceError('trade_not_pending', 'Essa troca não está pendente.');
        }
        const side = actorId === trade.creator_id ? 'creator' : 'target';
        const alreadyConfirmed = side === 'creator' ? Boolean(trade.creator_confirmed) : Boolean(trade.target_confirmed);
        if (!alreadyConfirmed) {
            const items = safeJsonParse(side === 'creator' ? trade.creator_items_json : trade.target_items_json, []);
            const yulls = Number(side === 'creator' ? trade.creator_yulls : trade.target_yulls);
            await validateTradeSide(db, actorId, items, yulls);
            const reservations = await reserveTradeSideInTransaction(db, trade, side);
            await db.run(
                `UPDATE clover_secure_trades
                 SET ${side === 'creator' ? 'creator_reservations_json' : 'target_reservations_json'} = ?,
                     ${side === 'creator' ? 'creator_confirmed' : 'target_confirmed'} = 1,
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [JSON.stringify(reservations), trade.id]
            );
        }
        trade = await getTradeRow(db, trade.trade_key);
        let completed = false;
        if (trade.creator_confirmed && trade.target_confirmed) {
            await executeTradeInTransaction(db, trade);
            completed = true;
            trade = await getTradeRow(db, trade.trade_key);
        }
        await db.exec('COMMIT');
        return { ok: true, duplicate: alreadyConfirmed, completed, trade: serializeTrade(trade) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelSecureTrade(db, actorId, tradeKey) {
    await ensureMarketV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const trade = await getTradeRow(db, tradeKey);
        if (![trade.creator_id, trade.target_id].includes(actorId)) throw new MarketServiceError('trade_actor_required', 'Você não participa dessa troca.');
        if (trade.status !== 'pending') throw new MarketServiceError('trade_not_pending', 'Essa troca não está pendente.');
        await releaseTradeReservationsInTransaction(db, safeJsonParse(trade.creator_reservations_json, {}), 'trade_cancelled');
        await releaseTradeReservationsInTransaction(db, safeJsonParse(trade.target_reservations_json, {}), 'trade_cancelled');
        await db.run("UPDATE clover_secure_trades SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [trade.id]);
        await db.exec('COMMIT');
        return { ok: true, trade: serializeTrade(await getTradeRow(db, trade.trade_key)) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listTrades(db, actorId, limit = 30) {
    await ensureMarketV1(db);
    const rows = await db.all(
        `SELECT * FROM clover_secure_trades
         WHERE creator_id = ? OR target_id = ?
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT ?`,
        [actorId, actorId, Math.max(1, Math.min(100, Number(limit) || 30))]
    );
    return rows.map(serializeTrade);
}

function mondayWindow(now = new Date()) {
    const current = new Date(now);
    current.setHours(0, 0, 0, 0);
    const daysSinceMonday = (current.getDay() + 6) % 7;
    current.setDate(current.getDate() - daysSinceMonday);
    const end = new Date(current);
    end.setDate(end.getDate() + 7);
    end.setMilliseconds(end.getMilliseconds() - 1);
    const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    return { key, startsAt: current, endsAt: end };
}

function deterministicWeeklySelection(weekKey, candidates) {
    const digest = crypto.createHash('sha256').update(`clover-weekly-requests:${weekKey}`).digest();
    const pool = [...candidates];
    for (let index = pool.length - 1; index > 0; index -= 1) {
        const swap = digest[index % digest.length] % (index + 1);
        [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    return pool.slice(0, 3);
}

async function ensureWeeklyNpcRequests(db, now = new Date()) {
    await ensureMarketV1(db);
    const window = mondayWindow(now);
    const existing = await db.get('SELECT COUNT(*) AS total FROM clover_weekly_npc_requests WHERE week_key = ?', [window.key]);
    const existingCount = Number(existing?.total || 0);
    if (existingCount >= 3) return { created: 0, weekKey: window.key };
    const candidateRows = await db.all(
        `SELECT template.template_key
         FROM clover_item_templates template
         WHERE template.active = 1
           AND template.requestable = 1
           AND template.duplicable = 1
           AND template.marketable = 1
           AND template.transferable = 1
           AND template.base_price > 0
           AND EXISTS (
               SELECT 1 FROM clover_inventory_items item
               WHERE item.template_key = template.template_key
                 AND item.quantity > 0 AND item.bound = 0 AND item.transferable = 1
           )
           AND NOT EXISTS (
               SELECT 1 FROM clover_weekly_npc_requests request
               WHERE request.week_key = ? AND request.template_key = template.template_key
           )
         ORDER BY template.is_custom DESC, template.updated_at DESC, template.template_key`,
        [window.key]
    );
    const selected = deterministicWeeklySelection(window.key, candidateRows.map((row) => row.template_key))
        .slice(0, Math.max(0, 3 - existingCount));
    const percents = [80, 100, 120];
    const globalQuantities = [12, 10, 8];
    const personalLimits = [4, 3, 2];
    await db.exec('BEGIN IMMEDIATE');
    try {
        let created = 0;
        for (let index = 0; index < selected.length; index += 1) {
            const template = await getItemTemplateInTransaction(db, selected[index]);
            if (!template || Number(template.basePrice || 0) <= 0) continue;
            const slot = existingCount + index;
            const percent = percents[(slot + window.key.length) % percents.length];
            const unitPrice = Math.max(1, Math.floor(Number(template.basePrice) * percent / 100));
            await db.run(
                `INSERT OR IGNORE INTO clover_weekly_npc_requests
                 (request_key, week_key, npc_name, template_key, item_name, description,
                  price_percent, unit_price, global_quantity, personal_limit, status,
                  starts_at, ends_at, created_by, metadata_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 'system', ?)`,
                [
                    `PED-${window.key.replaceAll('-', '')}-${template.key}`,
                    window.key,
                    ['Armazém da Capital', 'Botica da Aliança', 'Comissão de Suprimentos'][slot],
                    template.key,
                    template.itemName,
                    `Pedido semanal por ${template.itemName}.`,
                    percent,
                    unitPrice,
                    globalQuantities[slot],
                    personalLimits[slot],
                    sqliteDate(window.startsAt),
                    sqliteDate(window.endsAt),
                    JSON.stringify({ generated: true, catalog_version: template.catalogVersion }),
                ]
            );
            created += 1;
        }
        await db.exec('COMMIT');
        return { created, weekKey: window.key };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listWeeklyNpcRequests(db, playerId, options = {}) {
    await ensureWeeklyNpcRequests(db, options.now || new Date());
    const window = mondayWindow(options.now || new Date());
    const rows = await db.all(
        `SELECT request.*,
                COALESCE((SELECT SUM(delivery.quantity) FROM clover_weekly_npc_deliveries delivery
                          WHERE delivery.request_id = request.id AND delivery.player_id = ?), 0) AS player_delivered
         FROM clover_weekly_npc_requests request
         WHERE request.week_key = ?
         ORDER BY request.status = 'active' DESC, request.price_percent DESC, request.id`,
        [playerId, window.key]
    );
    return rows.map(serializeWeeklyRequest);
}

async function createWeeklyNpcRequest(db, actorId, input = {}, options = {}) {
    await ensureMarketV1(db);
    const manager = await requireItemManager(db, actorId);
    const now = options.now || new Date();
    const window = mondayWindow(now);
    const templateKey = String(input.templateKey || input.template_key || input.item || '').trim();
    const template = await getItemTemplateInTransaction(db, templateKey);
    if (!template) throw new MarketServiceError('item_template_not_found', 'Modelo de item não encontrado.');
    if (!template.requestable || !template.duplicable || !template.marketable || !template.transferable || template.basePrice <= 0) {
        throw new MarketServiceError('item_not_requestable', 'Esse modelo não está liberado para pedidos de NPC.');
    }
    const percent = positiveInteger(input.pricePercent || input.price_percent || input.percentual || 100, 'Percentual', 120);
    if (percent < 80) throw new MarketServiceError('invalid_request_percent', 'Pedidos pagam entre 80% e 120% do valor de referência.');
    const globalQuantity = positiveInteger(input.globalQuantity || input.global_quantity || input.quantidadeGlobal || 10, 'Quantidade global', 1000);
    const personalLimit = positiveInteger(input.personalLimit || input.personal_limit || input.limite || 2, 'Limite pessoal', globalQuantity);
    const key = `PED-${window.key.replaceAll('-', '')}-${template.key}`;
    try {
        const inserted = await db.run(
            `INSERT INTO clover_weekly_npc_requests
             (request_key, week_key, npc_name, template_key, item_name, description,
              price_percent, unit_price, global_quantity, personal_limit, status,
              starts_at, ends_at, created_by, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
            [
                key, window.key, String(input.npcName || input.npc_name || input.npc || 'Comissão de Suprimentos').trim().slice(0, 100),
                template.key, template.itemName,
                String(input.description || input.descricao || `Pedido semanal por ${template.itemName}.`).trim().slice(0, 500),
                percent, Math.max(1, Math.floor(template.basePrice * percent / 100)),
                globalQuantity, personalLimit, sqliteDate(window.startsAt), sqliteDate(window.endsAt), manager.actorId,
                JSON.stringify({ generated: false, catalog_version: template.catalogVersion }),
            ]
        );
        return { ok: true, request: serializeWeeklyRequest(await db.get('SELECT * FROM clover_weekly_npc_requests WHERE id = ?', [inserted.lastID])) };
    } catch (error) {
        if (String(error?.message || '').includes('UNIQUE')) {
            throw new MarketServiceError('weekly_request_exists', 'Já existe um pedido desse item na semana atual.');
        }
        throw error;
    }
}

async function updateWeeklyNpcRequest(db, actorId, requestKey, input = {}) {
    await ensureMarketV1(db);
    const manager = await requireItemManager(db, actorId);
    const request = await db.get(
        `SELECT * FROM clover_weekly_npc_requests WHERE request_key = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?`,
        [String(requestKey || '').trim(), String(requestKey || '').trim()]
    );
    if (!request) throw new MarketServiceError('weekly_request_not_found', 'Pedido semanal não encontrado.');
    if (request.status !== 'active') throw new MarketServiceError('weekly_request_not_active', 'Apenas pedidos ativos podem ser editados.');
    const percent = input.pricePercent === undefined && input.price_percent === undefined && input.percentual === undefined
        ? Number(request.price_percent)
        : positiveInteger(input.pricePercent || input.price_percent || input.percentual, 'Percentual', 120);
    if (percent < 80) throw new MarketServiceError('invalid_request_percent', 'Pedidos pagam entre 80% e 120% do valor de referência.');
    const globalQuantity = input.globalQuantity === undefined && input.global_quantity === undefined && input.quantidadeGlobal === undefined
        ? Number(request.global_quantity)
        : positiveInteger(input.globalQuantity || input.global_quantity || input.quantidadeGlobal, 'Quantidade global', 1000);
    if (globalQuantity < Number(request.delivered_quantity)) {
        throw new MarketServiceError('request_below_delivered', 'A quantidade global não pode ficar abaixo do que já foi entregue.');
    }
    const personalLimit = input.personalLimit === undefined && input.personal_limit === undefined && input.limite === undefined
        ? Number(request.personal_limit)
        : positiveInteger(input.personalLimit || input.personal_limit || input.limite, 'Limite pessoal', globalQuantity);
    const template = await getItemTemplateInTransaction(db, request.template_key);
    const unitPrice = Math.max(1, Math.floor(Number(template?.basePrice || request.unit_price) * percent / 100));
    await db.run(
        `UPDATE clover_weekly_npc_requests
         SET npc_name = ?, description = ?, price_percent = ?, unit_price = ?, global_quantity = ?,
             personal_limit = ?, status = CASE WHEN delivered_quantity >= ? THEN 'fulfilled' ELSE 'active' END,
             updated_at = CURRENT_TIMESTAMP,
             metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?)
         WHERE id = ?`,
        [
            String(input.npcName || input.npc_name || input.npc || request.npc_name).trim().slice(0, 100),
            String(input.description || input.descricao || request.description || '').trim().slice(0, 500),
            percent, unitPrice, globalQuantity, personalLimit, globalQuantity,
            JSON.stringify({ last_updated_by: manager.actorId }), request.id,
        ]
    );
    return { ok: true, request: serializeWeeklyRequest(await db.get('SELECT * FROM clover_weekly_npc_requests WHERE id = ?', [request.id])) };
}

async function cancelWeeklyNpcRequest(db, actorId, requestKey) {
    await ensureMarketV1(db);
    const manager = await requireItemManager(db, actorId);
    const request = await db.get(
        `SELECT * FROM clover_weekly_npc_requests WHERE request_key = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?`,
        [String(requestKey || '').trim(), String(requestKey || '').trim()]
    );
    if (!request) throw new MarketServiceError('weekly_request_not_found', 'Pedido semanal não encontrado.');
    if (request.status !== 'active') throw new MarketServiceError('weekly_request_not_active', 'Esse pedido não está ativo.');
    await db.run(
        `UPDATE clover_weekly_npc_requests
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP,
             metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?) WHERE id = ?`,
        [JSON.stringify({ cancelled_by: manager.actorId }), request.id]
    );
    return { ok: true, request: serializeWeeklyRequest(await db.get('SELECT * FROM clover_weekly_npc_requests WHERE id = ?', [request.id])) };
}

async function fulfillWeeklyNpcRequest(db, playerId, requestKey, inventoryItemId, quantity = 1, options = {}) {
    await ensureWeeklyNpcRequests(db, options.now || new Date());
    const amount = positiveInteger(quantity, 'Quantidade', 50);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new MarketServiceError('missing_idempotency_key', 'A operação precisa de uma chave única.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get('SELECT * FROM clover_weekly_npc_deliveries WHERE idempotency_key = ?', [idempotencyKey]);
        if (duplicate) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, delivery: duplicate };
        }
        const request = await db.get(
            `SELECT * FROM clover_weekly_npc_requests WHERE request_key = ? OR CAST(id AS TEXT) = ?`,
            [String(requestKey || '').trim(), String(requestKey || '').trim()]
        );
        if (!request || request.status !== 'active' || new Date(`${request.ends_at}Z`) <= new Date(options.now || Date.now())) {
            throw new MarketServiceError('weekly_request_not_active', 'Esse pedido semanal não está ativo.');
        }
        const playerTotal = await db.get(
            'SELECT COALESCE(SUM(quantity), 0) AS total FROM clover_weekly_npc_deliveries WHERE request_id = ? AND player_id = ?',
            [request.id, playerId]
        );
        if (Number(playerTotal?.total || 0) + amount > Number(request.personal_limit)) {
            throw new MarketServiceError('weekly_request_personal_limit', 'Essa entrega ultrapassa seu limite pessoal.');
        }
        if (Number(request.delivered_quantity) + amount > Number(request.global_quantity)) {
            throw new MarketServiceError('weekly_request_global_limit', 'O estoque pedido pelo NPC já foi preenchido.');
        }
        const item = await db.get('SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?', [inventoryItemId, playerId]);
        if (!item || item.template_key !== request.template_key || item.bound || !item.transferable || item.equipped_slot || !['disponivel', 'quebrado'].includes(item.status)) {
            throw new MarketServiceError('weekly_request_item_invalid', 'Esse item não atende ao pedido semanal.');
        }
        const metadata = safeJsonParse(item.metadata_json, {});
        const originalSource = metadata.original_source || item.source;
        const originalAcquiredAt = metadata.original_acquired_at || item.created_at;
        if (originalSource === 'loja_npc' && new Date(`${originalAcquiredAt}Z`) >= new Date(`${request.starts_at}Z`)) {
            throw new MarketServiceError('weekly_request_arbitrage', 'Item comprado em loja do sistema neste ciclo não pode atender ao pedido lucrativo.');
        }
        const reservation = await reserveInventoryItemInTransaction(db, playerId, item.id, amount, {
            reservationKey: `weekly-request:${request.request_key}:${idempotencyKey}`,
            sourceType: 'weekly_npc_request', sourceId: request.request_key, createdBy: playerId,
            allowedStatuses: ['disponivel', 'quebrado'],
        });
        await consumeInventoryItemInTransaction(db, item, amount, {
            reservationId: reservation.id, action: 'entregue_pedido_semanal', source: 'pedido_semanal_npc',
            relatedId: request.request_key, idempotencyKey: `inventory:weekly-request:${idempotencyKey}`,
            createdBy: playerId, metadata: { price_percent: Number(request.price_percent) },
        });
        const total = Number(request.unit_price) * amount;
        await addYullsInTransaction(db, playerId, total, 'pedido_semanal_npc', `Entrega: ${request.item_name}`, playerId, {
            relatedId: request.request_key,
            idempotencyKey: `yulls:weekly-request:${idempotencyKey}`,
            metadata: { quantity: amount, unit_price: Number(request.unit_price) },
        });
        const inserted = await db.run(
            `INSERT INTO clover_weekly_npc_deliveries
             (request_id, player_id, inventory_item_id, quantity, unit_price, total, idempotency_key, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [request.id, playerId, item.id, amount, Number(request.unit_price), total, idempotencyKey, JSON.stringify({ via: options.via || 'site' })]
        );
        const delivered = Number(request.delivered_quantity) + amount;
        await db.run(
            `UPDATE clover_weekly_npc_requests
             SET delivered_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [delivered, delivered >= Number(request.global_quantity) ? 'fulfilled' : 'active', request.id]
        );
        const delivery = await db.get('SELECT * FROM clover_weekly_npc_deliveries WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, delivery, request: serializeWeeklyRequest(await db.get('SELECT * FROM clover_weekly_npc_requests WHERE id = ?', [request.id])) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function processDueMarketOperations(db, options = {}) {
    await ensureMarketV1(db);
    const now = options.now || new Date();
    const result = { paymentsExpired: 0, purchasesExpired: 0, tradesExpired: 0, listingsExpired: 0, auctionsFinalized: 0, weeklyCreated: 0 };
    await db.exec('BEGIN IMMEDIATE');
    try {
        result.paymentsExpired = await expirePaymentIntentsInTransaction(db);
        result.purchasesExpired = await expireMarketPurchasesInTransaction(db);
        const trades = await db.all("SELECT * FROM clover_secure_trades WHERE status = 'pending' AND datetime(expires_at) <= CURRENT_TIMESTAMP");
        for (const trade of trades) {
            await releaseTradeReservationsInTransaction(db, safeJsonParse(trade.creator_reservations_json, {}), 'trade_expired');
            await releaseTradeReservationsInTransaction(db, safeJsonParse(trade.target_reservations_json, {}), 'trade_expired');
            await db.run("UPDATE clover_secure_trades SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [trade.id]);
        }
        result.tradesExpired = trades.length;
        const fixed = await db.all("SELECT * FROM clover_market_listings WHERE listing_type = 'fixed' AND status = 'active' AND datetime(ends_at) <= CURRENT_TIMESTAMP");
        for (const listing of fixed) {
            await releaseOtherPendingPurchasesInTransaction(db, listing.id);
            await releaseInventoryReservationInTransaction(db, listing.inventory_reservation_id, { metadata: { reason: 'listing_expired' } });
            await db.run("UPDATE clover_market_listings SET status = 'expired', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [listing.id]);
        }
        result.listingsExpired = fixed.length;
        await db.run("UPDATE clover_weekly_npc_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'active' AND datetime(ends_at) <= CURRENT_TIMESTAMP");
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    const auctions = await db.all("SELECT id FROM clover_market_listings WHERE listing_type = 'auction' AND status = 'active' AND datetime(ends_at) <= CURRENT_TIMESTAMP");
    for (const auction of auctions) {
        await finalizeAuction(db, auction.id, { force: true, now });
        result.auctionsFinalized += 1;
    }
    const weekly = await ensureWeeklyNpcRequests(db, now);
    result.weeklyCreated = weekly.created;
    return result;
}

async function getMarketDashboard(db, playerId, options = {}) {
    await processDueMarketOperations(db, options);
    const [wallet, listings, trades, weeklyRequests, payments] = await Promise.all([
        getYullsSummary(db, playerId),
        listMarket(db, playerId, { mine: true, limit: 20 }),
        listTrades(db, playerId, 20),
        listWeeklyNpcRequests(db, playerId, options),
        db.all(
            `SELECT * FROM clover_economy_payment_intents
             WHERE sender_id = ? OR recipient_id = ? ORDER BY id DESC LIMIT 20`,
            [playerId, playerId]
        ),
    ]);
    return {
        wallet,
        myListings: listings,
        trades,
        weeklyRequests,
        payments: payments.map(serializePayment),
        rules: {
            publicationFeePercent: PUBLICATION_PERCENT,
            publicationFeeMinimum: PUBLICATION_MINIMUM,
            saleFeePercent: SALE_PERCENT,
            auctionDurationsHours: [...AUCTION_DURATIONS],
            minimumBidIncrease: '5% ou 100¥, o que for maior',
            antiSnipingMinutes: 5,
            maximumExtensionMinutes: 30,
        },
    };
}

module.exports = {
    MarketServiceError,
    cancelMarketListing,
    cancelMarketPurchase,
    cancelPayment,
    cancelSecureTrade,
    cancelWeeklyNpcRequest,
    confirmMarketPurchase,
    confirmPayment,
    confirmSecureTrade,
    createMarketListing,
    createSecureTrade,
    createWeeklyNpcRequest,
    ensureMarketV1,
    ensureWeeklyNpcRequests,
    finalizeAuction,
    fulfillWeeklyNpcRequest,
    getMarketDashboard,
    getTradeRow,
    listMarket,
    listTrades,
    listWeeklyNpcRequests,
    placeAuctionBid,
    previewMarketPurchase,
    previewPayment,
    processDueMarketOperations,
    serializeListing,
    serializeTrade,
    updateTradeSide,
    updateWeeklyNpcRequest,
};
