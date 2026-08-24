'use strict';

const { Readable } = require('stream');
const { __test: base } = require('./siteApiServerBase');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleAdminItemsReadApi } = require('./adminItemsReadApi');
const { handleAdminRewardsReadApi } = require('./adminRewardsReadApi');
const { handleAdminHooksReadApi } = require('./adminHooksReadApi');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleRaidIdempotentHttp } = require('./raidIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleAdminRaidRewardReviewReadHttp } = require('./adminRaidRewardReviewReadHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleDreamWorldsHttp } = require('./dreamWorldsHttp');
const { handleDreamWorldsOperationsHttp } = require('./dreamWorldsOperationsHttp');
const { handlePrShopSupport } = require('./siteApiServerLegacy');
const { addCatalogItem } = require('./inventoryService');
const { createItemTemplate } = require('./itemAdminService');
const { grantPlayerTitle } = require('./titleService');
const { createMarketListing, createSecureTrade, createWeeklyNpcRequest } = require('./marketService');
const { assignAccessRole } = require('./accessControlLegacyService');
const { setAdminRole } = require('./adminAccessService');
const { createRewardPackage } = require('./adminRewardService');
const { createHookTemplate } = require('./adminHookService');
const { createTraitTemplate } = require('./adminTraitService');
const { addPh } = require('./phService');
const { buyNode } = require('./skillTreeService');
const { requestSkillApproval } = require('./skillApprovalService');
const { addYulls } = require('./yullsService');
const { createDreamWorld, submitDreamRequest, approveDreamRequest } = require('./dreamWorldsService');
const { assignDreamSlotWithPolicy } = require('./dreamWorldsSlotPolicyService');
const { transitionDreamRun } = require('./dreamWorldsOperationsService');
const {
    createPreResetSiteApiEvidenceFixture,
    createTestOnlyPreResetPolicy,
    futureCharacterDraft,
    requestPreResetApi,
} = require('./preResetSiteApiEvidenceFixture');

function request(method, url, body, headers = {}) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = { ...headers };
    stream.f7RequestBody = body === undefined ? null : Object.freeze({ ...body });
    return stream;
}
function response() {
    return {
        statusCode: 0, headers: {}, body: '', headersSent: false,
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        writeHead(status, headers = {}) { this.statusCode = status; Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value)); },
        end(value = '') { this.headersSent = true; this.body += String(value || ''); },
    };
}
function result(name, handled, res, error, metadata = {}) {
    const recognized = handled === true || Boolean(error) || res.statusCode >= 400;
    let payload = null;
    try { payload = res.body ? JSON.parse(res.body) : null; } catch { payload = null; }
    return Object.freeze({ name, recognized, outcome: error ? 'MATCHED_DEPENDENCY_FAILURE' : res.statusCode >= 400 ? 'MATCHED_EXPECTED_DENIAL' : 'MATCHED_SUCCESS', status: res.statusCode, payload, error: error ? String(error.code || error.message || 'error') : null, ...metadata });
}
async function invoke(name, handler, req, options, metadata = {}) {
    const res = response();
    const requestCapture = Object.freeze({ method: req.method, url: req.url, body: req.f7RequestBody });
    try { return result(name, await handler(req, res, options), res, null, { ...metadata, request: requestCapture }); }
    catch (error) { return result(name, false, res, error, { ...metadata, request: requestCapture }); }
}

async function capturePreResetSuccess(fixture, name, metadata, method, pathname, token, body, headers) {
    const response = await requestPreResetApi(fixture.port, method, pathname, token, body, headers);
    return Object.freeze({
        name,
        recognized: response.status >= 200 && response.status < 300,
        outcome: response.status >= 200 && response.status < 300 ? 'MATCHED_SUCCESS' : 'MATCHED_EXPECTED_DENIAL',
        status: response.status,
        payload: response.body,
        error: null,
        ...metadata,
        request: Object.freeze({ method, url: pathname, body: body === undefined ? null : Object.freeze({ ...body }) }),
    });
}

async function runPreResetRealSuccessProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        fixture.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true' };
        fixture.options.preResetPolicyRegistry = createTestOnlyPreResetPolicy({ conversion: true, shop: true });
        const alpha = fixture.sessions.alpha;
        const admin = fixture.sessions.admin;
        const base = '/pre-reset';
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const captures = [];
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-read', metadata('prereset.future-character.read', 'future-character-v1', 'future-character-read-shape-v1', 'prereset-future-character-read-v1'), 'GET', `${base}/future-character`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-post', metadata('prereset.future-character.write', 'future-character-v1', 'future-character-write-shape-v1', 'prereset-future-character-write-v1'), 'POST', `${base}/future-character`, alpha, { expectedRevision: 0, draft: futureCharacterDraft() }, { 'Idempotency-Key': 'evidence-future-create-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-put', metadata('prereset.future-character.write', 'future-character-v1', 'future-character-write-shape-v1', 'prereset-future-character-write-v1'), 'PUT', `${base}/future-character`, alpha, { expectedRevision: 1, draft: futureCharacterDraft('Atualizado') }, { 'Idempotency-Key': 'evidence-future-update-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-submit', metadata('prereset.future-character.submit', 'future-character-v1', 'future-character-submit-shape-v1', 'prereset-future-character-submit-v1'), 'POST', `${base}/future-character/submit`, alpha, { expectedRevision: 2, draft: futureCharacterDraft('Atualizado') }, { 'Idempotency-Key': 'evidence-future-submit-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-return-points-balance', metadata('prereset.return-points.balance', 'return-points-balance-v1', 'return-points-balance-v1', 'prereset-return-points-balance-v1'), 'GET', `${base}/return-points/balance`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-conversion-read', metadata('prereset.conversion.read', 'conversion-v1', 'conversion-read-shape-v1', 'prereset-conversion-read-v1'), 'GET', `${base}/conversion`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-conversion-claim', metadata('prereset.conversion.claim', 'conversion-v1', 'conversion-claim-shape-v1', 'prereset-conversion-claim-v1'), 'POST', `${base}/conversion/claim`, alpha, {}, { 'Idempotency-Key': 'evidence-conversion-claim-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-shop-catalog', metadata('prereset.shop.catalog', 'reset-shop-catalog-v1', 'reset-shop-catalog-v1', 'prereset-shop-catalog-v1'), 'GET', `${base}/shop/catalog`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-shop-purchase', metadata('prereset.shop.purchase', 'reset-shop-purchase-v1', 'reset-shop-purchase-v1', 'prereset-shop-purchase-v1'), 'POST', `${base}/shop/purchase`, alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': 'evidence-shop-purchase-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-admin-review', metadata('prereset.admin.review', 'future-character-review-v1', 'future-character-review-shape-v1', 'prereset-admin-review-v1'), 'POST', `${base}/admin/future-characters/${encodeURIComponent(fixture.players.alpha)}/review`, admin, { action: 'approve', reason: 'evidence review', expectedRevision: 3 }, { 'Idempotency-Key': 'evidence-review-approve-0001' }));
        return Object.freeze(captures);
    } finally {
        await fixture.close();
    }
}

async function runBaseSessionProgressionProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const handleRouteAuthed = (playerId) => async (req, res) => base.routeAuthed(
            req,
            res,
            db,
            req.method,
            new URL(req.url, 'http://localhost').pathname.slice(1).split('/').filter(Boolean),
            { player: { id: playerId } },
            req.url
        );
        const authHeaders = { authorization: `Bearer ${sessions.alpha}` };
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0KAAAAABJRU5ErkJggg==';
        const profileImage = await invoke('site-character-profile-image', handleRouteAuthed(players.alpha), request('PUT', '/character/profile-image', { image }, authHeaders), {}, metadata('site.routeAuthed.put.character.profile-image', 'site-character-profile-image-v1', 'site-character-profile-image-v1', 'site-character-profile-image-update-v1'));
        await addPh(db, players.alpha, 1000, 'f7_evidence', 'Hexagon evidence budget', players.alpha);
        const hexagono = await invoke('site-hexagono-upgrade', handleRouteAuthed(players.alpha), request('POST', '/hexagono', { side: 'controle', confirm: false }, authHeaders), {}, metadata('site.routeAuthed.post.hexagono', 'site-hexagono-v1', 'site-hexagono-v1', 'site-hexagon-upgrade-v1'));
        const hexagon = await invoke('site-hexagon-upgrade', handleRouteAuthed(players.alpha), request('POST', '/hexagon', { side: 'alcance', confirm: false }, authHeaders), {}, metadata('site.routeAuthed.post.hexagon', 'site-hexagon-v1', 'site-hexagon-v1', 'site-hexagon-upgrade-v1'));
        const attributes = await invoke('site-attributes-update', handleRouteAuthed(players.alpha), request('PUT', '/attributes', { forca: 1, velocidade: 1, agilidade: 1, resistencia: 1, poder_magico: 1 }, authHeaders), {}, metadata('site.routeAuthed.put.attributes', 'site-attributes-v1', 'site-attributes-v1', 'site-attributes-update-v1'));
        const logout = await invoke('site-auth-logout', handleRouteAuthed(players.alpha), request('POST', '/auth/logout', undefined, authHeaders), {}, metadata('site.routeAuthed.post.auth.logout', 'site-auth-logout-v1', 'site-auth-logout-v1', 'site-auth-logout-v1'));
        return Object.freeze([profileImage, hexagono, hexagon, attributes, logout]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyPaymentProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const options = { getDb: () => fixture.db };
        const headers = (key) => ({ authorization: `Bearer ${fixture.sessions.alpha}`, 'idempotency-key': key });
        const handleBase = async (req, res, options) => { await base.handleRequest(req, res, options); return true; };
        const preview = await invoke('economy-payment-preview', handleBase, request('POST', '/economy/payments/preview', { recipientId: fixture.players.beta, amount: 10, reason: 'evidence payment' }, headers('evidence-payment-preview-0001')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.preview', contractId: 'site-economy-payments-preview-v1', contractShapeId: 'site-economy-payments-preview-shape-v1', semanticFamily: 'economy-payment-intent-v1' });
        const confirm = await invoke('economy-payment-confirm', handleBase, request('POST', `/economy/payments/${encodeURIComponent(preview.payload.payment.key)}/confirm`, undefined, headers('evidence-payment-confirm-0001')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.key.confirm', contractId: 'site-economy-payments-key-confirm-v1', contractShapeId: 'site-economy-payments-confirm-shape-v1', semanticFamily: 'economy-payment-confirm-v1' });
        const cancellable = await invoke('economy-payment-cancel-preview', handleBase, request('POST', '/economy/payments/preview', { recipientId: fixture.players.beta, amount: 11, reason: 'evidence cancellation' }, headers('evidence-payment-preview-0002')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.preview', contractId: 'site-economy-payments-preview-v1', contractShapeId: 'site-economy-payments-preview-shape-v1', semanticFamily: 'economy-payment-intent-v1' });
        const cancel = await invoke('economy-payment-cancel', handleBase, request('POST', `/economy/payments/${encodeURIComponent(cancellable.payload.payment.key)}/cancel`, undefined, headers('evidence-payment-cancel-0001')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.key.cancel', contractId: 'site-economy-payments-key-cancel-v1', contractShapeId: 'site-economy-payments-cancel-shape-v1', semanticFamily: 'economy-payment-cancel-v1' });
        return Object.freeze([preview, confirm, cancellable, cancel]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyMarketProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await db.run('UPDATE jogadores SET dinheiro = 1000 WHERE id IN (?, ?)', [players.alpha, players.beta]);
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key) => ({ authorization: `Bearer ${token}`, 'idempotency-key': key });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const sellerItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'f7_market_evidence' })).items[0];
        const quote = await invoke('economy-market-listing-preview', handleBase, request('POST', '/economy/market/listings/preview', { inventoryItemId: sellerItem.id, unitPrice: 100, title: 'Evidência de anúncio' }, headers(sessions.alpha, 'evidence-market-quote-0001')), options, metadata('site.routeAuthed.post.economy.market.listings.preview', 'site-economy-market-listings-preview-v1', 'site-economy-market-listings-preview-shape-v1', 'economy-market-listing-quote-v1'));
        const listing = await invoke('economy-market-listing-create', handleBase, request('POST', '/economy/market/listings', { inventoryItemId: sellerItem.id, unitPrice: 100, title: 'Evidência de anúncio' }, headers(sessions.alpha, 'evidence-market-listing-0001')), options, metadata('site.routeAuthed.post.economy.market.listings', 'site-economy-market-listings-v1', 'site-economy-market-listings-create-shape-v1', 'economy-market-listing-create-v1'));
        const purchasePreview = await invoke('economy-market-purchase-preview', handleBase, request('POST', '/economy/market/purchases/preview', { listingKey: listing.payload.listing.key }, headers(sessions.beta, 'evidence-market-purchase-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-v1', 'site-economy-market-purchases-preview-shape-v1', 'economy-market-purchase-intent-v1'));
        const confirm = await invoke('economy-market-purchase-confirm', handleBase, request('POST', `/economy/market/purchases/${encodeURIComponent(purchasePreview.payload.intent.intent_key)}/confirm`, undefined, headers(sessions.beta, 'evidence-market-confirm-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.key.confirm', 'site-economy-market-purchases-key-confirm-v1', 'site-economy-market-purchases-confirm-shape-v1', 'economy-market-purchase-confirm-v1'));

        const cancellableItem = (await addCatalogItem(db, players.alpha, 'pocao_antidoto', 1, { source: 'f7_market_evidence' })).items[0];
        const cancellableListing = await createMarketListing(db, players.alpha, { inventoryItemId: cancellableItem.id, unitPrice: 80 }, { via: 'f7_market_evidence', idempotencyKey: 'evidence-market-listing-cancel-setup' });
        const listingCancel = await invoke('economy-market-listing-cancel', handleBase, request('POST', `/economy/market/listings/${encodeURIComponent(cancellableListing.listing.key)}/cancel`, undefined, headers(sessions.alpha, 'evidence-market-listing-cancel-0001')), options, metadata('site.routeAuthed.post.economy.market.listings.key.cancel', 'site-economy-market-listings-key-cancel-v1', 'site-economy-market-listings-cancel-shape-v1', 'economy-market-listing-cancel-v1'));

        const pendingItem = (await addCatalogItem(db, players.alpha, 'adaga', 1, { source: 'f7_market_evidence' })).items[0];
        const pendingListing = await createMarketListing(db, players.alpha, { inventoryItemId: pendingItem.id, unitPrice: 90 }, { via: 'f7_market_evidence', idempotencyKey: 'evidence-market-purchase-cancel-setup' });
        const cancellablePurchase = await invoke('economy-market-purchase-cancel-preview', handleBase, request('POST', '/economy/market/purchases/preview', { listingKey: pendingListing.listing.key }, headers(sessions.beta, 'evidence-market-purchase-cancel-preview-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-v1', 'site-economy-market-purchases-preview-shape-v1', 'economy-market-purchase-intent-v1'));
        const purchaseCancel = await invoke('economy-market-purchase-cancel', handleBase, request('POST', `/economy/market/purchases/${encodeURIComponent(cancellablePurchase.payload.intent.intent_key)}/cancel`, undefined, headers(sessions.beta, 'evidence-market-purchase-cancel-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.key.cancel', 'site-economy-market-purchases-key-cancel-v1', 'site-economy-market-purchases-cancel-shape-v1', 'economy-market-purchase-cancel-v1'));

        const auctionItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'f7_market_evidence' })).items[0];
        const auction = await createMarketListing(db, players.alpha, { type: 'auction', inventoryItemId: auctionItem.id, startingBid: 100, durationHours: 24 }, { via: 'f7_market_evidence', idempotencyKey: 'evidence-market-auction-setup' });
        const bid = await invoke('economy-market-auction-bid', handleBase, request('POST', `/economy/market/auctions/${encodeURIComponent(auction.listing.key)}/bids`, { amount: 100 }, headers(sessions.beta, 'evidence-market-auction-bid-0001')), options, metadata('site.routeAuthed.post.economy.market.auctions.key.bids', 'site-economy-market-auctions-key-bids-v1', 'site-economy-market-auctions-bid-shape-v1', 'economy-market-auction-bid-v1'));
        return Object.freeze([quote, listing, purchasePreview, confirm, listingCancel, cancellablePurchase, purchaseCancel, bid]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyTradeProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await db.run('UPDATE jogadores SET dinheiro = 1000 WHERE id IN (?, ?)', [players.alpha, players.beta]);
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token) => ({ authorization: `Bearer ${token}` });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const creatorItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'f7_trade_evidence' })).items[0];
        const targetItem = (await addCatalogItem(db, players.beta, 'pocao_antidoto', 1, { source: 'f7_trade_evidence' })).items[0];
        const created = await invoke('economy-trade-create', handleBase, request('POST', '/economy/trades', { targetId: players.beta, creatorItems: [{ inventoryItemId: creatorItem.id, quantity: 1 }] }, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.trades', 'site-economy-trades-v1', 'site-economy-trades-create-shape-v1', 'economy-secure-trade-create-v1'));
        const tradeKey = created.payload.trade.key;
        const updated = await invoke('economy-trade-update', handleBase, request('PATCH', `/economy/trades/${encodeURIComponent(tradeKey)}`, { items: [{ inventoryItemId: targetItem.id, quantity: 1 }], yulls: 0 }, headers(sessions.beta)), options, metadata('site.routeAuthed.patch.economy.trades.key', 'site-economy-trades-key-v1', 'site-economy-trades-update-shape-v1', 'economy-secure-trade-update-v1'));
        const firstConfirmation = await invoke('economy-trade-confirm-first', handleBase, request('POST', `/economy/trades/${encodeURIComponent(tradeKey)}/confirm`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.trades.key.confirm', 'site-economy-trades-key-confirm-v1', 'site-economy-trades-confirm-shape-v1', 'economy-secure-trade-confirm-v1'));
        const finalConfirmation = await invoke('economy-trade-confirm-final', handleBase, request('POST', `/economy/trades/${encodeURIComponent(tradeKey)}/confirm`, undefined, headers(sessions.beta)), options, metadata('site.routeAuthed.post.economy.trades.key.confirm', 'site-economy-trades-key-confirm-v1', 'site-economy-trades-confirm-shape-v1', 'economy-secure-trade-confirm-v1'));
        const cancelTrade = await createSecureTrade(db, players.alpha, players.beta, { creatorYulls: 1 }, { via: 'f7_trade_evidence' });
        const cancelled = await invoke('economy-trade-cancel', handleBase, request('POST', `/economy/trades/${encodeURIComponent(cancelTrade.trade.key)}/cancel`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.trades.key.cancel', 'site-economy-trades-key-cancel-v1', 'site-economy-trades-cancel-shape-v1', 'economy-secure-trade-cancel-v1'));
        return Object.freeze([created, updated, firstConfirmation, finalConfirmation, cancelled]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyWeeklyRequestProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_weekly_evidence' });
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key = null) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const deliveryItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'raid' })).items[0];
        const created = await invoke('economy-weekly-request-create', handleBase, request('POST', '/economy/weekly-requests', { templateKey: 'kit_campo', pricePercent: 100, globalQuantity: 4, personalLimit: 2, requiredCondition: 'qualquer' }, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.weekly-requests', 'site-economy-weekly-requests-v1', 'site-economy-weekly-requests-create-shape-v1', 'economy-weekly-request-create-v1'));
        const requestKey = created.payload.request.key;
        const updated = await invoke('economy-weekly-request-update', handleBase, request('PATCH', `/economy/weekly-requests/${encodeURIComponent(requestKey)}`, { pricePercent: 110 }, headers(sessions.admin)), options, metadata('site.routeAuthed.patch.economy.weekly-requests.key', 'site-economy-weekly-requests-key-v1', 'site-economy-weekly-requests-update-shape-v1', 'economy-weekly-request-update-v1'));
        const delivered = await invoke('economy-weekly-request-deliver', handleBase, request('POST', `/economy/weekly-requests/${encodeURIComponent(requestKey)}/deliver`, { inventoryItemId: deliveryItem.id }, headers(sessions.alpha, 'evidence-weekly-delivery-0001')), options, metadata('site.routeAuthed.post.economy.weekly-requests.key.deliver', 'site-economy-weekly-requests-key-deliver-v1', 'site-economy-weekly-requests-deliver-shape-v1', 'economy-weekly-request-deliver-v1'));
        const cancellable = await createWeeklyNpcRequest(db, players.admin, { templateKey: 'pocao_antidoto', pricePercent: 100, globalQuantity: 4, personalLimit: 2, requiredCondition: 'qualquer' }, { via: 'f7_weekly_evidence' });
        const cancelled = await invoke('economy-weekly-request-cancel', handleBase, request('POST', `/economy/weekly-requests/${encodeURIComponent(cancellable.request.key)}/cancel`, undefined, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.weekly-requests.key.cancel', 'site-economy-weekly-requests-key-cancel-v1', 'site-economy-weekly-requests-cancel-shape-v1', 'economy-weekly-request-cancel-v1'));
        return Object.freeze([created, updated, delivered, cancelled]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyItemTemplateProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_item_template_evidence' });
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key = null) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const draft = { templateKey: 'f7_evidence_kit', itemName: 'Kit de Evidencia F7', description: 'Modelo descartavel exclusivo do banco de prova.', basePrice: 50, defaultQuality: 'comum', stackable: true, transferable: true, marketable: true, duplicable: true, requestable: false };
        const created = await invoke('economy-item-template-create', handleBase, request('POST', '/economy/item-templates', draft, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.item-templates', 'site-economy-item-templates-v1', 'site-economy-item-templates-create-shape-v1', 'economy-item-template-create-v1'));
        const templateKey = created.payload.template.key;
        const updated = await invoke('economy-item-template-update', handleBase, request('PATCH', `/economy/item-templates/${encodeURIComponent(templateKey)}`, { basePrice: 60 }, headers(sessions.admin)), options, metadata('site.routeAuthed.patch.economy.item-templates.key', 'site-economy-item-templates-key-v1', 'site-economy-item-templates-update-shape-v1', 'economy-item-template-update-v1'));
        const granted = await invoke('economy-item-template-grant', handleBase, request('POST', `/economy/item-templates/${encodeURIComponent(templateKey)}/grant`, { playerId: players.alpha, quantity: 2 }, headers(sessions.admin, 'evidence-item-template-grant-0001')), options, metadata('site.routeAuthed.post.economy.item-templates.key.grant', 'site-economy-item-templates-key-grant-v1', 'site-economy-item-templates-grant-shape-v1', 'economy-item-template-grant-v1'));
        const archived = await invoke('economy-item-template-archive', handleBase, request('POST', `/economy/item-templates/${encodeURIComponent(templateKey)}/archive`, undefined, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.item-templates.key.archive', 'site-economy-item-templates-key-archive-v1', 'site-economy-item-templates-archive-shape-v1', 'economy-item-template-archive-v1'));
        return Object.freeze([created, updated, granted, archived]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyRedemptionProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_redemption_evidence' });
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key = null) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const redemptionTemplate = await createItemTemplate(db, players.admin, { templateKey: 'f7_redemption_coupon', itemName: 'Cupom de Resgate F7', description: 'Modelo descartavel para validar a fila de resgates.', category: 'consumivel', kind: 'cupom_pa', basePrice: 25, stackable: true, transferable: true, marketable: true, duplicable: true, requestable: true });
        const approvedItem = (await addCatalogItem(db, players.alpha, redemptionTemplate.template.key, 1, { source: 'f7_redemption_evidence', forceSeparate: true })).items[0];
        const approvedRequest = await invoke('economy-redemption-create-approved', handleBase, request('POST', '/economy/redemptions', { inventoryItemId: approvedItem.id, note: 'Solicitacao de aprovacao F7.' }, headers(sessions.alpha, 'evidence-redemption-approved-0001')), options, metadata('site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-v1', 'site-economy-redemptions-create-shape-v1', 'economy-redemption-create-v1'));
        const approved = await invoke('economy-redemption-approve', handleBase, request('POST', `/economy/redemptions/${encodeURIComponent(approvedRequest.payload.redemption.key)}/approve`, { note: 'Aprovado pela prova F7.' }, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.redemptions.key.approve', 'site-economy-redemptions-key-approve-v1', 'site-economy-redemptions-resolve-shape-v1', 'economy-redemption-approve-v1'));
        const rejectedItem = (await addCatalogItem(db, players.alpha, redemptionTemplate.template.key, 1, { source: 'f7_redemption_evidence', forceSeparate: true })).items[0];
        const rejectedRequest = await invoke('economy-redemption-create-rejected', handleBase, request('POST', '/economy/redemptions', { inventoryItemId: rejectedItem.id, note: 'Solicitacao de rejeicao F7.' }, headers(sessions.alpha, 'evidence-redemption-rejected-0001')), options, metadata('site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-v1', 'site-economy-redemptions-create-shape-v1', 'economy-redemption-create-v1'));
        const rejected = await invoke('economy-redemption-reject', handleBase, request('POST', `/economy/redemptions/${encodeURIComponent(rejectedRequest.payload.redemption.key)}/reject`, { note: 'Rejeitado pela prova F7.' }, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.redemptions.key.reject', 'site-economy-redemptions-key-reject-v1', 'site-economy-redemptions-resolve-shape-v1', 'economy-redemption-reject-v1'));
        const cancelledItem = (await addCatalogItem(db, players.alpha, redemptionTemplate.template.key, 1, { source: 'f7_redemption_evidence', forceSeparate: true })).items[0];
        const cancelledRequest = await invoke('economy-redemption-create-cancelled', handleBase, request('POST', '/economy/redemptions', { inventoryItemId: cancelledItem.id, note: 'Solicitacao de cancelamento F7.' }, headers(sessions.alpha, 'evidence-redemption-cancelled-0001')), options, metadata('site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-v1', 'site-economy-redemptions-create-shape-v1', 'economy-redemption-create-v1'));
        const cancelled = await invoke('economy-redemption-cancel', handleBase, request('POST', `/economy/redemptions/${encodeURIComponent(cancelledRequest.payload.redemption.key)}/cancel`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.redemptions.key.cancel', 'site-economy-redemptions-key-cancel-v1', 'site-economy-redemptions-cancel-shape-v1', 'economy-redemption-cancel-v1'));
        return Object.freeze([approvedRequest, approved, rejectedRequest, rejected, cancelledRequest, cancelled]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyTitleAndInitialPackageProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token) => ({ authorization: `Bearer ${token}` });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const grantedTitle = await grantPlayerTitle(db, players.alpha, { key: 'f7_evidence_title', name: 'Titulo de Evidencia F7' }, { source: 'f7_economy_fixture' });
        const activated = await invoke('economy-title-activate', handleBase, request('POST', `/economy/titles/${encodeURIComponent(grantedTitle.title.key)}/activate`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.titles.key.activate', 'site-economy-titles-key-activate-v1', 'site-economy-titles-activate-shape-v1', 'economy-title-activate-v1'));
        const deactivated = await invoke('economy-title-deactivate', handleBase, request('POST', '/economy/titles/deactivate', undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.titles.deactivate', 'site-economy-titles-deactivate-v1', 'site-economy-titles-deactivate-shape-v1', 'economy-title-deactivate-v1'));
        const initialPackage = await invoke('economy-initial-package', handleBase, request('POST', '/economy/initial-package', { equipmentTemplateKey: 'espada_curta' }, headers(sessions.beta)), options, metadata('site.routeAuthed.post.economy.initial-package', 'site-economy-initial-package-v1', 'site-economy-initial-package-shape-v1', 'economy-initial-package-v1'));
        return Object.freeze([activated, deactivated, initialPackage]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyOperationsProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await db.run('UPDATE jogadores SET dinheiro = 100000 WHERE id = ?', [players.alpha]);
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (key) => ({ authorization: `Bearer ${sessions.alpha}`, 'idempotency-key': key });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const purchasePreview = await invoke('economy-purchase-preview-confirm', handleBase, request('POST', '/economy/purchases/preview', { listingKey: 'pocao_antidoto', quantity: 1 }, headers('evidence-purchase-preview-confirm-0001')), options, metadata('site.routeAuthed.post.economy.purchases.preview', 'site-economy-purchases-preview-v1', 'site-economy-purchases-preview-shape-v1', 'economy-purchase-preview-v1'));
        const purchaseConfirm = await invoke('economy-purchase-confirm', handleBase, request('POST', `/economy/purchases/${encodeURIComponent(purchasePreview.payload.purchase.key)}/confirm`, undefined, headers('evidence-purchase-confirm-0001')), options, metadata('site.routeAuthed.post.economy.purchases.key.confirm', 'site-economy-purchases-key-confirm-v1', 'site-economy-purchases-confirm-shape-v1', 'economy-purchase-confirm-v1'));
        const cancellablePurchase = await invoke('economy-purchase-preview-cancel', handleBase, request('POST', '/economy/purchases/preview', { listingKey: 'kit_campo', quantity: 1 }, headers('evidence-purchase-preview-cancel-0001')), options, metadata('site.routeAuthed.post.economy.purchases.preview', 'site-economy-purchases-preview-v1', 'site-economy-purchases-preview-shape-v1', 'economy-purchase-preview-v1'));
        const purchaseCancel = await invoke('economy-purchase-cancel', handleBase, request('POST', `/economy/purchases/${encodeURIComponent(cancellablePurchase.payload.purchase.key)}/cancel`, undefined, headers('evidence-purchase-cancel-0001')), options, metadata('site.routeAuthed.post.economy.purchases.key.cancel', 'site-economy-purchases-key-cancel-v1', 'site-economy-purchases-cancel-shape-v1', 'economy-purchase-cancel-v1'));
        const saleItem = (await addCatalogItem(db, players.alpha, 'espada_curta', 1, { source: 'f7_economy_operation_evidence', forceSeparate: true })).items[0];
        const salePreview = await invoke('economy-sale-preview', handleBase, request('POST', '/economy/sales/preview', { inventoryItemId: saleItem.id, quantity: 1 }, headers('evidence-sale-preview-0001')), options, metadata('site.routeAuthed.post.economy.sales.preview', 'site-economy-sales-preview-v1', 'site-economy-sales-preview-shape-v1', 'economy-sale-preview-v1'));
        const saleConfirm = await invoke('economy-sale-confirm', handleBase, request('POST', `/economy/sales/${encodeURIComponent(salePreview.payload.sale.key)}/confirm`, undefined, headers('evidence-sale-confirm-0001')), options, metadata('site.routeAuthed.post.economy.sales.key.confirm', 'site-economy-sales-key-confirm-v1', 'site-economy-sales-confirm-shape-v1', 'economy-sale-confirm-v1'));
        const repairItem = (await addCatalogItem(db, players.alpha, 'espada_curta', 1, { source: 'f7_economy_operation_evidence', forceSeparate: true })).items[0];
        await db.run('UPDATE clover_inventory_items SET durability_current = 2 WHERE id = ?', [repairItem.id]);
        const repairPreview = await invoke('economy-repair-preview', handleBase, request('POST', '/economy/repairs/preview', { inventoryItemId: repairItem.id }, headers('evidence-repair-preview-0001')), options, metadata('site.routeAuthed.post.economy.repairs.preview', 'site-economy-repairs-preview-v1', 'site-economy-repairs-preview-shape-v1', 'economy-repair-preview-v1'));
        const repairConfirm = await invoke('economy-repair-confirm', handleBase, request('POST', `/economy/repairs/${encodeURIComponent(repairPreview.payload.repair.key)}/confirm`, undefined, headers('evidence-repair-confirm-0001')), options, metadata('site.routeAuthed.post.economy.repairs.key.confirm', 'site-economy-repairs-key-confirm-v1', 'site-economy-repairs-confirm-shape-v1', 'economy-repair-confirm-v1'));
        const consumableItem = (await addCatalogItem(db, players.alpha, 'pocao_antidoto', 1, { source: 'f7_economy_operation_evidence', forceSeparate: true })).items[0];
        const consumableUse = await invoke('economy-consumable-use', handleBase, request('POST', `/economy/consumables/${encodeURIComponent(consumableItem.id)}/use`, { contextType: 'livre' }, headers('evidence-consumable-use-0001')), options, metadata('site.routeAuthed.post.economy.consumables.itemId.use', 'site-economy-consumables-itemId-use-v1', 'site-economy-consumables-use-shape-v1', 'economy-consumable-use-v1'));
        return Object.freeze([purchasePreview, purchaseConfirm, cancellablePurchase, purchaseCancel, salePreview, saleConfirm, repairPreview, repairConfirm, consumableUse]);
    } finally {
        await fixture.close();
    }
}

async function runAdminReadProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        // The canonical grant is part of the fixture.  The legacy admission is
        // established through the real Admin service so the handler exercises
        // canonical-parity authentication rather than an injected resolver.
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const search = await invoke('admin-player-search', handleAdminApiSupport, request('GET', '/admin/players/search?q=alpha', undefined, headers), options, metadata('admin.players.search', 'admin-player-search-v1', 'admin-player-search-shape-v1', 'admin-player-search-read-v1'));
        const detail = await invoke('admin-player-detail', handleAdminApiSupport, request('GET', `/admin/players/${encodeURIComponent(players.alpha)}`, undefined, headers), options, metadata('admin.player.detail', 'admin-player-detail-v1', 'admin-player-detail-shape-v1', 'admin-player-detail-read-v1'));
        const integrity = await invoke('admin-integrity-summary', handleAdminApiSupport, request('GET', '/admin/integrity/summary?sampleLimit=2', undefined, headers), options, metadata('admin.integrity.summary', 'admin-integrity-summary-v1', 'admin-integrity-summary-shape-v1', 'admin-integrity-summary-read-v1'));
        return Object.freeze([search, detail, integrity]);
    } finally {
        await fixture.close();
    }
}

async function runAdminCatalogReadProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        // Item-template setup deliberately calls the real manager, which also
        // requires the legacy catalog-manager grant in this historical path.
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_admin_catalog_read_evidence' });
        const item = await createItemTemplate(db, players.admin, {
            templateKey: 'f7_admin_read_item', itemName: 'Item de Leitura F7', description: 'Modelo descartável para a captura do catálogo administrativo.',
            category: 'consumivel', kind: 'cura', basePrice: 10, stackable: true, transferable: true, marketable: true, duplicable: true, requestable: false,
        });
        const rewardPackage = await createRewardPackage(db, {
            name: 'Pacote de Leitura F7', description: 'Pacote descartável para a captura administrativa.', canonicalKey: 'f7_admin_catalog_reward', entries: [{ type: 'yulls', amount: 5 }],
        }, { actorId: players.admin });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const items = await invoke('admin-items-list', handleAdminItemsReadApi, request('GET', '/admin/items', undefined, headers), options, metadata('admin.items.list', 'admin-item-list-v1', 'admin-item-list-shape-v1', 'admin-item-catalog-list-v1'));
        const itemDetail = await invoke('admin-item-detail', handleAdminItemsReadApi, request('GET', `/admin/items/${encodeURIComponent(item.template.key)}`, undefined, headers), options, metadata('admin.items.detail', 'admin-item-v1', 'admin-item-shape-v1', 'admin-item-catalog-detail-v1'));
        const rewards = await invoke('admin-rewards-list', handleAdminRewardsReadApi, request('GET', '/admin/rewards', undefined, headers), options, metadata('admin.rewards.list', 'admin-reward-list-v1', 'admin-reward-list-shape-v1', 'admin-reward-package-list-v1'));
        const grants = await invoke('admin-reward-grants-list', handleAdminRewardsReadApi, request('GET', '/admin/rewards/grants', undefined, headers), options, metadata('admin.rewards.grants', 'admin-reward-grant-list-v1', 'admin-reward-grant-list-shape-v1', 'admin-reward-grant-list-v1'));
        const rewardDetail = await invoke('admin-reward-detail', handleAdminRewardsReadApi, request('GET', `/admin/rewards/${encodeURIComponent(rewardPackage.id)}`, undefined, headers), options, metadata('admin.rewards.detail', 'admin-reward-v1', 'admin-reward-shape-v1', 'admin-reward-package-detail-v1'));
        return Object.freeze([items, itemDetail, rewards, grants, rewardDetail]);
    } finally {
        await fixture.close();
    }
}

async function runAdminHooksReadProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const hook = await createHookTemplate(db, {
            name: 'Hook de Leitura F7', description: 'Gancho descartável para capturar o contrato administrativo.', objectiveText: 'Registrar a leitura.', completionText: 'Leitura registrada.', canonicalKey: 'f7_admin_read_hook',
        }, { actorId: players.admin });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const list = await invoke('admin-hooks-list', handleAdminHooksReadApi, request('GET', '/admin/hooks', undefined, headers), options, metadata('admin.hooks.list', 'admin-hooks-v2', 'admin-hooks-list-shape-v2', 'admin-hook-template-list-v2'));
        const schema = await invoke('admin-hooks-schema', handleAdminHooksReadApi, request('GET', '/admin/hooks/schema', undefined, headers), options, metadata('admin.hooks.schema', 'admin-hooks-v2', 'admin-hooks-schema-shape-v2', 'admin-hook-v2-schema-v2'));
        const assignments = await invoke('admin-hook-assignments-list', handleAdminHooksReadApi, request('GET', '/admin/hooks/assignments', undefined, headers), options, metadata('admin.hooks.assignments', 'admin-hooks-v2', 'admin-hook-assignments-list-shape-v2', 'admin-hook-assignment-list-v2'));
        const detail = await invoke('admin-hook-detail', handleAdminHooksReadApi, request('GET', `/admin/hooks/${encodeURIComponent(hook.id)}`, undefined, headers), options, metadata('admin.hooks.detail', 'admin-hooks-v2', 'admin-hook-detail-shape-v2', 'admin-hook-template-detail-v2'));
        return Object.freeze([list, schema, assignments, detail]);
    } finally {
        await fixture.close();
    }
}

async function runAdminCommandCenterProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractShapeId, semanticFamily) => ({ descriptorId, contractId: 'admin-command-center-v1', contractShapeId, semanticFamily });
        const inbox = await invoke('admin-command-center-inbox', handleAdminApiSupport, request('GET', '/admin/inbox?limit=2', undefined, headers), options, metadata('admin.command-center.inbox', 'admin-command-center-inbox-shape-v1', 'admin-command-center-inbox-read-v1'));
        const history = await invoke('admin-command-center-history', handleAdminApiSupport, request('GET', '/admin/history?limit=2', undefined, headers), options, metadata('admin.command-center.history', 'admin-command-center-history-shape-v1', 'admin-command-center-history-read-v1'));
        return Object.freeze([inbox, history]);
    } finally {
        await fixture.close();
    }
}

async function runCanonicalAdminTeamProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const ownerAccess = async (_db, actorId) => Object.freeze({
            ok: true,
            actor: Object.freeze({ id: actorId, role: 'owner', capabilities: Object.freeze([]) }),
        });
        const options = {
            getDb: () => db,
            accessResolver: ownerAccess,
            ownerCheck: (id) => id === players.admin,
        };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractShapeId, semanticFamily) => ({ descriptorId, contractId: 'canonical-admin-team-v1', contractShapeId, semanticFamily });
        const read = await invoke('canonical-admin-team-read', handleAdminApiSupport, request('GET', '/admin/team?changes=2', undefined, headers), options, metadata('admin.canonical-team.read', 'canonical-admin-team-read-shape-v1', 'canonical-admin-team-read-v1'));
        const changeCreate = await invoke('canonical-admin-team-change-create', handleAdminApiSupport, request('POST', '/admin/team/changes', { targetId: players.beta, action: 'set', role: 'narrator', reason: 'EvidÃªncia descartÃ¡vel F7.' }, headers), options, metadata('admin.canonical-team.change.create', 'canonical-admin-team-change-create-shape-v1', 'canonical-admin-team-change-create-v1'));
        const appliedCode = changeCreate.payload.change.code;
        const changeRead = await invoke('canonical-admin-team-change-read', handleAdminApiSupport, request('GET', `/admin/team/changes/${encodeURIComponent(appliedCode)}`, undefined, headers), options, metadata('admin.canonical-team.change.read', 'canonical-admin-team-change-read-shape-v1', 'canonical-admin-team-change-read-v1'));
        const apply = await invoke('canonical-admin-team-change-apply', handleAdminApiSupport, request('POST', `/admin/team/changes/${encodeURIComponent(appliedCode)}/apply`, undefined, headers), options, metadata('admin.canonical-team.change.apply', 'canonical-admin-team-change-apply-shape-v1', 'canonical-admin-team-change-apply-v1'));
        const undo = await invoke('canonical-admin-team-change-undo', handleAdminApiSupport, request('POST', `/admin/team/changes/${encodeURIComponent(appliedCode)}/undo`, { reason: 'Desfazer evidÃªncia descartÃ¡vel F7.' }, headers), options, metadata('admin.canonical-team.change.undo', 'canonical-admin-team-change-undo-shape-v1', 'canonical-admin-team-change-undo-v1'));
        const cancelCreate = await invoke('canonical-admin-team-change-create-for-cancel', handleAdminApiSupport, request('POST', '/admin/team/changes', { targetId: players.beta, action: 'set', role: 'assistant', reason: 'Cancelar evidÃªncia descartÃ¡vel F7.' }, headers), options);
        const cancelCode = cancelCreate.payload.change.code;
        const cancel = await invoke('canonical-admin-team-change-cancel', handleAdminApiSupport, request('POST', `/admin/team/changes/${encodeURIComponent(cancelCode)}/cancel`, undefined, headers), options, metadata('admin.canonical-team.change.cancel', 'canonical-admin-team-change-cancel-shape-v1', 'canonical-admin-team-change-cancel-v1'));
        return Object.freeze([read, changeCreate, changeRead, apply, undo, cancel]);
    } finally {
        await fixture.close();
    }
}

async function runAdminOperationAndTraitProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        // Admission uses the canonical-to-legacy parity service; every
        // operation below then reaches the normal production handler and its
        // Operation Kernel against this disposable SQLite database.
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const trait = await createTraitTemplate(db, {
            id: 'TR-F7A0B1C2', name: 'Traço de Operação F7', slotKey: 'aptidao_comum',
            description: 'Template descartável para evidência de operação administrativa.',
        }, { actorId: players.admin });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}`, 'idempotency-key': 'f7-admin-operation-evidence-0001' };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const traits = await invoke('admin-traits-list', handleAdminApiSupport, request('GET', '/admin/traits?q=Operação', undefined, headers), options, metadata('admin.traits.collection', 'admin-traits-v1', 'admin-traits-list-shape-v1', 'admin-trait-catalog-list-v1'));
        const traitDetail = await invoke('admin-trait-detail', handleAdminApiSupport, request('GET', `/admin/traits/${encodeURIComponent(trait.id)}`, undefined, headers), options, metadata('admin.trait.detail', 'admin-trait-v1', 'admin-trait-detail-shape-v1', 'admin-trait-catalog-detail-v1'));
        const created = await invoke('admin-operation-create', handleAdminApiSupport, request('POST', '/admin/operations', {
            title: 'Atribuir traço descartável F7',
            reason: 'Evidência isolada de contrato administrativo.',
            targets: [{ kind: 'player', playerId: players.alpha }],
            actions: [{ type: 'player.trait.assign', payload: { traitId: trait.id } }],
        }, headers), options, metadata('admin.operations.collection', 'admin-operations-v1', 'admin-operations-collection-shape-v1', 'admin-operations-collection-v1'));
        const code = created.payload.operation.code;
        // The collection read is deliberately executed too.  The public
        // descriptor has GET and POST; the semantic capture is POST because
        // it carries the descriptor's authoritative request contract.
        const list = await invoke('admin-operations-list', handleAdminApiSupport, request('GET', '/admin/operations?q=descartável', undefined, headers), options, metadata('admin.operations.collection', 'admin-operations-v1', 'admin-operations-collection-shape-v1', 'admin-operations-collection-v1'));
        const simulated = await invoke('admin-operation-simulate', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/simulate`, undefined, headers), options, metadata('admin.operation.simulate', 'admin-operation-v1', 'admin-operation-simulate-shape-v1', 'admin-operation-simulate-v1'));
        const approved = await invoke('admin-operation-approve', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/approve`, undefined, headers), options, metadata('admin.operation.approve', 'admin-operation-v1', 'admin-operation-approve-shape-v1', 'admin-operation-approve-v1'));
        const applied = await invoke('admin-operation-apply', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/apply`, undefined, headers), options, metadata('admin.operation.apply', 'admin-operation-v1', 'admin-operation-apply-shape-v1', 'admin-operation-apply-v1'));
        const detail = await invoke('admin-operation-detail', handleAdminApiSupport, request('GET', `/admin/operations/${encodeURIComponent(code)}`, undefined, headers), options, metadata('admin.operation.detail', 'admin-operation-v1', 'admin-operation-detail-shape-v1', 'admin-operation-detail-v1'));
        // retry on an already applied operation is an idempotent real-service
        // success, exercising the recovery handler and its semantic owner
        // without injecting an operation or executor stub.
        const recovery = await invoke('admin-operation-recovery-retry', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/retry`, undefined, headers), options, metadata('admin.operation.recovery', 'admin-operation-recovery-v1', 'admin-operation-recovery-retry-shape-v1', 'admin-operation-recovery-retry-v1'));
        const undone = await invoke('admin-operation-undo', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/undo`, { reason: 'Desfazer evidência descartável F7.' }, headers), options, metadata('admin.operation.undo', 'admin-operation-v1', 'admin-operation-undo-shape-v1', 'admin-operation-undo-v1'));
        return Object.freeze([traits, traitDetail, created, list, simulated, approved, applied, detail, recovery, undone]);
    } finally {
        await fixture.close();
    }
}

async function runAdminSkillApprovalAndRaidReviewProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        // The role grant and every domain operation below use the production
        // services, but only against the fixture's disposable SQLite file.
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        await addPh(db, players.alpha, 200, 'fixture', 'PH extra para aprovações F7', 'fixture');
        const prerequisite = await buyNode(db, players.alpha, 'suporte', 'suporte', players.alpha, { source: 'f7_admin_skill_evidence' });
        if (!prerequisite.ok) throw new Error(`skill_approval_prerequisite_failed:${prerequisite.reason || 'unknown'}`);
        const approvalRequest = await requestSkillApproval(db, players.alpha, 'suporte', 'magigramatica', players.alpha);
        const rejectionRequest = await requestSkillApproval(db, players.alpha, 'suporte', 'praga', players.alpha);
        if (!approvalRequest.created || !rejectionRequest.created) throw new Error('skill_approval_fixture_request_not_created');
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}`, 'idempotency-key': 'f7-admin-skill-approval-evidence-0001' };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const list = await invoke('admin-skill-approvals-list', handleSkillApprovalHttp, request('GET', '/admin/skill-approvals?status=pending&limit=10', undefined, headers), options, metadata('admin.skill-approvals.list', 'skill-approval-list-v1', 'admin-skill-approval-list-shape-v1', 'admin-skill-approval-list-v1'));
        const approved = await invoke('admin-skill-approval-approve', handleSkillApprovalHttp, request('POST', `/admin/skill-approvals/${encodeURIComponent(approvalRequest.request.request_key)}/approve`, { reason: 'Aprovação descartável F7.' }, headers), options, metadata('admin.skill-approvals.approve', 'skill-approval-v1', 'admin-skill-approval-approve-shape-v1', 'admin-skill-approval-approve-v1'));
        const rejected = await invoke('admin-skill-approval-reject', handleSkillApprovalHttp, request('POST', `/admin/skill-approvals/${encodeURIComponent(rejectionRequest.request.request_key)}/reject`, { reason: 'Rejeição descartável F7.' }, headers), options, metadata('admin.skill-approvals.reject', 'skill-approval-v1', 'admin-skill-approval-reject-shape-v1', 'admin-skill-approval-reject-v1'));
        const raidReviewList = await invoke('admin-raid-reward-proposals-list', handleAdminRaidRewardReviewReadHttp, request('GET', '/admin/raid-reward-proposals?status=pending', undefined, headers), options, metadata('admin.raid-reward-proposals.list', 'admin-raid-reward-proposal-list-v1', 'admin-raid-reward-proposal-list-shape-v1', 'admin-raid-reward-proposal-list-v1'));
        return Object.freeze([list, approved, rejected, raidReviewList]);
    } finally {
        await fixture.close();
    }
}

async function runAdminDreamWorldCatalogAndFragmentProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, { actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin' }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const meta = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const worldBody = { name: 'Fenda de Evidência F7', universe: 'Arquivo descartável', synopsis: 'Fenda criada somente na SQLite descartável.', dreamType: 'self', rank: 'A', status: 'announced', yullsPrice: 3000, manualPaymentEnabled: true, manualPriceLabel: 'R$ 30,00', minPlayers: 2, maxPlayers: 4, slots: { squad: 1, invited: 1, public: 2 } };
        const created = await invoke('admin-dream-world-create', handleDreamWorldsHttp, request('POST', '/admin/dream-worlds', worldBody, headers), options, meta('admin.dream-worlds.create', 'admin-dream-world-v1', 'admin-dream-world-create-shape-v1', 'admin-dream-world-create-v1'));
        const slug = created.payload.world.slug;
        const list = await invoke('admin-dream-worlds-list', handleDreamWorldsHttp, request('GET', '/admin/dream-worlds?status=announced', undefined, headers), options, meta('admin.dream-worlds.list', 'admin-dream-world-list-v1', 'admin-dream-world-list-shape-v1', 'admin-dream-world-list-v1'));
        const acquisition = await invoke('admin-dream-world-acquisition', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/${encodeURIComponent(slug)}/acquisition`, { yullsPrice: 3200, manualPaymentEnabled: true, manualPriceLabel: 'R$ 32,00', reason: 'Ajuste descartável F7.' }, headers), options, meta('admin.dream-worlds.acquisition.update', 'admin-dream-world-v1', 'admin-dream-world-acquisition-shape-v1', 'admin-dream-world-acquisition-v1'));
        const status = await invoke('admin-dream-world-status', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/${encodeURIComponent(slug)}/status`, { status: 'available' }, headers), options, meta('admin.dream-worlds.status.transition', 'admin-dream-world-v1', 'admin-dream-world-status-shape-v1', 'admin-dream-world-status-v1'));
        const fragmentBody = { name: 'Fragmento F7', category: 'style', publicDescription: 'Fragmento descartável de evidência.', status: 'review', publicVisible: true };
        const fragmentCreated = await invoke('admin-dream-fragment-create', handleDreamWorldsHttp, request('POST', '/admin/dream-worlds/fragments', fragmentBody, headers), options, meta('admin.dream-worlds.fragments.create', 'admin-dream-fragment-v1', 'admin-dream-fragment-create-shape-v1', 'admin-dream-fragment-create-v1'));
        const fragmentSlug = fragmentCreated.payload.fragment.slug;
        const fragmentList = await invoke('admin-dream-fragments-list', handleDreamWorldsHttp, request('GET', '/admin/dream-worlds/fragments?status=review', undefined, headers), options, meta('admin.dream-worlds.fragments.list', 'admin-dream-fragment-list-v1', 'admin-dream-fragment-list-shape-v1', 'admin-dream-fragment-list-v1'));
        const fragmentUpdated = await invoke('admin-dream-fragment-update', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/fragments/${encodeURIComponent(fragmentSlug)}/update`, { status: 'active', reason: 'Revisão descartável F7.' }, headers), options, meta('admin.dream-worlds.fragments.update', 'admin-dream-fragment-v1', 'admin-dream-fragment-update-shape-v1', 'admin-dream-fragment-update-v1'));
        const fragmentGranted = await invoke('admin-dream-fragment-grant', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/fragments/${encodeURIComponent(fragmentSlug)}/grant`, { playerId: players.alpha, status: 'active', reason: 'Concessão descartável F7.' }, headers), options, meta('admin.dream-worlds.fragments.grant', 'admin-dream-fragment-v1', 'admin-dream-fragment-grant-shape-v1', 'admin-dream-fragment-grant-v1'));
        return Object.freeze([created, list, acquisition, status, fragmentCreated, fragmentList, fragmentUpdated, fragmentGranted]);
    } finally { await fixture.close(); }
}

async function runAdminDreamWorldLifecycleProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const replacementPlayer = 'fixture-dream-replacement@lid';
        await setAdminRole(db, { actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin' }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        await db.run(`INSERT INTO jogadores (id, nome, raca, dinheiro, ficha_status, jogo_status)
            VALUES (?, 'replacement', 'Humano ativo', 77, 'aprovada', 'liberado')`, [replacementPlayer]);
        await addYulls(db, players.alpha, 50000, 'fixture', 'Saldo descartável para evidência F7 Dream Worlds.', 'fixture');

        const options = { getDb: () => db };
        const adminHeaders = { authorization: `Bearer ${sessions.admin}` };
        const alphaHeaders = { authorization: `Bearer ${sessions.alpha}` };
        const betaHeaders = { authorization: `Bearer ${sessions.beta}` };
        const meta = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const worldBody = (suffix) => ({
            name: `Fenda Lifecycle F7 ${suffix}`,
            slug: `f7-lifecycle-${suffix}`,
            universe: 'Arquivo descartável de contratos',
            synopsis: 'Fenda criada somente na SQLite descartável para provar o ciclo administrativo.',
            dreamType: 'self', rank: 'A', status: 'available', yullsPrice: 1000,
            manualPaymentEnabled: true, manualPriceLabel: 'R$ 10,00',
            minPlayers: 2, maxPlayers: 4, slots: { squad: 0, invited: 1, public: 3 }, knownChapters: 3,
        });
        const firstOpenPublicSlot = async (runId) => db.get(
            `SELECT id FROM clover_dream_slots WHERE run_id = ? AND category = 'public' AND status = 'open' ORDER BY id LIMIT 1`,
            [Number(runId)]
        );
        const createRun = async (suffix) => {
            const world = await createDreamWorld(db, worldBody(suffix), players.admin);
            const submitted = await submitDreamRequest(db, players.alpha, world.slug, {
                buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: `f7-lifecycle-direct-${suffix}`,
            });
            const approval = await approveDreamRequest(db, submitted.request.id, players.admin, { narratorIds: [players.admin] });
            return { world, run: approval.run };
        };
        const createReadyRun = async (suffix) => {
            const created = await createRun(suffix);
            const slot = await firstOpenPublicSlot(created.run.id);
            await assignDreamSlotWithPolicy(db, created.run.id, slot.id, players.beta, players.admin, { mode: 'confirmed' });
            return created;
        };

        const approvalWorld = await createDreamWorld(db, worldBody('request-approval'), players.admin);
        const submittedRequest = await invoke(
            'admin-dream-request-submit-fixture', handleDreamWorldsHttp,
            request('POST', `/dream-worlds/${encodeURIComponent(approvalWorld.slug)}/requests`, {
                buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: 'f7-lifecycle-http-request-approval', playerNote: 'Solicitação descartável F7.',
            }, { ...alphaHeaders, 'idempotency-key': 'f7-lifecycle-http-request-approval' }), options
        );
        if (submittedRequest.status !== 201) throw new Error(`dream_request_fixture_failed:${submittedRequest.status}`);
        const requests = await invoke('admin-dream-requests-list', handleDreamWorldsHttp, request('GET', '/admin/dream-worlds/requests?status=submitted', undefined, adminHeaders), options, meta('admin.dream-worlds.requests', 'admin-dream-request-list-v1', 'admin-dream-request-list-shape-v1', 'admin-dream-request-list-v1'));
        const approved = await invoke('admin-dream-request-approve', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/requests/${encodeURIComponent(submittedRequest.payload.request.id)}/approve`, { narratorIds: [players.admin], adminNote: 'Aprovação descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.request.approve', 'admin-dream-request-v1', 'admin-dream-request-approve-shape-v1', 'admin-dream-request-approve-v1'));
        if (approved.status !== 200) throw new Error(`dream_request_approval_failed:${approved.status}`);
        const mainRun = approved.payload.run;

        const rejectedWorld = await createDreamWorld(db, worldBody('request-rejection'), players.admin);
        const rejectedRequest = await submitDreamRequest(db, players.alpha, rejectedWorld.slug, { buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: 'f7-lifecycle-direct-request-rejection' });
        const rejected = await invoke('admin-dream-request-reject', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/requests/${encodeURIComponent(rejectedRequest.request.id)}/reject`, { adminNote: 'Recusa descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.request.reject', 'admin-dream-request-v1', 'admin-dream-request-reject-shape-v1', 'admin-dream-request-reject-v1'));

        const submittedApplication = await invoke('admin-dream-application-submit-fixture', handleDreamWorldsHttp, request('POST', `/dream-worlds/${encodeURIComponent(approvalWorld.slug)}/applications`, { idempotencyKey: 'f7-lifecycle-http-application-select', playerNote: 'Candidatura descartável F7.' }, { ...betaHeaders, 'idempotency-key': 'f7-lifecycle-http-application-select' }), options);
        if (submittedApplication.status !== 201) throw new Error(`dream_application_fixture_failed:${submittedApplication.status}`);
        const applications = await invoke('admin-dream-applications-list', handleDreamWorldsHttp, request('GET', `/admin/dream-worlds/applications?run=${encodeURIComponent(mainRun.id)}&status=submitted`, undefined, adminHeaders), options, meta('admin.dream-worlds.applications', 'admin-dream-application-list-v1', 'admin-dream-application-list-shape-v1', 'admin-dream-application-list-v1'));
        const reviewed = await invoke('admin-dream-application-review', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/applications/${encodeURIComponent(submittedApplication.payload.application.id)}/review`, { adminNote: 'Revisão descartável F7.', reason: 'Validação real de fluxo.' }, adminHeaders), options, meta('admin.dream-worlds.application.review', 'admin-dream-application-v1', 'admin-dream-application-review-shape-v1', 'admin-dream-application-review-v1'));
        const selected = await invoke('admin-dream-application-select', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/applications/${encodeURIComponent(submittedApplication.payload.application.id)}/select`, { mode: 'invited', adminNote: 'Seleção descartável F7.', reason: 'Reserva via fluxo real.' }, adminHeaders), options, meta('admin.dream-worlds.application.select', 'admin-dream-application-v1', 'admin-dream-application-select-shape-v1', 'admin-dream-application-select-v1'));

        const applicationRejectFixture = await createRun('application-reject');
        const rejectedApplicationFixture = await invoke('admin-dream-application-reject-fixture', handleDreamWorldsHttp, request('POST', `/dream-worlds/${encodeURIComponent(applicationRejectFixture.world.slug)}/applications`, { idempotencyKey: 'f7-lifecycle-http-application-reject', playerNote: 'Candidatura de recusa F7.' }, { ...betaHeaders, 'idempotency-key': 'f7-lifecycle-http-application-reject' }), options);
        if (rejectedApplicationFixture.status !== 201) throw new Error(`dream_application_reject_fixture_failed:${rejectedApplicationFixture.status}`);
        const applicationRejected = await invoke('admin-dream-application-reject', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/applications/${encodeURIComponent(rejectedApplicationFixture.payload.application.id)}/reject`, { adminNote: 'Recusa descartável F7.', reason: 'Fluxo recusado de modo real.' }, adminHeaders), options, meta('admin.dream-worlds.application.reject', 'admin-dream-application-v1', 'admin-dream-application-reject-shape-v1', 'admin-dream-application-reject-v1'));

        const runs = await invoke('admin-dream-runs-list', handleDreamWorldsOperationsHttp, request('GET', '/admin/dream-worlds/runs?status=forming_group', undefined, adminHeaders), options, meta('admin.dream-worlds.runs.list', 'admin-dream-run-list-v1', 'admin-dream-run-list-shape-v1', 'admin-dream-run-list-v1'));
        const detail = await invoke('admin-dream-run-detail', handleDreamWorldsOperationsHttp, request('GET', `/admin/dream-worlds/runs/${encodeURIComponent(mainRun.id)}`, undefined, adminHeaders), options, meta('admin.dream-worlds.runs.detail', 'admin-dream-run-v1', 'admin-dream-run-detail-shape-v1', 'admin-dream-run-detail-v1'));

        const inviteFixture = await createRun('slot-invite');
        const inviteSlot = await firstOpenPublicSlot(inviteFixture.run.id);
        const invited = await invoke('admin-dream-slot-invite', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(inviteFixture.run.id)}/slots/${encodeURIComponent(inviteSlot.id)}/invite`, { playerId: players.beta }, adminHeaders), options, meta('admin.dream-worlds.slot.invite', 'admin-dream-run-v1', 'admin-dream-slot-invite-shape-v1', 'admin-dream-slot-invite-v1'));

        const confirmFixture = await createRun('slot-confirm');
        const confirmSlot = await firstOpenPublicSlot(confirmFixture.run.id);
        const confirmed = await invoke('admin-dream-slot-confirm', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(confirmFixture.run.id)}/slots/${encodeURIComponent(confirmSlot.id)}/confirm`, { playerId: players.beta }, adminHeaders), options, meta('admin.dream-worlds.slot.confirm', 'admin-dream-run-v1', 'admin-dream-slot-confirm-shape-v1', 'admin-dream-slot-confirm-v1'));

        const removeFixture = await createRun('slot-remove');
        const removeSlot = await firstOpenPublicSlot(removeFixture.run.id);
        await assignDreamSlotWithPolicy(db, removeFixture.run.id, removeSlot.id, players.beta, players.admin, { mode: 'invited' });
        const removed = await invoke('admin-dream-slot-remove', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(removeFixture.run.id)}/slots/${encodeURIComponent(removeSlot.id)}/remove`, { reason: 'Remoção descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.slot.remove', 'admin-dream-run-v1', 'admin-dream-slot-remove-shape-v1', 'admin-dream-slot-remove-v1'));

        const replaceFixture = await createRun('slot-replace');
        const replaceSlot = await firstOpenPublicSlot(replaceFixture.run.id);
        await assignDreamSlotWithPolicy(db, replaceFixture.run.id, replaceSlot.id, players.beta, players.admin, { mode: 'invited' });
        const replaced = await invoke('admin-dream-slot-replace', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(replaceFixture.run.id)}/slots/${encodeURIComponent(replaceSlot.id)}/replace`, { playerId: replacementPlayer, mode: 'confirmed' }, adminHeaders), options, meta('admin.dream-worlds.slot.replace', 'admin-dream-run-v1', 'admin-dream-slot-replace-shape-v1', 'admin-dream-slot-replace-v1'));

        const lifecycleFixture = await createReadyRun('run-lifecycle');
        const started = await invoke('admin-dream-run-start', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/start`, undefined, adminHeaders), options, meta('admin.dream-worlds.run.start', 'admin-dream-run-v1', 'admin-dream-run-start-shape-v1', 'admin-dream-run-start-v1'));
        const advanced = await invoke('admin-dream-run-advance', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/advance`, { chapter: 2 }, adminHeaders), options, meta('admin.dream-worlds.run.advance', 'admin-dream-run-v1', 'admin-dream-run-advance-shape-v1', 'admin-dream-run-advance-v1'));
        const paused = await invoke('admin-dream-run-pause', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/pause`, { reason: 'Pausa descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.pause', 'admin-dream-run-v1', 'admin-dream-run-pause-shape-v1', 'admin-dream-run-pause-v1'));
        const resumed = await invoke('admin-dream-run-resume', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/resume`, { reason: 'Retomada descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.resume', 'admin-dream-run-v1', 'admin-dream-run-resume-shape-v1', 'admin-dream-run-resume-v1'));
        const completed = await invoke('admin-dream-run-complete', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/complete`, { reason: 'Conclusão descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.complete', 'admin-dream-run-v1', 'admin-dream-run-complete-shape-v1', 'admin-dream-run-complete-v1'));

        const failFixture = await createReadyRun('run-fail');
        await transitionDreamRun(db, failFixture.run.id, 'start', players.admin);
        const failed = await invoke('admin-dream-run-fail', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(failFixture.run.id)}/fail`, { reason: 'Falha descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.fail', 'admin-dream-run-v1', 'admin-dream-run-fail-shape-v1', 'admin-dream-run-fail-v1'));
        const cancelFixture = await createRun('run-cancel');
        const cancelled = await invoke('admin-dream-run-cancel', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(cancelFixture.run.id)}/cancel`, { reason: 'Cancelamento descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.cancel', 'admin-dream-run-v1', 'admin-dream-run-cancel-shape-v1', 'admin-dream-run-cancel-v1'));

        return Object.freeze([requests, applications, reviewed, selected, applicationRejected, approved, rejected, runs, detail, invited, confirmed, removed, replaced, started, advanced, paused, resumed, completed, failed, cancelled]);
    } finally { await fixture.close(); }
}

async function runCriticalHandlerBoundaryProbes(overrides = {}) {
    const emitProgress = typeof overrides.onProgress === 'function' ? overrides.onProgress : () => {};
    const progress = (stage, status, details = {}) => {
        try { emitProgress(Object.freeze({ stage, status, ...details })); } catch { /* Observability must not change probe semantics. */ }
    };
    const runGroup = async (stage, action) => {
        progress(stage, 'START');
        const group = await action();
        progress(stage, 'PASS', { captures: Array.isArray(group) ? group.length : 1 });
        return group;
    };
    const missingDb = { getDb: () => null };
    progress('base', 'START');
    const basePublic = await invoke('base-public', (req, res) => base.routePublic(req, res, null, 'GET', ['health'], '/health'), request('GET', '/health'), {});
    const baseSession = await invoke('base-session', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['auth', 'logout'], { player: { id: 'probe' } }, '/auth/logout'), request('POST', '/auth/logout'), {});
    const baseEconomy = await invoke('base-economy', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['economy', 'purchases', 'preview'], { player: { id: 'probe' } }, '/economy/purchases/preview'), request('POST', '/economy/purchases/preview', {}), {});
    const adminAccess = {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'probe-admin', nome: 'Probe Admin' } }),
        accessResolver: async () => ({ ok: true, actor: { id: 'probe-admin', role: 'admin', capabilities: ['operation.view'] } }),
    };
    progress('base', 'PASS', { captures: 3 });
    const preResetProbes = await runGroup('pre-reset', runPreResetRealSuccessProbes);
    const baseSessionProgressionProbes = await runGroup('site-base-session-progression', runBaseSessionProgressionProbes);
    const economyPaymentProbes = await runGroup('economy-payment', runBaseEconomyPaymentProbes);
    const economyMarketProbes = await runGroup('economy-market', runBaseEconomyMarketProbes);
    const economyTradeProbes = await runGroup('economy-trade', runBaseEconomyTradeProbes);
    const economyWeeklyRequestProbes = await runGroup('economy-weekly-request', runBaseEconomyWeeklyRequestProbes);
    const economyItemTemplateProbes = await runGroup('economy-item-template', runBaseEconomyItemTemplateProbes);
    const economyRedemptionProbes = await runGroup('economy-redemption', runBaseEconomyRedemptionProbes);
    const economyTitleAndInitialPackageProbes = await runGroup('economy-title-initial-package', runBaseEconomyTitleAndInitialPackageProbes);
    const economyOperationsProbes = await runGroup('economy-operations', runBaseEconomyOperationsProbes);
    const adminReadProbes = await runGroup('admin-read', runAdminReadProbes);
    const adminCatalogReadProbes = await runGroup('admin-catalog-read', runAdminCatalogReadProbes);
    const adminHooksReadProbes = await runGroup('admin-hooks-read', runAdminHooksReadProbes);
    const adminCommandCenterProbes = await runGroup('admin-command-center', runAdminCommandCenterProbes);
    const canonicalAdminTeamProbes = await runGroup('admin-canonical-team', runCanonicalAdminTeamProbes);
    const adminOperationAndTraitProbes = await runGroup('admin-operation-trait', runAdminOperationAndTraitProbes);
    const adminSkillApprovalAndRaidReviewProbes = await runGroup('admin-skill-approval-raid-review', runAdminSkillApprovalAndRaidReviewProbes);
    const adminDreamWorldCatalogAndFragmentProbes = await runGroup('admin-dream-world-catalog-fragment', runAdminDreamWorldCatalogAndFragmentProbes);
    const adminDreamWorldLifecycleProbes = await runGroup('admin-dream-world-lifecycle', runAdminDreamWorldLifecycleProbes);
    const probes = [
        basePublic, baseSession, baseEconomy,
        await invoke('pre-reset', handlePreResetSiteApi, request('GET', '/pre-reset/future-character'), missingDb),
        await invoke('admin', handleAdminApiSupport, request('GET', '/admin/bootstrap'), missingDb),
        await invoke('admin-bootstrap', handleAdminApiSupport, request('GET', '/admin/bootstrap'), adminAccess, { descriptorId: 'admin.bootstrap', contractId: 'admin-bootstrap-v1', semanticFamily: 'admin-bootstrap-read-v1' }),
        await invoke('admin-policy-catalog', handleAdminApiSupport, request('GET', '/admin/operation-policies'), adminAccess, { descriptorId: 'admin.operation-policies.read', contractId: 'admin-operation-policies-v1', semanticFamily: 'admin-policy-catalog-read-v1' }),
        await invoke('raid-create', handleRaidCoreIdempotentHttp, request('POST', '/raids', { name: 'Probe Raid' }), {
            getDb: () => ({}),
            authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }),
            mutationRunner: async (operation) => operation(),
            createRaid: async () => ({ ok: true, raid: { key: 'probe-raid' } }),
        }, { descriptorId: 'raid.create', contractId: 'raid-create-v1', semanticFamily: 'raid-core-create-v1' }),
        await invoke('raid-condition', handleRaidCoreIdempotentHttp, request('POST', '/raids/probe-raid/conditions', { label: 'Probe Condition' }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(),
            addRaidCondition: async () => ({ ok: true, condition: { id: 1 } }),
        }, { descriptorId: 'raid.condition.add', contractId: 'raid-condition-add-v1', semanticFamily: 'raid-core-condition-add-v1' }),
        await invoke('raid-reward', handleRaidCoreIdempotentHttp, request('POST', '/raids/probe-raid/rewards', { rewardType: 'pa', amount: 1 }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(),
            addRaidReward: async () => ({ ok: true, reward: { id: 1 } }),
        }, { descriptorId: 'raid.reward.add', contractId: 'raid-reward-add-v1', semanticFamily: 'raid-core-reward-add-v1' }),
        await invoke('raid-host-add', handleRaidIdempotentHttp, request('POST', '/raids/probe-raid/hosts', { playerId: 'probe-cohost' }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(),
            addRaidHost: async () => ({ ok: true, host: { player_id: 'probe-cohost' } }),
        }, { descriptorId: 'raid.host.add', contractId: 'raid-host-v1', semanticFamily: 'raid-host-add-v1' }),
        await invoke('raid-host-revoke', handleRaidIdempotentHttp, request('POST', '/raids/probe-raid/hosts/revoke', { playerId: 'probe-cohost' }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(), revokeRaidHost: async () => ({ ok: true }),
        }, { descriptorId: 'raid.host.revoke', contractId: 'raid-host-v1', semanticFamily: 'raid-host-revoke-v1' }),
        await invoke('skill-approval', handleSkillApprovalHttp, request('POST', '/trees/example-tree/purchase', {}), missingDb),
        await invoke('squad', handleSquadMembershipTransferHttp, request('POST', '/squads/a/members/b/transfer', {}), missingDb),
        await invoke('dream-worlds', handleDreamWorldsHttp, request('GET', '/dream-worlds'), missingDb),
        await invoke('recruitment', handlePrShopSupport, request('GET', '/recruitment/shop'), missingDb),
        ...preResetProbes,
        ...baseSessionProgressionProbes,
        ...economyPaymentProbes,
        ...economyMarketProbes,
        ...economyTradeProbes,
        ...economyWeeklyRequestProbes,
        ...economyItemTemplateProbes,
        ...economyRedemptionProbes,
        ...economyTitleAndInitialPackageProbes,
        ...economyOperationsProbes,
        ...adminReadProbes,
        ...adminCatalogReadProbes,
        ...adminHooksReadProbes,
        ...adminCommandCenterProbes,
        ...canonicalAdminTeamProbes,
        ...adminOperationAndTraitProbes,
        ...adminSkillApprovalAndRaidReviewProbes,
        ...adminDreamWorldCatalogAndFragmentProbes,
        ...adminDreamWorldLifecycleProbes,
    ];
    const selected = overrides.disableFamily ? probes.filter((probe) => !probe.name.startsWith(overrides.disableFamily)) : probes;
    progress('complete', 'PASS', { total: probes.length, probed: selected.length });
    return Object.freeze({ total: probes.length, probed: selected.length, failures: selected.filter((probe) => !probe.recognized), captures: selected.filter((probe) => probe.outcome === 'MATCHED_SUCCESS' && probe.payload), probes: selected });
}

module.exports = {
    runCriticalHandlerBoundaryProbes,
    __test: { runAdminOperationAndTraitProbes, runBaseSessionProgressionProbes, runCanonicalAdminTeamProbes, runAdminSkillApprovalAndRaidReviewProbes, runAdminDreamWorldCatalogAndFragmentProbes, runAdminDreamWorldLifecycleProbes },
};
