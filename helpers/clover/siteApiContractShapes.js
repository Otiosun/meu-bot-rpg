'use strict';

// This deliberately stays smaller than JSON Schema.  The public API only
// needs stable, executable assertions for fields we promise to clients.
const SAFE_ERROR = Object.freeze({ required: ['ok', 'error', 'message'], properties: { ok: 'boolean', error: 'string', message: 'string' } });
const EMPTY_REQUEST = Object.freeze({ required: [], properties: {} });
const SAFE_OK = Object.freeze({ required: ['ok'], properties: { ok: 'boolean' } });

function definition({ request = EMPTY_REQUEST, response = SAFE_OK, tier = 'envelope', broad = false }) {
    return Object.freeze({ request, response, error: SAFE_ERROR, tier, broad });
}

const SESSION_RESPONSE = Object.freeze({ required: ['ok', 'token', 'expiresAt', 'player'], properties: { ok: 'boolean', token: 'string', expiresAt: 'string', player: 'object' } });
const HEALTH_RESPONSE = Object.freeze({ required: ['ok', 'status', 'queue'], properties: { ok: 'boolean', status: 'string', queue: 'object' } });
const FUTURE_CHARACTER_RESPONSE = Object.freeze({ required: ['ok', 'character'], properties: { ok: 'boolean', character: 'object|null' } });
const RETURN_POINTS_RESPONSE = Object.freeze({ required: ['ok', 'balance', 'ledger'], properties: { ok: 'boolean', balance: 'number', ledger: 'array' } });
const CONVERSION_RESPONSE = Object.freeze({ required: ['ok', 'conversion'], properties: { ok: 'boolean', conversion: 'object' } });
const SHOP_CATALOG_RESPONSE = Object.freeze({ required: ['ok', 'status', 'items'], properties: { ok: 'boolean', status: 'string', items: 'array' } });
const ENTITLEMENTS_RESPONSE = Object.freeze({ required: ['ok', 'purchases', 'entitlements'], properties: { ok: 'boolean', purchases: 'array', entitlements: 'array' } });
const PRE_RESET_PURCHASE_RESPONSE = Object.freeze({ required: ['ok', 'purchase', 'entitlement', 'balanceAfter'], properties: { ok: 'boolean', purchase: 'object', entitlement: 'object', balanceAfter: 'number' } });
const SKILL_PURCHASE_RESPONSE = Object.freeze({ required: ['ok', 'purchase', 'state'], properties: { ok: 'boolean', purchase: 'object', state: 'object' } });
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
    'future-character-review-v1': definition({ response: FUTURE_CHARACTER_RESPONSE, tier: 'critical' }),
    'return-points-balance-v1': definition({ response: RETURN_POINTS_RESPONSE, tier: 'critical' }),
    'conversion-v1': definition({ response: CONVERSION_RESPONSE, tier: 'critical' }),
    'reset-shop-catalog-v1': definition({ response: SHOP_CATALOG_RESPONSE, tier: 'critical' }),
    'entitlements-v1': definition({ response: ENTITLEMENTS_RESPONSE, tier: 'critical' }),
    'reset-shop-purchase-v1': definition({ request: Object.freeze({ required: ['itemKey'], properties: { itemKey: 'string' } }), response: PRE_RESET_PURCHASE_RESPONSE, tier: 'critical' }),
    'skill-purchase-v1': definition({ request: Object.freeze({ required: ['nodeId'], properties: { nodeId: 'string' } }), response: SKILL_PURCHASE_RESPONSE, tier: 'critical' }),
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

function validateContractPayload(contractId, side, payload, registry) {
    const shape = resolveContractShape(contractId, registry);
    if (!shape || !shape[side]) return Object.freeze({ ok: false, errors: [`unresolved:${contractId}:${side}`] });
    return validateShape(shape[side], payload);
}

module.exports = {
    EMPTY_REQUEST,
    EXPLICIT_SHAPES,
    SAFE_ERROR,
    SAFE_OK,
    buildContractShapeRegistry,
    familyForContractId,
    resolveContractShape,
    typeMatches,
    validateContractPayload,
    validateShape,
};
