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

// Each entry is a real route family implemented by the listed handler. Dynamic
// identifiers/actions are expressed as normalized path templates, not invented
// endpoint variants.
const CRITICAL_SITE_ENDPOINTS = Object.freeze([
    ...PRE_RESET_ENDPOINTS.map((entry) => ({ ...entry, auth: 'site-session', capability: entry.area === 'admin-review' ? 'prereset.review' : null, requestDto: entry.dto, responseDto: entry.dto, errorModel: 'safe-v1', owner: 'preResetSiteApiService', classification: 'PUBLIC_CRITICAL' })),
    { method: 'GET|POST', path: '/raids, /raids/:id/*', area: 'raid', auth: 'site-session', capability: 'raid.manage', requestDto: 'raid-v1', responseDto: 'raid-v1', errorModel: 'safe-v1', owner: 'raidCoreIdempotentHttp', classification: 'PUBLIC_CRITICAL' },
    { method: 'GET|POST', path: '/raids/checklist, /raids/:id/finalization', area: 'raid-review', auth: 'site-session', capability: 'raid.reward.review', requestDto: 'raid-review-v1', responseDto: 'raid-review-v1', errorModel: 'safe-v1', owner: 'siteApiServerLegacy', classification: 'PUBLIC_CRITICAL' },
    { method: 'GET|POST', path: '/squads/:id/*', area: 'squad', auth: 'site-session', capability: 'squad-membership', requestDto: 'squad-v1', responseDto: 'squad-v1', errorModel: 'safe-v1', owner: 'siteApiServerLegacy', classification: 'PUBLIC_CRITICAL' },
    { method: 'GET|POST', path: '/dream-worlds/*', area: 'dream-worlds', auth: 'site-session', capability: 'domain-policy', requestDto: 'dream-worlds-v1', responseDto: 'dream-worlds-v1', errorModel: 'safe-v1', owner: 'dreamWorldsHttp', classification: 'PUBLIC_CRITICAL' },
    { method: 'POST', path: '/trees/:id/purchase', area: 'skills', auth: 'site-session', capability: 'self', requestDto: 'skill-purchase-v1', responseDto: 'skill-purchase-v1', errorModel: 'safe-v1', owner: 'skillApprovalHttp', classification: 'PUBLIC_CRITICAL' },
    { method: 'GET|POST', path: '/recruitment/shop/*', area: 'recruitment', auth: 'site-session', capability: 'self', requestDto: 'recruitment-v1', responseDto: 'recruitment-v1', errorModel: 'safe-v1', owner: 'siteApiServerLegacy', classification: 'PUBLIC_CRITICAL' },
    { method: 'GET', path: '/reception, /recepcao', area: 'onboarding', auth: 'public-safe', capability: null, requestDto: 'none', responseDto: 'reception-v1', errorModel: 'safe-v1', owner: 'siteApiServerLegacy', classification: 'PUBLIC_CRITICAL' },
    { method: 'GET|POST', path: '/admin/*', area: 'admin', auth: 'site-session', capability: 'canonical-admin-capability', requestDto: 'admin-v1', responseDto: 'admin-v1', errorModel: 'safe-v1', owner: 'adminApiSupport', classification: 'PUBLIC_CRITICAL' },
]);

function getPublicSiteApiContract() {
    return Object.freeze({
        version: SITE_API_CONTRACT_VERSION,
        authentication: 'Bearer site session',
        mutationIdempotencyHeader: 'Idempotency-Key',
        errorEnvelope: PUBLIC_ERROR_ENVELOPE,
        endpoints: CRITICAL_SITE_ENDPOINTS,
        compatibility: 'additive-only-within-v1',
    });
}

module.exports = { SITE_API_CONTRACT_VERSION, PUBLIC_ERROR_ENVELOPE, PRE_RESET_ENDPOINTS, CRITICAL_SITE_ENDPOINTS, getPublicSiteApiContract };
