'use strict';

// This deliberately stays smaller than JSON Schema.  The public API only
// needs stable, executable assertions for fields we promise to clients.
const SAFE_ERROR = Object.freeze({ required: ['ok', 'error', 'message'], properties: { ok: 'boolean', error: 'string', message: 'string' } });
const EMPTY_REQUEST = Object.freeze({ required: [], properties: {} });
const SAFE_OK = Object.freeze({ required: ['ok'], properties: { ok: 'boolean' } });

function definition({ request = EMPTY_REQUEST, response = SAFE_OK, tier = 'envelope', broad = false, responseKind = 'RESOURCE', requestMode = request.required?.length ? 'required' : 'unspecified' }) {
    return Object.freeze({ request, response, error: SAFE_ERROR, tier, broad, responseKind, requestMode });
}

const SESSION_RESPONSE = Object.freeze({ required: ['ok', 'token', 'expiresAt', 'player'], properties: { ok: 'boolean', token: 'string', expiresAt: 'string', player: 'object' } });
const HEALTH_RESPONSE = Object.freeze({ required: ['ok', 'status', 'queue'], properties: { ok: 'boolean', status: 'string', queue: 'object' } });
const FUTURE_CHARACTER_RESPONSE = Object.freeze({ required: ['ok', 'character'], properties: { ok: 'boolean', character: 'object|null' } });
const RETURN_POINTS_RESPONSE = Object.freeze({ required: ['ok', 'balance', 'ledger'], properties: { ok: 'boolean', balance: 'number', ledger: 'array' } });
const CONVERSION_RESPONSE = Object.freeze({ required: ['ok', 'conversion'], properties: { ok: 'boolean', conversion: 'object' } });
const SHOP_CATALOG_RESPONSE = Object.freeze({ required: ['ok', 'status', 'items'], properties: { ok: 'boolean', status: 'string', items: 'array' } });
const ENTITLEMENTS_RESPONSE = Object.freeze({ required: ['ok', 'purchases', 'entitlements'], properties: { ok: 'boolean', purchases: 'array', entitlements: 'array' } });
const PRE_RESET_PURCHASE_RESPONSE = Object.freeze({ required: ['ok', 'purchase', 'entitlement', 'balanceAfter'], properties: { ok: 'boolean', purchase: 'object', entitlement: 'object', balanceAfter: 'number' } });
const PAYMENT_RESPONSE = Object.freeze({ required: ['ok', 'payment'], properties: { ok: 'boolean', payment: 'object' } });
const MARKET_LISTING_RESPONSE = Object.freeze({ required: ['ok', 'listing', 'publicationFee'], properties: { ok: 'boolean', listing: 'object', publicationFee: 'number' } });
// `safeJsonStringify` removes repeated object references, so the public wire
// response contains the canonical `quote` field (the in-memory alias
// `cotacao` intentionally serializes away).
const MARKET_LISTING_QUOTE_RESPONSE = Object.freeze({ required: ['ok', 'quote'], properties: { ok: 'boolean', quote: 'object' } });
const MARKET_LISTING_CANCEL_RESPONSE = Object.freeze({ required: ['ok', 'publicationFeeRefunded', 'listing'], properties: { ok: 'boolean', publicationFeeRefunded: 'number', listing: 'object' } });
const MARKET_PURCHASE_PREVIEW_RESPONSE = Object.freeze({ required: ['ok', 'intent', 'listing'], properties: { ok: 'boolean', intent: 'object', listing: 'object' } });
const MARKET_PURCHASE_CONFIRM_RESPONSE = Object.freeze({ required: ['ok', 'intent', 'listing', 'fee', 'sellerNet', 'transfer'], properties: { ok: 'boolean', intent: 'object', listing: 'object', fee: 'number', sellerNet: 'number', transfer: 'object' } });
const MARKET_PURCHASE_CANCEL_RESPONSE = Object.freeze({ required: ['ok', 'intent'], properties: { ok: 'boolean', intent: 'object' } });
const MARKET_AUCTION_BID_RESPONSE = Object.freeze({ required: ['ok', 'bid', 'minimumNext', 'extended', 'listing'], properties: { ok: 'boolean', bid: 'object', minimumNext: 'number', extended: 'boolean', listing: 'object' } });
const TRADE_RESPONSE = Object.freeze({ required: ['ok', 'trade'], properties: { ok: 'boolean', trade: 'object' } });
const TRADE_UPDATE_RESPONSE = Object.freeze({ required: ['ok', 'confirmationsReset', 'trade'], properties: { ok: 'boolean', confirmationsReset: 'boolean', trade: 'object' } });
const TRADE_CONFIRM_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'completed', 'trade'], properties: { ok: 'boolean', duplicate: 'boolean', completed: 'boolean', trade: 'object' } });
const SKILL_PURCHASE_RESPONSE = Object.freeze({ required: ['ok', 'purchase', 'state'], properties: { ok: 'boolean', purchase: 'object', state: 'object' } });
const RAID_CREATE_RESPONSE = Object.freeze({ required: ['ok', 'raid'], properties: { ok: 'boolean', raid: 'object' } });
const RAID_CONDITION_RESPONSE = Object.freeze({ required: ['ok', 'condition'], properties: { ok: 'boolean', condition: 'object' } });
const RAID_REWARD_RESPONSE = Object.freeze({ required: ['ok', 'reward'], properties: { ok: 'boolean', reward: 'object' } });
const RAID_HOST_RESPONSE = Object.freeze({ required: ['ok', 'host'], properties: { ok: 'boolean', host: 'object' } });
const ADMIN_BOOTSTRAP_RESPONSE = Object.freeze({ required: ['ok', 'actor', 'contractVersion', 'sections'], properties: { ok: 'boolean', actor: 'object', contractVersion: 'string', sections: 'array' } });
const ADMIN_POLICY_RESPONSE = Object.freeze({ required: ['ok', 'defaultPolicy', 'policies', 'atomicSafeActionTypes'], properties: { ok: 'boolean', defaultPolicy: 'string', policies: 'array', atomicSafeActionTypes: 'array' } });
const RESOURCE_RESPONSE = Object.freeze({ required: ['ok'], properties: { ok: 'boolean' } });
// Mutation handlers intentionally use several resource nouns (raid, purchase,
// operation, preview, etc.).  At least one is required in a successful public
// result; this avoids pretending their distinct payloads all share a `data`
// field while still making the family checkable.
const MUTATION_RESPONSE = Object.freeze({ required: ['ok'], atLeastOne: ['result', 'data', 'raid', 'operation', 'purchase', 'preview', 'item', 'listing', 'request', 'review', 'world', 'application', 'character', 'state'], properties: { ok: 'boolean' } });

const EXPLICIT_SHAPES = Object.freeze({
    'site-auth-login-v1': definition({ request: Object.freeze({ required: ['phone', 'code'], properties: { phone: 'string', code: 'string' } }), response: SESSION_RESPONSE, tier: 'critical' }),
    'site-health-v1': definition({ response: HEALTH_RESPONSE, tier: 'family' }),
    'future-character-v1': definition({ response: FUTURE_CHARACTER_RESPONSE, tier: 'critical' }),
    'future-character-read-shape-v1': definition({ response: FUTURE_CHARACTER_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'future-character-write-shape-v1': definition({ request: Object.freeze({ required: ['expectedRevision', 'draft'], properties: { expectedRevision: 'number', draft: 'object' } }), response: FUTURE_CHARACTER_RESPONSE, tier: 'critical' }),
    'future-character-submit-shape-v1': definition({ request: Object.freeze({ required: ['expectedRevision', 'draft'], properties: { expectedRevision: 'number', draft: 'object' } }), response: FUTURE_CHARACTER_RESPONSE, tier: 'critical' }),
    'future-character-review-v1': definition({ response: FUTURE_CHARACTER_RESPONSE, tier: 'critical' }),
    'future-character-review-shape-v1': definition({ request: Object.freeze({ required: ['action', 'reason', 'expectedRevision'], properties: { action: 'string', reason: 'string', expectedRevision: 'number' } }), response: FUTURE_CHARACTER_RESPONSE, tier: 'critical' }),
    'return-points-balance-v1': definition({ response: RETURN_POINTS_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'conversion-v1': definition({ response: CONVERSION_RESPONSE, tier: 'critical' }),
    'conversion-read-shape-v1': definition({ response: CONVERSION_RESPONSE, tier: 'critical', requestMode: 'none' }),
    // The claim body is parsed but intentionally has no client-authoritative
    // required field: its idempotency key may be supplied as a header.
    'conversion-claim-shape-v1': definition({ response: CONVERSION_RESPONSE, tier: 'critical', requestMode: 'optional' }),
    'reset-shop-catalog-v1': definition({ response: SHOP_CATALOG_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'entitlements-v1': definition({ response: ENTITLEMENTS_RESPONSE, tier: 'critical' }),
    'reset-shop-purchase-v1': definition({ request: Object.freeze({ required: ['itemKey'], properties: { itemKey: 'string' } }), response: PRE_RESET_PURCHASE_RESPONSE, tier: 'critical' }),
    'site-economy-payments-preview-shape-v1': definition({ request: Object.freeze({ required: ['recipientId', 'amount', 'reason'], properties: { recipientId: 'string', amount: 'number', reason: 'string' } }), response: PAYMENT_RESPONSE, tier: 'critical' }),
    'site-economy-payments-confirm-shape-v1': definition({ response: PAYMENT_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-payments-cancel-shape-v1': definition({ response: PAYMENT_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-market-listings-create-shape-v1': definition({ request: Object.freeze({ required: ['inventoryItemId', 'unitPrice'], properties: { inventoryItemId: 'number', unitPrice: 'number' } }), response: MARKET_LISTING_RESPONSE, tier: 'critical' }),
    'site-economy-market-listings-preview-shape-v1': definition({ request: Object.freeze({ required: ['inventoryItemId', 'unitPrice'], properties: { inventoryItemId: 'number', unitPrice: 'number' } }), response: MARKET_LISTING_QUOTE_RESPONSE, tier: 'critical' }),
    'site-economy-market-listings-cancel-shape-v1': definition({ response: MARKET_LISTING_CANCEL_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-market-purchases-preview-shape-v1': definition({ request: Object.freeze({ required: ['listingKey'], properties: { listingKey: 'string' } }), response: MARKET_PURCHASE_PREVIEW_RESPONSE, tier: 'critical' }),
    'site-economy-market-purchases-confirm-shape-v1': definition({ response: MARKET_PURCHASE_CONFIRM_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-market-purchases-cancel-shape-v1': definition({ response: MARKET_PURCHASE_CANCEL_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-market-auctions-bid-shape-v1': definition({ request: Object.freeze({ required: ['amount'], properties: { amount: 'number' } }), response: MARKET_AUCTION_BID_RESPONSE, tier: 'critical' }),
    'site-economy-trades-create-shape-v1': definition({ request: Object.freeze({ required: ['targetId', 'creatorItems'], properties: { targetId: 'string', creatorItems: 'array' } }), response: TRADE_RESPONSE, tier: 'critical' }),
    'site-economy-trades-update-shape-v1': definition({ request: Object.freeze({ required: ['items', 'yulls'], properties: { items: 'array', yulls: 'number' } }), response: TRADE_UPDATE_RESPONSE, tier: 'critical' }),
    'site-economy-trades-confirm-shape-v1': definition({ response: TRADE_CONFIRM_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-trades-cancel-shape-v1': definition({ response: TRADE_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'skill-purchase-v1': definition({ request: Object.freeze({ required: ['nodeId'], properties: { nodeId: 'string' } }), response: SKILL_PURCHASE_RESPONSE, tier: 'critical' }),
    // These are deliberately separate because their shared HTTP owner
    // delegates to three different domain operations with different required
    // inputs and result resources.  Their proof is tied to real boundary
    // captures in siteApiCriticalContractEvidence, not inferred from prefix.
    'raid-create-v1': definition({ request: Object.freeze({ required: ['name'], properties: { name: 'string' } }), response: RAID_CREATE_RESPONSE, tier: 'critical' }),
    'raid-condition-add-v1': definition({ request: Object.freeze({ required: ['label'], properties: { label: 'string' } }), response: RAID_CONDITION_RESPONSE, tier: 'critical' }),
    'raid-reward-add-v1': definition({ request: Object.freeze({ required: ['rewardType', 'amount'], properties: { rewardType: 'string', amount: 'number' } }), response: RAID_REWARD_RESPONSE, tier: 'critical' }),
    'raid-host-v1': definition({ request: Object.freeze({ required: ['playerId'], properties: { playerId: 'string' } }), response: RAID_HOST_RESPONSE, tier: 'critical' }),
    'raid-host-add-shape-v1': definition({ request: Object.freeze({ required: ['playerId'], properties: { playerId: 'string' } }), response: RAID_HOST_RESPONSE, tier: 'critical' }),
    'raid-host-revoke-shape-v1': definition({ request: Object.freeze({ required: ['playerId'], properties: { playerId: 'string' } }), response: SAFE_OK, tier: 'critical', responseKind: 'ACK' }),
    'admin-bootstrap-v1': definition({ response: ADMIN_BOOTSTRAP_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-operation-policies-v1': definition({ response: ADMIN_POLICY_RESPONSE, tier: 'critical', requestMode: 'none' }),
});


function familyForContractId(contractId) {
    if (EXPLICIT_SHAPES[contractId]) return EXPLICIT_SHAPES[contractId];
    // These prefixes are the public handler families, not a catch-all.  A
    // newly named public contract remains unresolved until it is classified.
    if (/^(raid-|site-raids-|site-economy-|admin-|dream-|squad-|recruitment-|skill-|canonical-admin-team-v1$|reception-v1$)/.test(contractId)) {
        return definition({ response: MUTATION_RESPONSE, tier: 'family', broad: true });
    }
    if (/^(site-|prereset-|character-presentation-preview-v1$)/.test(contractId)) {
        return definition({ response: RESOURCE_RESPONSE, tier: 'family', broad: true });
    }
    return null;
}

function buildContractShapeRegistry(contractIds) {
    const entries = [...new Set(contractIds)].sort().map((contractId) => [contractId, familyForContractId(contractId)]);
    return Object.freeze(Object.fromEntries(entries.filter(([, shape]) => shape)));
}

function resolveContractShape(contractId, registry) {
    return (registry || EXPLICIT_SHAPES)[contractId] || null;
}
function contractShapeKey(descriptor) { return descriptor?.contractShapeId || descriptor?.contractId || null; }
function resolveDescriptorContractShape(descriptor, registry) { return resolveContractShape(contractShapeKey(descriptor), registry); }

function typeMatches(value, expected) {
    return expected.split('|').some((type) => (
        (type === 'null' && value === null)
        || (type === 'array' && Array.isArray(value))
        || (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value))
        || (type !== 'null' && type !== 'array' && type !== 'object' && typeof value === type)
    ));
}

function validateShape(schema, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Object.freeze({ ok: false, errors: ['payload:not_object'] });
    const errors = [];
    for (const field of schema.required || []) if (!(field in payload)) errors.push(`missing:${field}`);
    if (schema.atLeastOne?.length && !schema.atLeastOne.some((field) => field in payload)) errors.push(`missing_one_of:${schema.atLeastOne.join(',')}`);
    for (const [field, type] of Object.entries(schema.properties || {})) {
        if (field in payload && !typeMatches(payload[field], type)) errors.push(`type:${field}:${type}`);
    }
    return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
function isMeaningfulCriticalResponseShape(shape) {
    if (!shape || shape.broad === true) return false;
    if (shape.responseKind === 'ACK') return shape.response?.required?.includes('ok') && shape.response?.properties?.ok === 'boolean';
    return !(shape.response?.required?.length === 1 && shape.response.required[0] === 'ok' && !shape.response?.atLeastOne?.length);
}

function validateContractPayload(contractId, side, payload, registry) {
    const shape = resolveContractShape(contractId, registry);
    if (!shape || !shape[side]) return Object.freeze({ ok: false, errors: [`unresolved:${contractId}:${side}`] });
    return validateShape(shape[side], payload);
}
function validateDescriptorContractPayload(descriptor, side, payload, registry) {
    const shape = resolveDescriptorContractShape(descriptor, registry);
    if (!shape || !shape[side]) return Object.freeze({ ok: false, errors: [`unresolved:${contractShapeKey(descriptor)}:${side}`] });
    return validateShape(shape[side], payload);
}

module.exports = {
    EMPTY_REQUEST,
    EXPLICIT_SHAPES,
    SAFE_ERROR,
    SAFE_OK,
    buildContractShapeRegistry,
    contractShapeKey,
    familyForContractId,
    resolveContractShape,
    resolveDescriptorContractShape,
    typeMatches,
    isMeaningfulCriticalResponseShape,
    validateContractPayload,
    validateDescriptorContractPayload,
    validateShape,
};
