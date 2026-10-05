'use strict';

const {
    SITE_API_BASE_ROUTE_DESCRIPTORS,
} = require('./siteApiBaseRouteDescriptors');
const {
    LEGACY_PUBLIC_ROUTES,
    LEGACY_SQUAD_ROUTE_DESCRIPTORS,
    RECRUITMENT_SHOP_ROUTE_DESCRIPTORS,
    LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS,
    LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS,
} = require('./siteApiServerLegacy');

function endpointEntries() {
    const seen = new Set();
    const entries = [];
    const descriptors = [
        ...SITE_API_BASE_ROUTE_DESCRIPTORS,
        ...LEGACY_PUBLIC_ROUTES,
        ...LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS,
        ...LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS,
        ...LEGACY_SQUAD_ROUTE_DESCRIPTORS,
        ...RECRUITMENT_SHOP_ROUTE_DESCRIPTORS,
    ];

    for (const descriptor of descriptors) {
        for (const method of descriptor.methods || []) {
            const entry = `${String(method).toUpperCase()} ${descriptor.template}`;
            if (seen.has(entry)) continue;
            seen.add(entry);
            entries.push(entry);
        }
    }
    return entries.sort((a, b) => a.localeCompare(b));
}

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function handleSiteEndpointDiscoveryHttp(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/') return false;
    if (!['GET', 'OPTIONS'].includes(method)) return false;

    setCors(req, res);
    res.setHeader('Cache-Control', 'no-store');
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
        ok: true,
        name: 'Clover Multicolor Site API',
        endpoints: endpointEntries(),
    }));
    return true;
}

module.exports = {
    endpointEntries,
    handleSiteEndpointDiscoveryHttp,
};
