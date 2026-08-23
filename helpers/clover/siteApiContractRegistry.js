'use strict';

// v1 is intentionally declarative: handlers remain the only runtime authority.
const SITE_API_CONTRACT_VERSION = 'v1';
const PUBLIC_ERROR_ENVELOPE = Object.freeze({ ok: false, error: 'stable_code', message: 'safe_message' });
const PRE_RESET_ENDPOINTS = Object.freeze([
    { method: 'GET', path: '/pre-reset/status', area: 'auth-session', dto: 'status' },
    { method: 'GET', path: '/pre-reset/future-character', area: 'future-character', dto: 'futureCharacter' },
    { method: 'POST|PUT', path: '/pre-reset/future-character', area: 'future-character', dto: 'futureCharacter' },
    { method: 'POST', path: '/pre-reset/future-character/submit', area: 'future-character', dto: 'futureCharacter' },
    { method: 'GET', path: '/pre-reset/return-points/balance', area: 'return-points', dto: 'returnPoints' },
    { method: 'GET', path: '/pre-reset/conversion', area: 'conversion', dto: 'conversion' },
    { method: 'POST', path: '/pre-reset/conversion/claim', area: 'conversion', dto: 'conversion' },
    { method: 'GET', path: '/pre-reset/shop/catalog', area: 'shop', dto: 'catalog' },
    { method: 'GET', path: '/pre-reset/entitlements', area: 'entitlement', dto: 'entitlements' },
    { method: 'POST', path: '/pre-reset/shop/purchase', area: 'purchase-entitlement', dto: 'purchase' },
    { method: 'POST', path: '/pre-reset/admin/future-characters/:playerId/review', area: 'admin-review', dto: 'futureCharacter' },
]);

function getPublicSiteApiContract() {
    return Object.freeze({
        version: SITE_API_CONTRACT_VERSION,
        authentication: 'Bearer site session',
        mutationIdempotencyHeader: 'Idempotency-Key',
        errorEnvelope: PUBLIC_ERROR_ENVELOPE,
        endpoints: PRE_RESET_ENDPOINTS,
        compatibility: 'additive-only-within-v1',
    });
}

module.exports = { SITE_API_CONTRACT_VERSION, PUBLIC_ERROR_ENVELOPE, PRE_RESET_ENDPOINTS, getPublicSiteApiContract };
