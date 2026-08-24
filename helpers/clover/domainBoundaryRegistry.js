'use strict';

const REQUIRED_FIELDS = Object.freeze(['domain', 'classification', 'canonicalDataAuthority', 'serviceOwner', 'dataAccessOwner', 'publicEntrypoints', 'writers', 'readers', 'crossDomainCalls', 'ledgerAudit', 'kernelStatus', 'legacyAdapters', 'directSqlOrFieldBypasses', 'p0p1Gaps', 'deferredGaps']);

function domain(domain, classification, owner, extra = {}) {
    return Object.freeze({
        domain, classification, canonicalDataAuthority: owner, serviceOwner: owner, dataAccessOwner: owner,
        publicEntrypoints: [], writers: [owner], readers: [owner], crossDomainCalls: [],
        ledgerAudit: 'not-applicable', kernelStatus: 'service-owned', legacyAdapters: [],
        directSqlOrFieldBypasses: 'audited-none', p0p1Gaps: [], deferredGaps: [], ...extra,
    });
}

const DOMAIN_BOUNDARIES = Object.freeze([
    domain('Player / Identity / Profile', 'DOMAIN_CANONICAL_EXISTING', 'canonicalPlayerIdentityService', { publicEntrypoints: ['site session', 'profile'], readers: ['siteAuthService', 'profileAccessPreservationService'], legacyAdapters: ['identity aliases'] }),
    domain('Squad', 'DOMAIN_BOUNDARY_CONVERGED', 'squadMembershipService', { publicEntrypoints: ['site squad operations'], ledgerAudit: 'membership divergence audit', crossDomainCalls: ['Raid'] }),
    domain('PH', 'DOMAIN_CANONICAL_EXISTING', 'phService', { ledgerAudit: 'PH ledger', crossDomainCalls: ['Return Points', 'Raid'] }),
    domain('Yulls', 'DOMAIN_CANONICAL_EXISTING', 'economyService', { ledgerAudit: 'economy ledger', crossDomainCalls: ['Inventory', 'Market'] }),
    domain('Return Points', 'DOMAIN_CANONICAL_EXISTING', 'returnPointsService', { publicEntrypoints: ['/pre-reset/return-points/balance'], ledgerAudit: 'return points ledger', crossDomainCalls: ['Reset Conversion', 'Reset Shop'] }),
    domain('Recruitment Points', 'DOMAIN_CANONICAL_EXISTING', 'recruitmentService', { ledgerAudit: 'recruitment audit' }),
    domain('Inventory', 'DOMAIN_CANONICAL_EXISTING', 'inventoryService', { ledgerAudit: 'inventory receipts', crossDomainCalls: ['Yulls', 'Skills'] }),
    domain('Progression / Stats', 'DOMAIN_CANONICAL_EXISTING', 'characterProgressionService', { crossDomainCalls: ['PH', 'Skills'] }),
    domain('Skills', 'DOMAIN_CANONICAL_EXISTING', 'siteSpellbookService', { publicEntrypoints: ['site spellbook'], crossDomainCalls: ['Spells'] }),
    domain('Spells', 'DOMAIN_CANONICAL_EXISTING', 'spellReviewService', { ledgerAudit: 'spell queue audit', crossDomainCalls: ['Skills'] }),
    domain('Hexagon', 'DOMAIN_ADAPTER_ONLY', 'characterPresentationService', { deferredGaps: ['product-owned expansion'] }),
    domain('Raid', 'DOMAIN_BOUNDARY_CONVERGED', 'raidRewardProposalService', { ledgerAudit: 'raid monthly ledger and review events', crossDomainCalls: ['Squad', 'PH'] }),
    domain('Dream Worlds', 'DOMAIN_CANONICAL_EXISTING', 'dreamWorldsService', { publicEntrypoints: ['dream worlds preview'], ledgerAudit: 'dream worlds audit' }),
    domain('Recruitment', 'DOMAIN_CANONICAL_EXISTING', 'recruitmentService', { publicEntrypoints: ['recruitment link'], crossDomainCalls: ['Recruitment Points'] }),
    domain('Stars', 'DOMAIN_ADAPTER_ONLY', 'captainsSeasonStarsService', { deferredGaps: ['product-owned season rules'] }),
    domain('Onboarding', 'DOMAIN_ADAPTER_ONLY', 'onboardingService', { deferredGaps: ['product-owned launch sequencing'] }),
    domain('Future Character', 'PRODUCT_DECISION_REQUIRED', 'preResetCharacterService', { publicEntrypoints: ['/pre-reset/future-character'], kernelStatus: 'pre-reset policy gated', deferredGaps: ['D-01..D-09 approval'] }),
    domain('Reset Conversion', 'PRODUCT_DECISION_REQUIRED', 'returnPointConversionService', { publicEntrypoints: ['/pre-reset/conversion'], ledgerAudit: 'conversion idempotency', kernelStatus: 'pre-reset policy gated', deferredGaps: ['D-01..D-09 approval'] }),
    domain('Reset Shop', 'PRODUCT_DECISION_REQUIRED', 'preResetShopService', { publicEntrypoints: ['/pre-reset/shop'], ledgerAudit: 'purchase and entitlement records', kernelStatus: 'pre-reset policy gated', deferredGaps: ['D-01..D-09 approval'] }),
    domain('Admin-facing orchestration', 'DOMAIN_BOUNDARY_CONVERGED', 'adminOperationRegistry', { publicEntrypoints: ['admin API'], readers: ['adminOperationContract', 'integratedAccessContextService'], ledgerAudit: 'admin operation audit', kernelStatus: 'operation kernel' }),
]);

function auditDomainBoundaries() {
    const invalid = DOMAIN_BOUNDARIES.filter((entry) => REQUIRED_FIELDS.some((field) => entry[field] === undefined));
    return Object.freeze({ total: DOMAIN_BOUNDARIES.length, invalid: invalid.map((entry) => entry.domain), p0p1Gaps: DOMAIN_BOUNDARIES.flatMap((entry) => entry.p0p1Gaps.map((gap) => ({ domain: entry.domain, gap }))) });
}

module.exports = { DOMAIN_BOUNDARIES, REQUIRED_FIELDS, auditDomainBoundaries };
