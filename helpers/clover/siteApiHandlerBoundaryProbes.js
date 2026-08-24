'use strict';

const { Readable } = require('stream');
const { __test: base } = require('./siteApiServerBase');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleRaidIdempotentHttp } = require('./raidIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleDreamWorldsHttp } = require('./dreamWorldsHttp');
const { handlePrShopSupport } = require('./siteApiServerLegacy');
const { addCatalogItem } = require('./inventoryService');
const { createMarketListing, createSecureTrade } = require('./marketService');
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

async function runCriticalHandlerBoundaryProbes(overrides = {}) {
    const missingDb = { getDb: () => null };
    const basePublic = await invoke('base-public', (req, res) => base.routePublic(req, res, null, 'GET', ['health'], '/health'), request('GET', '/health'), {});
    const baseSession = await invoke('base-session', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['auth', 'logout'], { player: { id: 'probe' } }, '/auth/logout'), request('POST', '/auth/logout'), {});
    const baseEconomy = await invoke('base-economy', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['economy', 'purchases', 'preview'], { player: { id: 'probe' } }, '/economy/purchases/preview'), request('POST', '/economy/purchases/preview', {}), {});
    const adminAccess = {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'probe-admin', nome: 'Probe Admin' } }),
        accessResolver: async () => ({ ok: true, actor: { id: 'probe-admin', role: 'admin', capabilities: ['operation.view'] } }),
    };
    const preResetProbes = await runPreResetRealSuccessProbes();
    const economyPaymentProbes = await runBaseEconomyPaymentProbes();
    const economyMarketProbes = await runBaseEconomyMarketProbes();
    const economyTradeProbes = await runBaseEconomyTradeProbes();
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
        ...economyPaymentProbes,
        ...economyMarketProbes,
        ...economyTradeProbes,
    ];
    const selected = overrides.disableFamily ? probes.filter((probe) => !probe.name.startsWith(overrides.disableFamily)) : probes;
    return Object.freeze({ total: probes.length, probed: selected.length, failures: selected.filter((probe) => !probe.recognized), captures: selected.filter((probe) => probe.outcome === 'MATCHED_SUCCESS' && probe.payload), probes: selected });
}

module.exports = { runCriticalHandlerBoundaryProbes };
