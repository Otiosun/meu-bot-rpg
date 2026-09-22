'use strict';

const {
    cancelMarketListingInTransaction,
    getMarketListing,
} = require('./marketService');

class AdminMarketError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminMarketError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function requireListingKey(payload = {}) {
    const value = String(
        payload.listingKey
        ?? payload.listing_key
        ?? payload.key
        ?? payload.id
        ?? ''
    ).trim();
    if (!value) {
        throw new AdminMarketError(
            'missing_listing_key',
            'Informe o anúncio que será moderado.',
            400
        );
    }
    return value;
}

function listingSnapshot(listing) {
    if (!listing) return null;
    return {
        key: listing.key,
        sellerId: listing.sellerId,
        type: listing.type,
        title: listing.title,
        itemName: listing.itemName,
        quantity: Number(listing.quantity || 0),
        soldQuantity: Number(listing.soldQuantity || 0),
        pendingQuantity: Number(listing.pendingQuantity || 0),
        availableQuantity: Number(listing.availableQuantity || 0),
        currentBid: listing.currentBid == null ? null : Number(listing.currentBid),
        currentBidderId: listing.currentBidderId || null,
        status: listing.status,
        endsAt: listing.endsAt || null,
        inventoryItemId: Number(listing.inventoryItemId || 0),
    };
}

function sameListingState(left, right) {
    const a = listingSnapshot(left);
    const b = listingSnapshot(right);
    return JSON.stringify(a) === JSON.stringify(b);
}

function assertModeratable(listing) {
    if (!listing) {
        throw new AdminMarketError(
            'listing_not_found',
            'Anúncio não encontrado.',
            404
        );
    }
    if (listing.status !== 'active') {
        throw new AdminMarketError(
            'listing_not_active',
            'Somente anúncios ativos podem ser cancelados pela moderação.',
            409,
            { status: listing.status }
        );
    }
    if (listing.type === 'auction' && listing.currentBid !== null) {
        throw new AdminMarketError(
            'auction_has_bid',
            'Leilão com lance exige revisão específica da reserva do maior lance.',
            409,
            {
                currentBid: listing.currentBid,
                currentBidderId: listing.currentBidderId || null,
            }
        );
    }
}

function createAdminMarketExecutors() {
    return {
        'market.listing.cancel': {
            async preview({ db, action }) {
                const listingKey = requireListingKey(action.payload || {});
                const listing = await getMarketListing(db, listingKey);
                assertModeratable(listing);
                const before = listingSnapshot(listing);
                return {
                    summary: `Cancelar anúncio ${listing.key} · ${listing.title}`,
                    before,
                    after: {
                        ...before,
                        status: 'cancelled',
                    },
                    metadata: {
                        listingKey: listing.key,
                        sellerId: listing.sellerId,
                        publicationFeeRefunded: 0,
                        undoSafe: false,
                    },
                };
            },

            async apply({ db, operation, action, before }) {
                const listingKey = requireListingKey(action.payload || {});
                const current = await getMarketListing(db, listingKey);
                assertModeratable(current);

                if (!sameListingState(current, before)) {
                    throw new AdminMarketError(
                        'market_listing_changed_after_preview',
                        'O anúncio mudou depois da prévia. Gere uma nova operação.',
                        409,
                        {
                            before,
                            current: listingSnapshot(current),
                        }
                    );
                }

                const result = await cancelMarketListingInTransaction(
                    db,
                    current.sellerId,
                    listingKey,
                    {
                        allowAnySeller: true,
                        reason: operation.reason || 'market_admin_cancel',
                        operationCode: operation.code,
                        actorId: operation.actor.id,
                    }
                );

                return {
                    before,
                    after: listingSnapshot(result.listing),
                    summary: `Anúncio ${listingKey} cancelado pela moderação.`,
                    metadata: {
                        publicationFeeRefunded: 0,
                        undoSafe: false,
                    },
                };
            },
        },
    };
}

module.exports = {
    AdminMarketError,
    assertModeratable,
    createAdminMarketExecutors,
    listingSnapshot,
    requireListingKey,
    sameListingState,
};
