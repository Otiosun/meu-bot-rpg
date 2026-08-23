'use strict';
const fs = require('fs');
const path = require('path');
const { CRITICAL_SITE_ENDPOINTS } = require('./siteApiContractRegistry');
const ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_FILES = Object.freeze(['helpers/clover/siteApiServerLegacy.js', 'helpers/clover/preResetSiteApiService.js', 'helpers/clover/dreamWorldsHttp.js', 'helpers/clover/dreamWorldsOperationsHttp.js', 'helpers/clover/skillApprovalHttp.js', 'helpers/clover/adminApiSupportBase.js']);
const ROUTE_LITERAL = /['`](\/(?:[A-Za-z0-9_\-:{}*]+\/?)*)['`]/g;
function normalize(value) { return String(value); }
function discoveredRoutes(files = ROUTER_FILES.map((file) => path.join(ROOT, file))) {
    return [...new Set(files.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(ROUTE_LITERAL)].map((match) => normalize(match[1])).filter((route) => route.length > 1)))].sort();
}
function auditRoutes(files) {
    const routes = discoveredRoutes(files);
    const registered = CRITICAL_SITE_ENDPOINTS.map((entry) => entry.path).filter((value) => !/[,*]/.test(value));
    const unclassified = routes.filter((route) => !registered.some((entry) => route === entry || route.startsWith(entry.replace(/:\w+/g, ':id')) || entry.includes('*')));
    return Object.freeze({ discovered: routes, registered, unclassified });
}
module.exports = { ROUTER_FILES, auditRoutes, discoveredRoutes, normalize };
