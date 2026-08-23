'use strict';
const fs = require('fs');
const path = require('path');
const { CRITICAL_SITE_ENDPOINTS } = require('./siteApiContractRegistry');
const ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_FILES = Object.freeze(['helpers/clover/siteApiServerLegacy.js', 'helpers/clover/preResetSiteApiService.js', 'helpers/clover/dreamWorldsHttp.js', 'helpers/clover/dreamWorldsOperationsHttp.js', 'helpers/clover/skillApprovalHttp.js', 'helpers/clover/adminApiSupportBase.js']);
const ROUTE_LITERAL = /['`](\/(?:[A-Za-z0-9_\-:{}*]+\/?)*)['`]/g;
const PUBLIC_ERROR_SCHEMA = Object.freeze({ type: 'object', required: ['ok', 'error', 'message'], properties: { ok: 'boolean', error: 'string', message: 'string' } });
const PUBLIC_RESPONSE_SCHEMA = Object.freeze({ type: 'object', required: ['ok'], properties: { ok: 'boolean' } });
const ROUTE_LEDGER = Object.freeze([
    '/admin/bootstrap','/admin/dream-worlds','/admin/dream-worlds/applications','/admin/dream-worlds/fragments','/admin/dream-worlds/requests','/admin/dream-worlds/runs','/admin/integrity/summary','/admin/operations','/admin/players/search','/admin/skill-approvals','/admin/team','/admin/team/changes','/admin/traits',
    '/dream-worlds','/dream-worlds/fragments','/dream-worlds/me','/dream-worlds/me/applications',
    '/pre-reset','/pre-reset/conversion','/pre-reset/conversion/claim','/pre-reset/entitlements','/pre-reset/future-character','/pre-reset/future-character/submit','/pre-reset/return-points/balance','/pre-reset/shop/catalog','/pre-reset/shop/purchase','/pre-reset/status',
    '/raid-categories','/raid-reward-proposals','/raids/categories','/raids/checklist','/raids/options','/raids/usage','/recepcao','/reception','/recruitment/shop',
].map((normalizedPath) => Object.freeze({
    normalizedPath,
    sourceFile: normalizedPath.startsWith('/pre-reset') ? 'helpers/clover/preResetSiteApiService.js' : normalizedPath.startsWith('/dream-worlds') || normalizedPath.startsWith('/admin/dream-worlds') ? 'helpers/clover/dreamWorldsHttp.js' : normalizedPath === '/admin/skill-approvals' ? 'helpers/clover/skillApprovalHttp.js' : normalizedPath.startsWith('/admin/') ? 'helpers/clover/adminApiSupportBase.js' : 'helpers/clover/siteApiServerLegacy.js',
    method: normalizedPath === '/pre-reset' ? 'INTERNAL_DISPATCH' : 'GET|POST',
    handler: normalizedPath.startsWith('/pre-reset') ? 'handlePreResetSiteApi' : 'runtime route handler',
    classification: normalizedPath === '/pre-reset' ? 'INTERNAL_DISPATCH' : normalizedPath === '/recepcao' ? 'PUBLIC_ALIAS' : 'PUBLIC_CONTRACT',
    contractId: normalizedPath === '/pre-reset' ? null : normalizedPath === '/recepcao' ? 'reception-v1' : `${normalizedPath.slice(1).replaceAll('/', '-').replaceAll(':', '')}-v1`,
    authClass: normalizedPath === '/reception' || normalizedPath === '/recepcao' ? 'PUBLIC_SAFE' : normalizedPath.startsWith('/admin/') ? 'ADMIN_CAPABILITY' : 'SITE_SESSION',
    requestSchema: { type: 'object', required: [] }, responseSchema: PUBLIC_RESPONSE_SCHEMA, errorSchema: PUBLIC_ERROR_SCHEMA, version: 'v1', compatibility: normalizedPath === '/recepcao' ? 'alias-of-reception-v1' : 'additive',
})));
function normalize(value) { return String(value); }
function discoveredRoutes(files = ROUTER_FILES.map((file) => path.join(ROOT, file))) {
    return [...new Set(files.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(ROUTE_LITERAL)].map((match) => normalize(match[1])).filter((route) => route.length > 1)))].sort();
}
function auditRoutes(files) {
    const routes = discoveredRoutes(files);
    const registered = ROUTE_LEDGER.map((entry) => entry.normalizedPath);
    const unclassified = routes.filter((route) => !registered.includes(route));
    const stale = registered.filter((route) => !routes.includes(route));
    return Object.freeze({ discovered: routes, registered, unclassified, stale, ledger: ROUTE_LEDGER });
}
module.exports = { PUBLIC_ERROR_SCHEMA, PUBLIC_RESPONSE_SCHEMA, ROUTE_LEDGER, ROUTER_FILES, auditRoutes, discoveredRoutes, normalize };
