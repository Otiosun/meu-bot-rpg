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
const WEEKLY_REQUEST_RESPONSE = Object.freeze({ required: ['ok', 'request'], properties: { ok: 'boolean', request: 'object' } });
const WEEKLY_DELIVERY_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'delivery', 'request'], properties: { ok: 'boolean', duplicate: 'boolean', delivery: 'object', request: 'object' } });
const ITEM_TEMPLATE_RESPONSE = Object.freeze({ required: ['ok', 'template'], properties: { ok: 'boolean', template: 'object' } });
const ITEM_TEMPLATE_ARCHIVE_RESPONSE = Object.freeze({ required: ['ok', 'archived', 'templateKey'], properties: { ok: 'boolean', archived: 'boolean', templateKey: 'string' } });
const ITEM_TEMPLATE_GRANT_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'player', 'template', 'quantity', 'items'], properties: { ok: 'boolean', duplicate: 'boolean', player: 'object', template: 'object', quantity: 'number', items: 'array' } });
const REDEMPTION_RESPONSE = Object.freeze({ required: ['ok', 'redemption'], properties: { ok: 'boolean', redemption: 'object' } });
const TITLE_RESPONSE = Object.freeze({ required: ['ok', 'changed', 'title', 'activeTitle'], properties: { ok: 'boolean', changed: 'boolean', title: 'object|null', activeTitle: 'object|null' } });
const INITIAL_PACKAGE_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'package', 'credit', 'items'], properties: { ok: 'boolean', duplicate: 'boolean', package: 'object', credit: 'object', items: 'array' } });
const PURCHASE_PREVIEW_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'purchase', 'listing'], properties: { ok: 'boolean', duplicate: 'boolean', purchase: 'object', listing: 'object' } });
const PURCHASE_CONFIRM_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'purchase', 'spend', 'items'], properties: { ok: 'boolean', duplicate: 'boolean', purchase: 'object', spend: 'object|null', items: 'array' } });
const PURCHASE_CANCEL_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'refunded', 'purchase'], properties: { ok: 'boolean', duplicate: 'boolean', refunded: 'number', purchase: 'object' } });
const SALE_PREVIEW_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'sale', 'item'], properties: { ok: 'boolean', duplicate: 'boolean', sale: 'object', item: 'object' } });
const SALE_CONFIRM_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'sale', 'credit', 'consumed'], properties: { ok: 'boolean', duplicate: 'boolean', sale: 'object', credit: 'object', consumed: 'object' } });
const REPAIR_PREVIEW_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'repair', 'item'], properties: { ok: 'boolean', duplicate: 'boolean', repair: 'object', item: 'object' } });
const REPAIR_CONFIRM_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'repair', 'spend', 'item'], properties: { ok: 'boolean', duplicate: 'boolean', repair: 'object', spend: 'object|null', item: 'object' } });
const CONSUMABLE_USE_RESPONSE = Object.freeze({ required: ['ok', 'duplicate', 'use', 'consumed', 'result', 'narratorApplies', 'effect'], properties: { ok: 'boolean', duplicate: 'boolean', use: 'object', consumed: 'object', result: 'string', narratorApplies: 'boolean', effect: 'object' } });
const SKILL_PURCHASE_RESPONSE = Object.freeze({ required: ['ok', 'purchase', 'state'], properties: { ok: 'boolean', purchase: 'object', state: 'object' } });
const RAID_CREATE_RESPONSE = Object.freeze({ required: ['ok', 'raid'], properties: { ok: 'boolean', raid: 'object' } });
const RAID_CONDITION_RESPONSE = Object.freeze({ required: ['ok', 'condition'], properties: { ok: 'boolean', condition: 'object' } });
const RAID_REWARD_RESPONSE = Object.freeze({ required: ['ok', 'reward'], properties: { ok: 'boolean', reward: 'object' } });
const RAID_HOST_RESPONSE = Object.freeze({ required: ['ok', 'host'], properties: { ok: 'boolean', host: 'object' } });
const ADMIN_BOOTSTRAP_RESPONSE = Object.freeze({ required: ['ok', 'actor', 'contractVersion', 'sections'], properties: { ok: 'boolean', actor: 'object', contractVersion: 'string', sections: 'array' } });
const ADMIN_POLICY_RESPONSE = Object.freeze({ required: ['ok', 'defaultPolicy', 'policies', 'atomicSafeActionTypes'], properties: { ok: 'boolean', defaultPolicy: 'string', policies: 'array', atomicSafeActionTypes: 'array' } });
const ADMIN_PLAYER_SEARCH_RESPONSE = Object.freeze({ required: ['ok', 'query', 'exact', 'suggestions', 'ambiguous'], properties: { ok: 'boolean', query: 'string', exact: 'array', suggestions: 'array', ambiguous: 'boolean' } });
const ADMIN_PLAYER_DETAIL_RESPONSE = Object.freeze({ required: ['ok', 'player', 'identity', 'modules'], properties: { ok: 'boolean', player: 'object', identity: 'object', modules: 'object' } });
const ADMIN_INTEGRITY_RESPONSE = Object.freeze({ required: ['generatedAt', 'readOnly', 'players', 'tables', 'issues', 'summary'], properties: { generatedAt: 'string', readOnly: 'boolean', players: 'number', tables: 'number', issues: 'array', summary: 'object' } });
const ADMIN_ITEM_LIST_RESPONSE = Object.freeze({ required: ['ok', 'items'], properties: { ok: 'boolean', items: 'array' } });
const ADMIN_ITEM_RESPONSE = Object.freeze({ required: ['ok', 'item'], properties: { ok: 'boolean', item: 'object' } });
const ADMIN_REWARD_LIST_RESPONSE = Object.freeze({ required: ['ok', 'packages', 'statuses', 'supportedEntryTypes'], properties: { ok: 'boolean', packages: 'array', statuses: 'array', supportedEntryTypes: 'array' } });
const ADMIN_REWARD_GRANT_LIST_RESPONSE = Object.freeze({ required: ['ok', 'grants'], properties: { ok: 'boolean', grants: 'array' } });
const ADMIN_REWARD_RESPONSE = Object.freeze({ required: ['ok', 'package'], properties: { ok: 'boolean', package: 'object' } });
const ADMIN_HOOK_LIST_RESPONSE = Object.freeze({ required: ['ok', 'hooks', 'statuses', 'hookV2Version'], properties: { ok: 'boolean', hooks: 'array', statuses: 'array', hookV2Version: 'number' } });
const ADMIN_HOOK_SCHEMA_RESPONSE = Object.freeze({ required: ['ok', 'version', 'presentationTypes', 'visibilities', 'triggerTypes', 'lifecycleStages', 'lifecycleTransitions', 'effectEvents', 'effectTypes', 'effectDeliveries', 'automaticEffectActions'], properties: { ok: 'boolean', version: 'number', presentationTypes: 'array', visibilities: 'array', triggerTypes: 'array', lifecycleStages: 'array', lifecycleTransitions: 'object', effectEvents: 'array', effectTypes: 'array', effectDeliveries: 'array', automaticEffectActions: 'object' } });
const ADMIN_HOOK_ASSIGNMENT_LIST_RESPONSE = Object.freeze({ required: ['ok', 'assignments', 'statuses', 'hookV2Version'], properties: { ok: 'boolean', assignments: 'array', statuses: 'array', hookV2Version: 'number' } });
const ADMIN_HOOK_RESPONSE = Object.freeze({ required: ['ok', 'hook', 'hookV2Version'], properties: { ok: 'boolean', hook: 'object', hookV2Version: 'number' } });
const ADMIN_COMMAND_CENTER_INBOX_RESPONSE = Object.freeze({ required: ['ok', 'readOnly', 'generatedAt', 'deferredDomains', 'summary', 'items', 'sections', 'permissions'], properties: { ok: 'boolean', readOnly: 'boolean', generatedAt: 'string', deferredDomains: 'array', summary: 'object', items: 'array', sections: 'object', permissions: 'object' } });
const ADMIN_COMMAND_CENTER_HISTORY_RESPONSE = Object.freeze({ required: ['ok', 'readOnly', 'events', 'sources'], properties: { ok: 'boolean', readOnly: 'boolean', events: 'array', sources: 'object' } });
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
    'site-economy-weekly-requests-create-shape-v1': definition({ request: Object.freeze({ required: ['templateKey'], properties: { templateKey: 'string' } }), response: WEEKLY_REQUEST_RESPONSE, tier: 'critical' }),
    'site-economy-weekly-requests-update-shape-v1': definition({ request: Object.freeze({ required: ['pricePercent'], properties: { pricePercent: 'number' } }), response: WEEKLY_REQUEST_RESPONSE, tier: 'critical' }),
    'site-economy-weekly-requests-cancel-shape-v1': definition({ response: WEEKLY_REQUEST_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-weekly-requests-deliver-shape-v1': definition({ request: Object.freeze({ required: ['inventoryItemId'], properties: { inventoryItemId: 'number' } }), response: WEEKLY_DELIVERY_RESPONSE, tier: 'critical' }),
    'site-economy-item-templates-create-shape-v1': definition({ request: Object.freeze({ required: ['templateKey', 'itemName', 'description'], properties: { templateKey: 'string', itemName: 'string', description: 'string' } }), response: ITEM_TEMPLATE_RESPONSE, tier: 'critical' }),
    'site-economy-item-templates-update-shape-v1': definition({ request: Object.freeze({ required: ['basePrice'], properties: { basePrice: 'number' } }), response: ITEM_TEMPLATE_RESPONSE, tier: 'critical' }),
    'site-economy-item-templates-archive-shape-v1': definition({ response: ITEM_TEMPLATE_ARCHIVE_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-item-templates-grant-shape-v1': definition({ request: Object.freeze({ required: ['playerId', 'quantity'], properties: { playerId: 'string', quantity: 'number' } }), response: ITEM_TEMPLATE_GRANT_RESPONSE, tier: 'critical' }),
    'site-economy-redemptions-create-shape-v1': definition({ request: Object.freeze({ required: ['inventoryItemId', 'note'], properties: { inventoryItemId: 'number', note: 'string' } }), response: REDEMPTION_RESPONSE, tier: 'critical' }),
    'site-economy-redemptions-cancel-shape-v1': definition({ response: REDEMPTION_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-redemptions-resolve-shape-v1': definition({ request: Object.freeze({ required: ['note'], properties: { note: 'string' } }), response: REDEMPTION_RESPONSE, tier: 'critical' }),
    'site-economy-titles-deactivate-shape-v1': definition({ response: TITLE_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-titles-activate-shape-v1': definition({ response: TITLE_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-initial-package-shape-v1': definition({ request: Object.freeze({ required: ['equipmentTemplateKey'], properties: { equipmentTemplateKey: 'string' } }), response: INITIAL_PACKAGE_RESPONSE, tier: 'critical' }),
    'site-economy-purchases-preview-shape-v1': definition({ request: Object.freeze({ required: ['listingKey', 'quantity'], properties: { listingKey: 'string', quantity: 'number' } }), response: PURCHASE_PREVIEW_RESPONSE, tier: 'critical' }),
    'site-economy-purchases-confirm-shape-v1': definition({ response: PURCHASE_CONFIRM_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-purchases-cancel-shape-v1': definition({ response: PURCHASE_CANCEL_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-sales-preview-shape-v1': definition({ request: Object.freeze({ required: ['inventoryItemId', 'quantity'], properties: { inventoryItemId: 'number', quantity: 'number' } }), response: SALE_PREVIEW_RESPONSE, tier: 'critical' }),
    'site-economy-sales-confirm-shape-v1': definition({ response: SALE_CONFIRM_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-repairs-preview-shape-v1': definition({ request: Object.freeze({ required: ['inventoryItemId'], properties: { inventoryItemId: 'number' } }), response: REPAIR_PREVIEW_RESPONSE, tier: 'critical' }),
    'site-economy-repairs-confirm-shape-v1': definition({ response: REPAIR_CONFIRM_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'site-economy-consumables-use-shape-v1': definition({ request: Object.freeze({ required: ['contextType'], properties: { contextType: 'string' } }), response: CONSUMABLE_USE_RESPONSE, tier: 'critical' }),
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
    'admin-player-search-shape-v1': definition({ response: ADMIN_PLAYER_SEARCH_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-player-detail-shape-v1': definition({ response: ADMIN_PLAYER_DETAIL_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-integrity-summary-shape-v1': definition({ response: ADMIN_INTEGRITY_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-item-list-shape-v1': definition({ response: ADMIN_ITEM_LIST_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-item-shape-v1': definition({ response: ADMIN_ITEM_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-reward-list-shape-v1': definition({ response: ADMIN_REWARD_LIST_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-reward-grant-list-shape-v1': definition({ response: ADMIN_REWARD_GRANT_LIST_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-reward-shape-v1': definition({ response: ADMIN_REWARD_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-hooks-list-shape-v2': definition({ response: ADMIN_HOOK_LIST_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-hooks-schema-shape-v2': definition({ response: ADMIN_HOOK_SCHEMA_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-hook-assignments-list-shape-v2': definition({ response: ADMIN_HOOK_ASSIGNMENT_LIST_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-hook-detail-shape-v2': definition({ response: ADMIN_HOOK_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-command-center-inbox-shape-v1': definition({ response: ADMIN_COMMAND_CENTER_INBOX_RESPONSE, tier: 'critical', requestMode: 'none' }),
    'admin-command-center-history-shape-v1': definition({ response: ADMIN_COMMAND_CENTER_HISTORY_RESPONSE, tier: 'critical', requestMode: 'none' }),
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
