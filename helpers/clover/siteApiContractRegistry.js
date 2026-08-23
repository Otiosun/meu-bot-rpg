'use strict';

const { PRE_RESET_ROUTES } = require('./preResetSiteApiService');
const { RAID_CORE_ROUTES } = require('./raidCoreIdempotentHttp');
const { RAID_IDEMPOTENT_ROUTE_DESCRIPTORS } = require('./raidIdempotentHttp');
const { RAID_ATOMIC_FINALIZATION_ROUTE_DESCRIPTORS } = require('./raidAtomicFinalizationHttp');
const { RAID_FINALIZATION_REVIEW_ROUTE_DESCRIPTORS } = require('./raidFinalizationIdempotentHttp');
const { RAID_REWARD_PROPOSAL_REVIEW_ROUTE_DESCRIPTORS } = require('./raidRewardProposalIdempotentHttp');
const { ADMIN_RAID_REWARD_REVIEW_ROUTE_DESCRIPTORS } = require('./adminRaidRewardReviewReadHttp');
const { DREAM_WORLDS_ROUTE_DESCRIPTORS } = require('./dreamWorldsHttp');
const { DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS } = require('./dreamWorldsOperationsHttp');
const { SKILL_APPROVAL_ROUTE_DESCRIPTORS } = require('./skillApprovalHttp');
const {
    ADMIN_ROUTE_DESCRIPTORS,
    ADMIN_DELEGATED_ROUTE_DESCRIPTORS,
    ADMIN_HOOKS_ROUTE_DESCRIPTORS,
    ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS,
    CANONICAL_ADMIN_TEAM_ROUTE_DESCRIPTORS,
} = require('./adminApiSupport');
const {
    LEGACY_PUBLIC_ROUTES,
    LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS,
    LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS,
    LEGACY_SQUAD_ROUTE_DESCRIPTORS,
    RECRUITMENT_SHOP_ROUTE_DESCRIPTORS,
} = require('./siteApiServerLegacy');
const { SQUAD_MEMBERSHIP_TRANSFER_ROUTE_DESCRIPTORS } = require('./squadMembershipTransferHttp');

const SITE_API_CONTRACT_VERSION = 'v1';
const PUBLIC_ERROR_ENVELOPE = Object.freeze({ ok: false, error: 'stable_code', message: 'safe_message' });

function endpointFromDescriptor(descriptor) {
    return Object.freeze({
        method: descriptor.methods.join('|'),
        path: descriptor.template,
        area: descriptor.id.split('.').slice(0, 2).join('-'),
        dto: descriptor.contractId,
        auth: descriptor.authClass,
        capability: descriptor.authClass.includes(':') ? descriptor.authClass.split(':').slice(1).join(':') : null,
        requestDto: descriptor.contractId,
        responseDto: descriptor.contractId,
        errorModel: 'safe-error-envelope-v1',
        owner: descriptor.handlerOwner,
        sourceFile: descriptor.sourceFile,
        classification: descriptor.visibility,
        descriptorId: descriptor.id,
    });
}

const PRE_RESET_ENDPOINTS = Object.freeze(PRE_RESET_ROUTES.map(endpointFromDescriptor));
const ADMIN_CONCRETE_DESCRIPTORS = Object.freeze([
    ...ADMIN_ROUTE_DESCRIPTORS.filter((route) => !route.id.startsWith('admin.team.')),
    ...ADMIN_DELEGATED_ROUTE_DESCRIPTORS,
    ...ADMIN_HOOKS_ROUTE_DESCRIPTORS,
    ...ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS,
    ...CANONICAL_ADMIN_TEAM_ROUTE_DESCRIPTORS,
]);
const RUNTIME_DESCRIPTOR_GROUPS = Object.freeze([
    PRE_RESET_ROUTES, RAID_CORE_ROUTES, RAID_IDEMPOTENT_ROUTE_DESCRIPTORS,
    RAID_ATOMIC_FINALIZATION_ROUTE_DESCRIPTORS, RAID_FINALIZATION_REVIEW_ROUTE_DESCRIPTORS,
    RAID_REWARD_PROPOSAL_REVIEW_ROUTE_DESCRIPTORS, ADMIN_RAID_REWARD_REVIEW_ROUTE_DESCRIPTORS,
    DREAM_WORLDS_ROUTE_DESCRIPTORS, DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS,
    SKILL_APPROVAL_ROUTE_DESCRIPTORS, ADMIN_CONCRETE_DESCRIPTORS, LEGACY_PUBLIC_ROUTES,
    LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS, LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS,
    LEGACY_SQUAD_ROUTE_DESCRIPTORS, RECRUITMENT_SHOP_ROUTE_DESCRIPTORS,
    SQUAD_MEMBERSHIP_TRANSFER_ROUTE_DESCRIPTORS,
]);
const CRITICAL_SITE_ENDPOINTS = Object.freeze(RUNTIME_DESCRIPTOR_GROUPS.flat().map(endpointFromDescriptor));

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

module.exports = {
    ADMIN_CONCRETE_DESCRIPTORS,
    CRITICAL_SITE_ENDPOINTS,
    PRE_RESET_ENDPOINTS,
    PUBLIC_ERROR_ENVELOPE,
    RUNTIME_DESCRIPTOR_GROUPS,
    SITE_API_CONTRACT_VERSION,
    endpointFromDescriptor,
    getPublicSiteApiContract,
};
