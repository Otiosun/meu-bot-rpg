'use strict';

const { routeDescriptor } = require('./httpRouteDescriptor');

const SOURCE_FILE = 'helpers/clover/siteApiServerBase.js';
function templateMatcher(template) {
    const parts = template.split('/').filter(Boolean);
    return (pathname) => {
        const actual = String(pathname || '').split('/').filter(Boolean);
        return actual.length === parts.length && actual.every((part, index) => parts[index].startsWith(':') || parts[index] === part);
    };
}
function specs(text) { return text.trim().split(/\s+/).flatMap((entry) => { const [methods, template] = entry.split('@'); return methods.split('|').map((method) => ({ methods: [method], template })); }); }
function descriptors(text, owner, authClass, visibility = 'PUBLIC_CONTRACT') {
    return Object.freeze(specs(text).map(({ methods, template }) => routeDescriptor({
        id: `site.${owner}.${methods.join('.').toLowerCase()}.${template.slice(1).replaceAll('/', '.').replaceAll(':', '') || 'root'}`,
        methods, template, samplePath: template.replace(/:[^/]+/g, 'example'), match: templateMatcher(template),
        handlerOwner: owner, sourceFile: SOURCE_FILE, visibility, authClass,
        contractId: `site-${template.slice(1).replaceAll('/', '-').replaceAll(':', '') || 'root'}-v1`,
    })));
}

const SITE_API_BASE_PUBLIC_ROUTE_DESCRIPTORS = Object.freeze(descriptors(`GET@/ GET@/health POST@/auth/login`, 'routePublic', 'PUBLIC_SAFE').map((route) => (
    route.id === 'site.routePublic.post.auth.login'
        ? Object.freeze({ ...route, contractShapeId: 'site-auth-login-shape-v1' })
        : route
)));
const RAW_AUTHED_ROUTE_DESCRIPTORS = descriptors(`
POST@/auth/logout GET@/access GET@/context GET@/squads/:key/members GET@/squads/:key/upgrades GET@/me GET@/bonus GET@/bonuses GET@/status
GET@/character GET@/character/appearance PUT@/character/profile-image GET|PUT@/character/profile-presentation GET@/character/spellbook GET@/capabilities GET@/capacidades GET|POST@/hexagono GET|POST@/hexagon
GET@/economy GET@/shops GET@/shops/:key GET@/economy/salary GET@/economy/market GET@/economy/market/dashboard
POST@/economy/payments/preview POST@/economy/payments/:key/confirm POST@/economy/payments/:key/cancel POST@/economy/market/listings POST@/economy/market/listings/preview POST@/economy/market/listings/:key/cancel POST@/economy/market/purchases/preview POST@/economy/market/purchases/:key/confirm POST@/economy/market/purchases/:key/cancel POST@/economy/market/auctions/:key/bids
GET|POST@/economy/trades PATCH@/economy/trades/:key POST@/economy/trades/:key/confirm POST@/economy/trades/:key/cancel GET|POST@/economy/weekly-requests PATCH@/economy/weekly-requests/:key POST@/economy/weekly-requests/:key/cancel POST@/economy/weekly-requests/:key/deliver
GET|POST@/economy/item-templates PATCH@/economy/item-templates/:key POST@/economy/item-templates/:key/archive POST@/economy/item-templates/:key/grant GET@/economy/redemptions GET@/economy/redemptions/pending POST@/economy/redemptions POST@/economy/redemptions/:key/cancel POST@/economy/redemptions/:key/approve POST@/economy/redemptions/:key/reject GET@/economy/titles POST@/economy/titles/deactivate POST@/economy/titles/:key/activate POST@/economy/initial-package POST@/economy/purchases/preview POST@/economy/purchases/:key/confirm POST@/economy/purchases/:key/cancel POST@/economy/sales/preview POST@/economy/sales/:key/confirm POST@/economy/repairs/preview POST@/economy/repairs/:key/confirm POST@/economy/consumables/:itemId/use
GET|POST@/raids GET@/raids/:key POST@/raids/:key/join POST@/raids/:key/leave POST@/raids/:key/hosts POST@/raids/:key/hosts/revoke POST@/raids/:key/participants/remove GET@/raids/:key/participants/:playerId PUT@/raids/:key/loadout/:slot POST@/raids/:key/start POST@/raids/:key/finalize POST@/raids/:key/cancel POST@/raids/:key/items/:inventoryItemId/wear POST@/raids/:key/items/:inventoryItemId/consume POST@/raids/:key/conditions POST@/raids/:key/conditions/:conditionId/resolve POST@/raids/:key/rewards POST@/raids/:key/rewards/:rewardId/cancel POST@/raids/:key/complete
GET@/inventory GET@/boxes POST@/boxes/:key/open GET@/ph GET@/yulls GET@/pr GET@/recruitment GET@/recruitment/shop POST@/recruitment/referrer GET|PUT@/attributes GET@/trees GET@/trees/:treeId POST@/trees/:treeId/purchase
`, 'routeAuthed', 'SITE_SESSION');
const SHADOWED_COMPATIBILITY_ROUTES = new Set(['POST /raids', 'GET /recruitment/shop', 'POST /trees/:treeId/purchase']);
const CONTRACT_SHAPE_OVERRIDES = Object.freeze({
    'site.routeAuthed.get.character.profile-presentation': 'site-character-profile-presentation-read-v1',
    'site.routeAuthed.put.character.profile-presentation': 'site-character-profile-presentation-update-v1',
    'site.routeAuthed.post.economy.payments.preview': 'site-economy-payments-preview-shape-v1',
    'site.routeAuthed.post.economy.payments.key.confirm': 'site-economy-payments-confirm-shape-v1',
    'site.routeAuthed.post.economy.payments.key.cancel': 'site-economy-payments-cancel-shape-v1',
    'site.routeAuthed.post.economy.market.listings': 'site-economy-market-listings-create-shape-v1',
    'site.routeAuthed.post.economy.market.listings.preview': 'site-economy-market-listings-preview-shape-v1',
    'site.routeAuthed.post.economy.market.listings.key.cancel': 'site-economy-market-listings-cancel-shape-v1',
    'site.routeAuthed.post.economy.market.purchases.preview': 'site-economy-market-purchases-preview-shape-v1',
    'site.routeAuthed.post.economy.market.purchases.key.confirm': 'site-economy-market-purchases-confirm-shape-v1',
    'site.routeAuthed.post.economy.market.purchases.key.cancel': 'site-economy-market-purchases-cancel-shape-v1',
    'site.routeAuthed.post.economy.market.auctions.key.bids': 'site-economy-market-auctions-bid-shape-v1',
    'site.routeAuthed.post.economy.trades': 'site-economy-trades-create-shape-v1',
    'site.routeAuthed.patch.economy.trades.key': 'site-economy-trades-update-shape-v1',
    'site.routeAuthed.post.economy.trades.key.confirm': 'site-economy-trades-confirm-shape-v1',
    'site.routeAuthed.post.economy.trades.key.cancel': 'site-economy-trades-cancel-shape-v1',
    'site.routeAuthed.post.economy.weekly-requests': 'site-economy-weekly-requests-create-shape-v1',
    'site.routeAuthed.patch.economy.weekly-requests.key': 'site-economy-weekly-requests-update-shape-v1',
    'site.routeAuthed.post.economy.weekly-requests.key.cancel': 'site-economy-weekly-requests-cancel-shape-v1',
    'site.routeAuthed.post.economy.weekly-requests.key.deliver': 'site-economy-weekly-requests-deliver-shape-v1',
    'site.routeAuthed.post.economy.item-templates': 'site-economy-item-templates-create-shape-v1',
    'site.routeAuthed.patch.economy.item-templates.key': 'site-economy-item-templates-update-shape-v1',
    'site.routeAuthed.post.economy.item-templates.key.archive': 'site-economy-item-templates-archive-shape-v1',
    'site.routeAuthed.post.economy.item-templates.key.grant': 'site-economy-item-templates-grant-shape-v1',
    'site.routeAuthed.post.economy.redemptions': 'site-economy-redemptions-create-shape-v1',
    'site.routeAuthed.post.economy.redemptions.key.cancel': 'site-economy-redemptions-cancel-shape-v1',
    'site.routeAuthed.post.economy.redemptions.key.approve': 'site-economy-redemptions-resolve-shape-v1',
    'site.routeAuthed.post.economy.redemptions.key.reject': 'site-economy-redemptions-resolve-shape-v1',
    'site.routeAuthed.post.economy.titles.deactivate': 'site-economy-titles-deactivate-shape-v1',
    'site.routeAuthed.post.economy.titles.key.activate': 'site-economy-titles-activate-shape-v1',
    'site.routeAuthed.post.economy.initial-package': 'site-economy-initial-package-shape-v1',
    'site.routeAuthed.post.economy.purchases.preview': 'site-economy-purchases-preview-shape-v1',
    'site.routeAuthed.post.economy.purchases.key.confirm': 'site-economy-purchases-confirm-shape-v1',
    'site.routeAuthed.post.economy.purchases.key.cancel': 'site-economy-purchases-cancel-shape-v1',
    'site.routeAuthed.post.economy.sales.preview': 'site-economy-sales-preview-shape-v1',
    'site.routeAuthed.post.economy.sales.key.confirm': 'site-economy-sales-confirm-shape-v1',
    'site.routeAuthed.post.economy.repairs.preview': 'site-economy-repairs-preview-shape-v1',
    'site.routeAuthed.post.economy.repairs.key.confirm': 'site-economy-repairs-confirm-shape-v1',
    'site.routeAuthed.post.economy.consumables.itemId.use': 'site-economy-consumables-use-shape-v1',
    'site.routeAuthed.post.boxes.key.open': 'site-box-open-shape-v1',
    'site.routeAuthed.post.recruitment.referrer': 'site-recruitment-referrer-shape-v1',
});
const SITE_API_BASE_AUTHED_ROUTE_DESCRIPTORS = Object.freeze(RAW_AUTHED_ROUTE_DESCRIPTORS.map((route) => (
    SHADOWED_COMPATIBILITY_ROUTES.has(`${route.methods[0]} ${route.template}`)
        ? Object.freeze({ ...route, visibility: 'INTERNAL_COMPAT_SHADOWED', contractShapeId: CONTRACT_SHAPE_OVERRIDES[route.id] || route.contractShapeId })
        : Object.freeze({ ...route, contractShapeId: CONTRACT_SHAPE_OVERRIDES[route.id] || route.contractShapeId })
)));
const SITE_API_BASE_ROUTE_DESCRIPTORS = Object.freeze([...SITE_API_BASE_PUBLIC_ROUTE_DESCRIPTORS, ...SITE_API_BASE_AUTHED_ROUTE_DESCRIPTORS]);
module.exports = { SITE_API_BASE_AUTHED_ROUTE_DESCRIPTORS, SITE_API_BASE_PUBLIC_ROUTE_DESCRIPTORS, SITE_API_BASE_ROUTE_DESCRIPTORS, templateMatcher };
