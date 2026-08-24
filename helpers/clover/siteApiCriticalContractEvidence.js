'use strict';

// F7 proof is intentionally narrower than route ownership. A descriptor only
// becomes proven when a named semantic operation has a route-specific request
// contract, a checked service witness, and a successful handler capture.
const fs = require('fs');
const path = require('path');
const { matchDescriptor } = require('./httpRouteDescriptor');
const { resolveContractShape, resolveDescriptorContractShape, validateDescriptorContractPayload, validateShape } = require('./siteApiContractShapes');

const ROOT = path.resolve(__dirname, '..', '..');

function pathContract(template) {
    const required = [...String(template).matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    return Object.freeze({ required: Object.freeze(required), properties: Object.freeze(Object.fromEntries(required.map((name) => [name, 'string']))) });
}

const RAID_CORE_TARGETS = Object.freeze({
    'raid.host.revoke': Object.freeze({
        probeName: 'raid-host-revoke', contractId: 'raid-host-v1', familyId: 'raid-host-revoke-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['playerId']), properties: Object.freeze({ playerId: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/raidIdempotentHttp.js', text: "if (route.kind === 'host-revoke')" }), Object.freeze({ sourceFile: 'helpers/clover/legacyraidService.js', text: 'return { ok: true };' })]),
    }),
    'raid.host.add': Object.freeze({
        probeName: 'raid-host-add', contractId: 'raid-host-v1', familyId: 'raid-host-add-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['playerId']), properties: Object.freeze({ playerId: 'string' }) }),
        witnesses: Object.freeze([
            Object.freeze({ sourceFile: 'helpers/clover/raidIdempotentHttp.js', text: "if (route.kind === 'host')" }),
            Object.freeze({ sourceFile: 'helpers/clover/legacyraidService.js', text: 'return { ok: true, host };' }),
        ]),
    }),
    'raid.create': Object.freeze({
        probeName: 'raid-create', contractId: 'raid-create-v1', familyId: 'raid-core-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['name']), properties: Object.freeze({ name: 'string' }) }),
        witnesses: Object.freeze([
            Object.freeze({ sourceFile: 'helpers/clover/raidCoreIdempotentHttp.js', text: "if (route.kind === 'create')" }),
            Object.freeze({ sourceFile: 'helpers/clover/raidV2Service.js', text: "throw new RaidServiceError('invalid_name'" }),
        ]),
    }),
    'raid.condition.add': Object.freeze({
        probeName: 'raid-condition', contractId: 'raid-condition-add-v1', familyId: 'raid-core-condition-add-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['label']), properties: Object.freeze({ label: 'string' }) }),
        witnesses: Object.freeze([
            Object.freeze({ sourceFile: 'helpers/clover/raidCoreIdempotentHttp.js', text: "if (route.kind === 'condition-add')" }),
            Object.freeze({ sourceFile: 'helpers/clover/legacyraidService.js', text: "throw new RaidServiceError('condition_label_required'" }),
        ]),
    }),
    'raid.reward.add': Object.freeze({
        probeName: 'raid-reward', contractId: 'raid-reward-add-v1', familyId: 'raid-core-reward-add-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['rewardType', 'amount']), properties: Object.freeze({ rewardType: 'string', amount: 'number' }) }),
        witnesses: Object.freeze([
            Object.freeze({ sourceFile: 'helpers/clover/raidCoreIdempotentHttp.js', text: 'const addReward = options.addRaidReward || addRaidReward;' }),
            Object.freeze({ sourceFile: 'helpers/clover/raidFinalizationService.js', text: "throw new RaidServiceError('invalid_reward_type'" }),
        ]),
    }),
});

const ADMIN_TARGETS = Object.freeze({
    'admin.bootstrap': Object.freeze({
        probeName: 'admin-bootstrap', contractId: 'admin-bootstrap-v1', familyId: 'admin-bootstrap-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: "if (url.pathname === '/admin/bootstrap')" })]),
    }),
    'admin.operation-policies.read': Object.freeze({
        probeName: 'admin-policy-catalog', contractId: 'admin-operation-policies-v1', familyId: 'admin-policy-catalog-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupport.js', text: "requireCapability(context.access, 'operation.view');" })]),
    }),
    'admin.players.search': Object.freeze({
        probeName: 'admin-player-search', contractId: 'admin-player-search-v1', contractShapeId: 'admin-player-search-shape-v1', familyId: 'admin-player-search-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const search = options.playerSearch || searchAdminPlayers;' }), Object.freeze({ sourceFile: 'helpers/clover/adminPlayerSearchService.js', text: 'async function searchAdminPlayers(db, query, options = {})' })]),
    }),
    'admin.player.detail': Object.freeze({
        probeName: 'admin-player-detail', contractId: 'admin-player-detail-v1', contractShapeId: 'admin-player-detail-shape-v1', familyId: 'admin-player-detail-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const detailResolver = options.playerDetail || getAdminPlayerDetail;' }), Object.freeze({ sourceFile: 'helpers/clover/adminPlayerDetailService.js', text: 'async function getAdminPlayerDetail(db, playerId, options = {})' })]),
    }),
    'admin.integrity.summary': Object.freeze({
        probeName: 'admin-integrity-summary', contractId: 'admin-integrity-summary-v1', contractShapeId: 'admin-integrity-summary-shape-v1', familyId: 'admin-integrity-summary-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const integritySummary = options.integritySummary || diagnoseDatabaseIntegrity;' }), Object.freeze({ sourceFile: 'helpers/clover/databaseIntegrityService.js', text: 'async function diagnoseDatabaseIntegrity(db, options = {})' })]),
    }),
    'admin.items.list': Object.freeze({
        probeName: 'admin-items-list', contractId: 'admin-item-list-v1', contractShapeId: 'admin-item-list-shape-v1', familyId: 'admin-item-catalog-list-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminItemsReadApi.js', text: 'const listItems = options.listItems || listItemTemplatesReadOnly;' }), Object.freeze({ sourceFile: 'helpers/clover/adminItemsReadApi.js', text: 'async function listItemTemplatesReadOnly(db, options = {})' })]),
    }),
    'admin.items.detail': Object.freeze({
        probeName: 'admin-item-detail', contractId: 'admin-item-v1', contractShapeId: 'admin-item-shape-v1', familyId: 'admin-item-catalog-detail-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminItemsReadApi.js', text: 'const getItem = options.getItem || getItemTemplateReadOnly;' }), Object.freeze({ sourceFile: 'helpers/clover/adminItemsReadApi.js', text: 'async function getItemTemplateReadOnly(db, templateKey)' })]),
    }),
    'admin.rewards.list': Object.freeze({
        probeName: 'admin-rewards-list', contractId: 'admin-reward-list-v1', contractShapeId: 'admin-reward-list-shape-v1', familyId: 'admin-reward-package-list-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminRewardsReadApi.js', text: 'const listPackages = options.listPackages || listRewardPackages;' }), Object.freeze({ sourceFile: 'helpers/clover/adminRewardService.js', text: 'async function listRewardPackages(db, options = {})' })]),
    }),
    'admin.rewards.grants': Object.freeze({
        probeName: 'admin-reward-grants-list', contractId: 'admin-reward-grant-list-v1', contractShapeId: 'admin-reward-grant-list-shape-v1', familyId: 'admin-reward-grant-list-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminRewardsReadApi.js', text: 'const listGrants = options.listGrants || listRewardGrants;' }), Object.freeze({ sourceFile: 'helpers/clover/adminRewardService.js', text: 'async function listRewardGrants(db, options = {})' })]),
    }),
    'admin.rewards.detail': Object.freeze({
        probeName: 'admin-reward-detail', contractId: 'admin-reward-v1', contractShapeId: 'admin-reward-shape-v1', familyId: 'admin-reward-package-detail-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminRewardsReadApi.js', text: 'const getPackage = options.getPackage || getRewardPackage;' }), Object.freeze({ sourceFile: 'helpers/clover/adminRewardService.js', text: 'async function getRewardPackage(db, packageId, options = {})' })]),
    }),
    'admin.hooks.list': Object.freeze({
        probeName: 'admin-hooks-list', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hooks-list-shape-v2', familyId: 'admin-hook-template-list-v2',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminHooksReadApi.js', text: 'const listHooks = options.listHooks || listHookTemplates;' }), Object.freeze({ sourceFile: 'helpers/clover/adminHookService.js', text: 'async function listHookTemplates(db, options = {})' })]),
    }),
    'admin.hooks.schema': Object.freeze({
        probeName: 'admin-hooks-schema', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hooks-schema-shape-v2', familyId: 'admin-hook-v2-schema-v2',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminHooksReadApi.js', text: 'sendJson(res, 200, getHookV2Schema());' }), Object.freeze({ sourceFile: 'helpers/clover/adminHookV2Service.js', text: 'function getHookV2Schema()' })]),
    }),
    'admin.hooks.assignments': Object.freeze({
        probeName: 'admin-hook-assignments-list', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hook-assignments-list-shape-v2', familyId: 'admin-hook-assignment-list-v2',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminHooksReadApi.js', text: 'const listAssignments = options.listAssignments || listPlayerHookAssignments;' }), Object.freeze({ sourceFile: 'helpers/clover/adminHookService.js', text: 'async function listPlayerHookAssignments(db, options = {})' })]),
    }),
    'admin.hooks.detail': Object.freeze({
        probeName: 'admin-hook-detail', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hook-detail-shape-v2', familyId: 'admin-hook-template-detail-v2',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminHooksReadApi.js', text: 'const getHook = options.getHook || getHookTemplate;' }), Object.freeze({ sourceFile: 'helpers/clover/adminHookService.js', text: 'async function getHookTemplate(db, hookId, options = {})' })]),
    }),
    'admin.command-center.inbox': Object.freeze({
        probeName: 'admin-command-center-inbox', contractId: 'admin-command-center-v1', contractShapeId: 'admin-command-center-inbox-shape-v1', familyId: 'admin-command-center-inbox-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminCommandCenterHttp.js', text: 'const resolver = options.commandCenterResolver || getAdminCommandCenter;' }), Object.freeze({ sourceFile: 'helpers/clover/adminCommandCenterService.js', text: 'async function getAdminCommandCenter(db, options = {})' })]),
    }),
    'admin.command-center.history': Object.freeze({
        probeName: 'admin-command-center-history', contractId: 'admin-command-center-v1', contractShapeId: 'admin-command-center-history-shape-v1', familyId: 'admin-command-center-history-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminCommandCenterHttp.js', text: 'const resolver = options.commandHistoryResolver || getAdminUnifiedHistory;' }), Object.freeze({ sourceFile: 'helpers/clover/adminCommandCenterService.js', text: 'async function getAdminUnifiedHistory(db, options = {})' })]),
    }),
    'admin.canonical-team.read': Object.freeze({
        probeName: 'canonical-admin-team-read', contractId: 'canonical-admin-team-v1', contractShapeId: 'canonical-admin-team-read-shape-v1', familyId: 'canonical-admin-team-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamHttp.js', text: 'const list = options.listTeam' }), Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamService.js', text: 'async function listCanonicalAdminTeam(db, options = {})' })]),
    }),
    'admin.canonical-team.change.create': Object.freeze({
        probeName: 'canonical-admin-team-change-create', contractId: 'canonical-admin-team-v1', contractShapeId: 'canonical-admin-team-change-create-shape-v1', familyId: 'canonical-admin-team-change-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['targetId', 'action', 'role', 'reason']), properties: Object.freeze({ targetId: 'string', action: 'string', role: 'string', reason: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamHttp.js', text: 'const create = options.createChange' }), Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamService.js', text: 'async function createCanonicalAdminRoleChange(db, input = {}, options = {})' })]),
    }),
    'admin.canonical-team.change.read': Object.freeze({
        probeName: 'canonical-admin-team-change-read', contractId: 'canonical-admin-team-v1', contractShapeId: 'canonical-admin-team-change-read-shape-v1', familyId: 'canonical-admin-team-change-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamHttp.js', text: 'const getChange = options.getChange' }), Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamService.js', text: 'async function getCanonicalAdminRoleChange(db, code)' })]),
    }),
    'admin.canonical-team.change.apply': Object.freeze({
        probeName: 'canonical-admin-team-change-apply', contractId: 'canonical-admin-team-v1', contractShapeId: 'canonical-admin-team-change-apply-shape-v1', familyId: 'canonical-admin-team-change-apply-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamHttp.js', text: 'const apply = options.applyChange' }), Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamService.js', text: 'async function applyCanonicalAdminRoleChange(db, code, actorId, options = {})' })]),
    }),
    'admin.canonical-team.change.cancel': Object.freeze({
        probeName: 'canonical-admin-team-change-cancel', contractId: 'canonical-admin-team-v1', contractShapeId: 'canonical-admin-team-change-cancel-shape-v1', familyId: 'canonical-admin-team-change-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamHttp.js', text: 'const cancel = options.cancelChange' }), Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamService.js', text: 'async function cancelCanonicalAdminRoleChange(db, code, actorId, options = {})' })]),
    }),
    'admin.canonical-team.change.undo': Object.freeze({
        probeName: 'canonical-admin-team-change-undo', contractId: 'canonical-admin-team-v1', contractShapeId: 'canonical-admin-team-change-undo-shape-v1', familyId: 'canonical-admin-team-change-undo-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['reason']), properties: Object.freeze({ reason: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamHttp.js', text: 'const undo = options.undoChange' }), Object.freeze({ sourceFile: 'helpers/clover/canonicalAdminTeamService.js', text: 'async function undoCanonicalAdminRoleChange(' })]),
    }),
    'admin.operations.collection': Object.freeze({
        probeNames: Object.freeze(['admin-operations-list', 'admin-operation-create']), contractId: 'admin-operations-v1', contractShapeId: 'admin-operations-collection-shape-v1', familyId: 'admin-operations-collection-v1',
        body: Object.freeze({ mode: 'per-method', required: Object.freeze([]), properties: Object.freeze({}) }),
        methodContracts: Object.freeze({
            GET: Object.freeze({ contractShapeId: 'admin-operations-list-shape-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }) }),
            POST: Object.freeze({ contractShapeId: 'admin-operations-create-shape-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['title', 'reason', 'targets', 'actions']), properties: Object.freeze({ title: 'string', reason: 'string', targets: 'array', actions: 'array' }) }) }),
        }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const createOperation = options.operationCreate || createAdminOperation;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationServiceBase.js', text: 'async function createAdminOperation(db, input, actor, options = {})' })]),
    }),
    'admin.operation.detail': Object.freeze({
        probeName: 'admin-operation-detail', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-detail-shape-v1', familyId: 'admin-operation-detail-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const getOperation = options.operationGet || getOperationByCode;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationServiceBase.js', text: 'async function getOperationByCode(db, code, options = {})' })]),
    }),
    'admin.operation.simulate': Object.freeze({
        probeName: 'admin-operation-simulate', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-simulate-shape-v1', familyId: 'admin-operation-simulate-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const simulate = options.operationSimulate || simulateAdminOperation;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationServiceBase.js', text: 'async function simulateAdminOperation(db, code, actor, options = {})' })]),
    }),
    'admin.operation.approve': Object.freeze({
        probeName: 'admin-operation-approve', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-approve-shape-v1', familyId: 'admin-operation-approve-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const approve = options.operationApprove || approveAdminOperation;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationServiceBase.js', text: 'async function approveAdminOperation(db, code, actor)' })]),
    }),
    'admin.operation.apply': Object.freeze({
        probeName: 'admin-operation-apply', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-apply-shape-v1', familyId: 'admin-operation-apply-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const apply = options.operationApply || applyAdminOperation;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationServiceBase.js', text: 'async function applyAdminOperation(db, code, actor, options = {})' })]),
    }),
    'admin.operation.undo': Object.freeze({
        probeName: 'admin-operation-undo', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-undo-shape-v1', familyId: 'admin-operation-undo-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['reason']), properties: Object.freeze({ reason: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const undo = options.operationUndo || undoAdminOperation;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationServiceBase.js', text: 'async function undoAdminOperation(db, code, actor, options = {})' })]),
    }),
    'admin.operation.recovery': Object.freeze({
        probeName: 'admin-operation-recovery-retry', contractId: 'admin-operation-recovery-v1', contractShapeId: 'admin-operation-recovery-retry-shape-v1', familyId: 'admin-operation-recovery-retry-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupport.js', text: 'const retry = options.operationRetry || retryAdminOperation;' }), Object.freeze({ sourceFile: 'helpers/clover/adminOperationRecoveryServiceBase.js', text: 'async function retryAdminOperation(db, code, actor, options = {})' })]),
    }),
    'admin.traits.collection': Object.freeze({
        probeName: 'admin-traits-list', contractId: 'admin-traits-v1', contractShapeId: 'admin-traits-list-shape-v1', familyId: 'admin-trait-catalog-list-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const traitList = options.traitList || listTraitTemplates;' }), Object.freeze({ sourceFile: 'helpers/clover/adminTraitService.js', text: 'async function listTraitTemplates(db, options = {})' })]),
    }),
    'admin.trait.detail': Object.freeze({
        probeName: 'admin-trait-detail', contractId: 'admin-trait-v1', contractShapeId: 'admin-trait-detail-shape-v1', familyId: 'admin-trait-catalog-detail-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminApiSupportBase.js', text: 'const traitGet = options.traitGet || getTraitTemplate;' }), Object.freeze({ sourceFile: 'helpers/clover/adminTraitService.js', text: 'async function getTraitTemplate(db, traitId, options = {})' })]),
    }),
    'admin.skill-approvals.list': Object.freeze({
        probeName: 'admin-skill-approvals-list', contractId: 'skill-approval-list-v1', contractShapeId: 'admin-skill-approval-list-shape-v1', familyId: 'admin-skill-approval-list-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/skillApprovalHttp.js', text: 'const requests=await (options.listSkillApprovals || listSkillApprovalRequests)' }), Object.freeze({ sourceFile: 'helpers/clover/skillApprovalService.js', text: "async function listSkillApprovalRequests(db, { status = 'pending', limit = 200 } = {})" })]),
    }),
    'admin.skill-approvals.approve': Object.freeze({
        probeName: 'admin-skill-approval-approve', contractId: 'skill-approval-v1', contractShapeId: 'admin-skill-approval-approve-shape-v1', familyId: 'admin-skill-approval-approve-v1',
        body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ reason: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/skillApprovalHttp.js', text: "route.decision==='approve'?(options.approveSkillApproval || approveSkillApproval)" }), Object.freeze({ sourceFile: 'helpers/clover/skillApprovalService.js', text: 'async function approveSkillApproval(db, requestRef, actorId, reason = null)' })]),
    }),
    'admin.skill-approvals.reject': Object.freeze({
        probeName: 'admin-skill-approval-reject', contractId: 'skill-approval-v1', contractShapeId: 'admin-skill-approval-reject-shape-v1', familyId: 'admin-skill-approval-reject-v1',
        body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ reason: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/skillApprovalHttp.js', text: "route.decision==='approve'?(options.approveSkillApproval || approveSkillApproval):(options.rejectSkillApproval || rejectSkillApproval)" }), Object.freeze({ sourceFile: 'helpers/clover/skillApprovalService.js', text: 'async function rejectSkillApproval(db, requestRef, actorId, reason = null)' })]),
    }),
    'admin.raid-reward-proposals.list': Object.freeze({
        probeName: 'admin-raid-reward-proposals-list', contractId: 'admin-raid-reward-proposal-list-v1', contractShapeId: 'admin-raid-reward-proposal-list-shape-v1', familyId: 'admin-raid-reward-proposal-list-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/adminRaidRewardReviewReadHttp.js', text: 'const list = options.listProposals || listReviewProposals;' }), Object.freeze({ sourceFile: 'helpers/clover/adminRaidRewardReviewReadHttp.js', text: 'async function listReviewProposals(db, actorId, status)' })]),
    }),
    'admin.dream-worlds.list': Object.freeze({ probeName: 'admin-dream-worlds-list', contractId: 'admin-dream-world-list-v1', contractShapeId: 'admin-dream-world-list-shape-v1', familyId: 'admin-dream-world-list-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'async function listAdminWorlds(db, url)' })]) }),
    'admin.dream-worlds.create': Object.freeze({ probeName: 'admin-dream-world-create', contractId: 'admin-dream-world-v1', contractShapeId: 'admin-dream-world-create-shape-v1', familyId: 'admin-dream-world-create-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['name', 'universe', 'synopsis', 'dreamType', 'rank', 'status', 'yullsPrice', 'manualPaymentEnabled', 'manualPriceLabel', 'minPlayers', 'maxPlayers', 'slots']), properties: Object.freeze({ name: 'string', universe: 'string', synopsis: 'string', dreamType: 'string', rank: 'string', status: 'string', yullsPrice: 'number', manualPaymentEnabled: 'boolean', manualPriceLabel: 'string', minPlayers: 'number', maxPlayers: 'number', slots: 'object' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'const world = await createDreamWorld(db, body, admin.auth.player.id);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function createDreamWorld(db, input, actorId)' })]) }),
    'admin.dream-worlds.acquisition.update': Object.freeze({ probeName: 'admin-dream-world-acquisition', contractId: 'admin-dream-world-v1', contractShapeId: 'admin-dream-world-acquisition-shape-v1', familyId: 'admin-dream-world-acquisition-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['yullsPrice', 'manualPaymentEnabled', 'manualPriceLabel', 'reason']), properties: Object.freeze({ yullsPrice: 'number', manualPaymentEnabled: 'boolean', manualPriceLabel: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'const world = await updateDreamWorldAcquisition(db, adminRoute.world, admin.auth.player.id' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function updateDreamWorldAcquisition(db, worldInput, actorId, input = {})' })]) }),
    'admin.dream-worlds.status.transition': Object.freeze({ probeName: 'admin-dream-world-status', contractId: 'admin-dream-world-v1', contractShapeId: 'admin-dream-world-status-shape-v1', familyId: 'admin-dream-world-status-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['status']), properties: Object.freeze({ status: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'const world = await transitionDreamWorldStatus(db, adminRoute.world, admin.auth.player.id' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function transitionDreamWorldStatus(db, worldInput, actorId, input = {})' })]) }),
    'admin.dream-worlds.fragments.list': Object.freeze({ probeName: 'admin-dream-fragments-list', contractId: 'admin-dream-fragment-list-v1', contractShapeId: 'admin-dream-fragment-list-shape-v1', familyId: 'admin-dream-fragment-list-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: 'const fragments = await listAdminFragments(db, {' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function listAdminFragments(db, options = {})' })]) }),
    'admin.dream-worlds.fragments.create': Object.freeze({ probeName: 'admin-dream-fragment-create', contractId: 'admin-dream-fragment-v1', contractShapeId: 'admin-dream-fragment-create-shape-v1', familyId: 'admin-dream-fragment-create-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['name', 'category', 'publicDescription', 'status', 'publicVisible']), properties: Object.freeze({ name: 'string', category: 'string', publicDescription: 'string', status: 'string', publicVisible: 'boolean' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: 'const fragment = await createResonanceFragment(db, body, admin.auth.player.id);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function createResonanceFragment(db, input, actorId)' })]) }),
    'admin.dream-worlds.fragments.update': Object.freeze({ probeName: 'admin-dream-fragment-update', contractId: 'admin-dream-fragment-v1', contractShapeId: 'admin-dream-fragment-update-shape-v1', familyId: 'admin-dream-fragment-update-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['status', 'reason']), properties: Object.freeze({ status: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: ': await updateResonanceFragment(db, adminRoute.fragment, body, admin.auth.player.id);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function updateResonanceFragment(db, fragmentInput, input, actorId)' })]) }),
    'admin.dream-worlds.fragments.grant': Object.freeze({ probeName: 'admin-dream-fragment-grant', contractId: 'admin-dream-fragment-v1', contractShapeId: 'admin-dream-fragment-grant-shape-v1', familyId: 'admin-dream-fragment-grant-v1', body: Object.freeze({ mode: 'required', required: Object.freeze(['playerId', 'status', 'reason']), properties: Object.freeze({ playerId: 'string', status: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: '? await grantResonanceFragment(' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function grantResonanceFragment(db, fragmentInput, playerId, actorId, input = {})' })]) }),
    'admin.dream-worlds.requests': Object.freeze({ probeName: 'admin-dream-requests-list', contractId: 'admin-dream-request-list-v1', contractShapeId: 'admin-dream-request-list-shape-v1', familyId: 'admin-dream-request-list-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: "await requireAdmin(db, req, ['raid.view']);" }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'const requests = await listAdminRequests(db, url);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'async function listAdminRequests(db, url)' })]) }),
    'admin.dream-worlds.request.approve': Object.freeze({ probeName: 'admin-dream-request-approve', contractId: 'admin-dream-request-v1', contractShapeId: 'admin-dream-request-approve-shape-v1', familyId: 'admin-dream-request-approve-v1', body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ narratorIds: 'array', adminNote: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: "requireAdmin(db, req, ['raid.manage', 'resource.adjust'])" }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'runEconomyMutationExclusive(' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function approveDreamRequest(db, requestId, actorId, input = {})' })]) }),
    'admin.dream-worlds.request.reject': Object.freeze({ probeName: 'admin-dream-request-reject', contractId: 'admin-dream-request-v1', contractShapeId: 'admin-dream-request-reject-shape-v1', familyId: 'admin-dream-request-reject-v1', body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ adminNote: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: "const admin = await requireAdmin(db, req, ['raid.manage']);" }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'const request = await rejectDreamRequest(db, adminRoute.requestId, admin.auth.player.id, body);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function rejectDreamRequest(db, requestId, actorId, input = {})' })]) }),
    'admin.dream-worlds.applications': Object.freeze({ probeName: 'admin-dream-applications-list', contractId: 'admin-dream-application-list-v1', contractShapeId: 'admin-dream-application-list-shape-v1', familyId: 'admin-dream-application-list-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'const applications = await listAdminDreamApplications(db, {' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function listAdminDreamApplications(db, options = {})' })]) }),
    'admin.dream-worlds.application.review': Object.freeze({ probeName: 'admin-dream-application-review', contractId: 'admin-dream-application-v1', contractShapeId: 'admin-dream-application-review-shape-v1', familyId: 'admin-dream-application-review-v1', body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ adminNote: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'application = await reviewDreamApplication(db, adminRoute.application, admin.auth.player.id, body);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function reviewDreamApplication(db, applicationInput, actorId, input = {})' })]) }),
    'admin.dream-worlds.application.select': Object.freeze({ probeName: 'admin-dream-application-select', contractId: 'admin-dream-application-v1', contractShapeId: 'admin-dream-application-select-shape-v1', familyId: 'admin-dream-application-select-v1', body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ mode: 'string', adminNote: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'application = await selectDreamApplication(db, adminRoute.application, admin.auth.player.id, body);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function selectDreamApplication(db, applicationInput, actorId, input = {})' })]) }),
    'admin.dream-worlds.application.reject': Object.freeze({ probeName: 'admin-dream-application-reject', contractId: 'admin-dream-application-v1', contractShapeId: 'admin-dream-application-reject-shape-v1', familyId: 'admin-dream-application-reject-v1', body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ adminNote: 'string', reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsHttp.js', text: 'application = await rejectDreamApplication(db, adminRoute.application, admin.auth.player.id, body);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsService.js', text: 'async function rejectDreamApplication(db, applicationInput, actorId, input = {})' })]) }),
    'admin.dream-worlds.runs.list': Object.freeze({ probeName: 'admin-dream-runs-list', contractId: 'admin-dream-run-list-v1', contractShapeId: 'admin-dream-run-list-shape-v1', familyId: 'admin-dream-run-list-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: 'const runs = await listAdminDreamRuns(db, { status: url.searchParams.get(\'status\') });' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function listAdminDreamRuns(db, options = {})' })]) }),
    'admin.dream-worlds.runs.detail': Object.freeze({ probeName: 'admin-dream-run-detail', contractId: 'admin-dream-run-v1', contractShapeId: 'admin-dream-run-detail-shape-v1', familyId: 'admin-dream-run-detail-v1', body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: 'const run = await getDreamRun(db, adminRoute.run);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function getDreamRun(db, runInput)' })]) }),
    ...Object.fromEntries(['invite', 'confirm', 'remove', 'replace'].map((action) => [`admin.dream-worlds.slot.${action}`, Object.freeze({ probeName: `admin-dream-slot-${action}`, contractId: 'admin-dream-run-v1', contractShapeId: `admin-dream-slot-${action}-shape-v1`, familyId: `admin-dream-slot-${action}-v1`, body: Object.freeze(action === 'remove' ? { mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ reason: 'string' }) } : action === 'replace' ? { mode: 'required', required: Object.freeze(['playerId']), properties: Object.freeze({ playerId: 'string', mode: 'string' }) } : { mode: 'required', required: Object.freeze(['playerId']), properties: Object.freeze({ playerId: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: "const admin = await requireAdmin(db, req, ['raid.manage']);" }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: action === 'remove' ? 'run = await removeDreamSlot(db, adminRoute.run, adminRoute.slotId, admin.auth.player.id, body);' : action === 'replace' ? 'run = await replaceDreamSlotWithPolicy(' : 'run = await assignDreamSlotWithPolicy(' }), Object.freeze({ sourceFile: action === 'invite' || action === 'confirm' || action === 'replace' ? 'helpers/clover/dreamWorldsSlotPolicyService.js' : 'helpers/clover/dreamWorldsOperationsService.js', text: action === 'invite' || action === 'confirm' ? 'async function assignDreamSlotWithPolicy(db, runInput, slotId, playerId, actorId, input = {})' : action === 'replace' ? 'async function replaceDreamSlotWithPolicy(db, runInput, slotId, playerId, actorId, input = {})' : 'async function removeDreamSlot(db, runInput, slotId, actorId, input = {})' })]) })])),
    ...Object.fromEntries(['start', 'advance', 'pause', 'resume', 'complete', 'fail', 'cancel'].map((action) => [`admin.dream-worlds.run.${action}`, Object.freeze({ probeName: `admin-dream-run-${action}`, contractId: 'admin-dream-run-v1', contractShapeId: `admin-dream-run-${action}-shape-v1`, familyId: `admin-dream-run-${action}-v1`, body: Object.freeze(action === 'start' ? { mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) } : action === 'advance' ? { mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ chapter: 'number' }) } : { mode: 'optional', required: Object.freeze([]), properties: Object.freeze({ reason: 'string' }) }), witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', text: 'const run = await transitionDreamRun(db, adminRoute.run, adminRoute.action, admin.auth.player.id, body);' }), Object.freeze({ sourceFile: 'helpers/clover/dreamWorldsOperationsService.js', text: 'async function transitionDreamRun(db, runInput, action, actorId, input = {})' })]) })])),
});

const BASE_ECONOMY_TARGETS = Object.freeze({
    'site.routeAuthed.post.economy.payments.preview': Object.freeze({
        probeNames: Object.freeze(['economy-payment-preview']), contractId: 'site-economy-payments-preview-v1', contractShapeId: 'site-economy-payments-preview-shape-v1', familyId: 'economy-payment-intent-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['recipientId', 'amount', 'reason']), properties: Object.freeze({ recipientId: 'string', amount: 'number', reason: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'payments' && parts[2] === 'preview'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function previewPayment(db, senderId, recipientId, amount, reason, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.payments.key.confirm': Object.freeze({
        probeNames: Object.freeze(['economy-payment-confirm']), contractId: 'site-economy-payments-key-confirm-v1', contractShapeId: 'site-economy-payments-confirm-shape-v1', familyId: 'economy-payment-confirm-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] && parts[3] === 'confirm'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function confirmPayment(db, senderId, paymentKey)' })]),
    }),
    'site.routeAuthed.post.economy.payments.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-payment-cancel']), contractId: 'site-economy-payments-key-cancel-v1', contractShapeId: 'site-economy-payments-cancel-shape-v1', familyId: 'economy-payment-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] && parts[3] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function cancelPayment(db, senderId, paymentKey)' })]),
    }),
    'site.routeAuthed.post.economy.market.listings': Object.freeze({
        probeNames: Object.freeze(['economy-market-listing-create']), contractId: 'site-economy-market-listings-v1', contractShapeId: 'site-economy-market-listings-create-shape-v1', familyId: 'economy-market-listing-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['inventoryItemId', 'unitPrice']), properties: Object.freeze({ inventoryItemId: 'number', unitPrice: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'market' && parts[2] === 'listings' && parts.length === 3" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function createMarketListing(db, sellerId, input = {}, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.market.listings.preview': Object.freeze({
        probeNames: Object.freeze(['economy-market-listing-preview']), contractId: 'site-economy-market-listings-preview-v1', contractShapeId: 'site-economy-market-listings-preview-shape-v1', familyId: 'economy-market-listing-quote-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['inventoryItemId', 'unitPrice']), properties: Object.freeze({ inventoryItemId: 'number', unitPrice: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] === 'listings' && parts[3] === 'preview'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function quoteMarketListing(db, sellerId, input = {}, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.market.listings.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-market-listing-cancel']), contractId: 'site-economy-market-listings-key-cancel-v1', contractShapeId: 'site-economy-market-listings-cancel-shape-v1', familyId: 'economy-market-listing-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] === 'listings' && parts[3] && parts[4] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function cancelMarketListing(db, sellerId, listingKey)' })]),
    }),
    'site.routeAuthed.post.economy.market.purchases.preview': Object.freeze({
        probeNames: Object.freeze(['economy-market-purchase-preview']), contractId: 'site-economy-market-purchases-preview-v1', contractShapeId: 'site-economy-market-purchases-preview-shape-v1', familyId: 'economy-market-purchase-intent-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['listingKey']), properties: Object.freeze({ listingKey: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] === 'purchases' && parts[3] === 'preview'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function previewMarketPurchase(db, buyerId, listingKey, quantity = 1, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.market.purchases.key.confirm': Object.freeze({
        probeNames: Object.freeze(['economy-market-purchase-confirm']), contractId: 'site-economy-market-purchases-key-confirm-v1', contractShapeId: 'site-economy-market-purchases-confirm-shape-v1', familyId: 'economy-market-purchase-confirm-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] === 'purchases' && parts[3] && parts[4] === 'confirm'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function confirmMarketPurchase(db, buyerId, intentKey)' })]),
    }),
    'site.routeAuthed.post.economy.market.purchases.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-market-purchase-cancel']), contractId: 'site-economy-market-purchases-key-cancel-v1', contractShapeId: 'site-economy-market-purchases-cancel-shape-v1', familyId: 'economy-market-purchase-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] === 'purchases' && parts[3] && parts[4] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function cancelMarketPurchase(db, buyerId, intentKey)' })]),
    }),
    'site.routeAuthed.post.economy.market.auctions.key.bids': Object.freeze({
        probeNames: Object.freeze(['economy-market-auction-bid']), contractId: 'site-economy-market-auctions-key-bids-v1', contractShapeId: 'site-economy-market-auctions-bid-shape-v1', familyId: 'economy-market-auction-bid-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['amount']), properties: Object.freeze({ amount: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[2] === 'auctions' && parts[3] && parts[4] === 'bids'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function placeAuctionBid(db, bidderId, listingKey, amount, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.trades': Object.freeze({
        probeNames: Object.freeze(['economy-trade-create']), contractId: 'site-economy-trades-v1', contractShapeId: 'site-economy-trades-create-shape-v1', familyId: 'economy-secure-trade-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['targetId', 'creatorItems']), properties: Object.freeze({ targetId: 'string', creatorItems: 'array' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'trades' && parts.length === 2" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function createSecureTrade(db, creatorId, targetId, input = {}, options = {})' })]),
    }),
    'site.routeAuthed.patch.economy.trades.key': Object.freeze({
        probeNames: Object.freeze(['economy-trade-update']), contractId: 'site-economy-trades-key-v1', contractShapeId: 'site-economy-trades-update-shape-v1', familyId: 'economy-secure-trade-update-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['items', 'yulls']), properties: Object.freeze({ items: 'array', yulls: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "method === 'PATCH' && parts[0] === 'economy' && parts[1] === 'trades'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function updateTradeSide(db, actorId, tradeKey, input = {})' })]),
    }),
    'site.routeAuthed.post.economy.trades.key.confirm': Object.freeze({
        probeNames: Object.freeze(['economy-trade-confirm-first', 'economy-trade-confirm-final']), contractId: 'site-economy-trades-key-confirm-v1', contractShapeId: 'site-economy-trades-confirm-shape-v1', familyId: 'economy-secure-trade-confirm-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'trades' && parts[2] && parts[3] === 'confirm'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function confirmSecureTrade(db, actorId, tradeKey)' })]),
    }),
    'site.routeAuthed.post.economy.trades.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-trade-cancel']), contractId: 'site-economy-trades-key-cancel-v1', contractShapeId: 'site-economy-trades-cancel-shape-v1', familyId: 'economy-secure-trade-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'trades' && parts[2] && parts[3] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function cancelSecureTrade(db, actorId, tradeKey)' })]),
    }),
    'site.routeAuthed.post.economy.weekly-requests': Object.freeze({
        probeNames: Object.freeze(['economy-weekly-request-create']), contractId: 'site-economy-weekly-requests-v1', contractShapeId: 'site-economy-weekly-requests-create-shape-v1', familyId: 'economy-weekly-request-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['templateKey']), properties: Object.freeze({ templateKey: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'weekly-requests' && parts.length === 2" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function createWeeklyNpcRequest(db, actorId, input = {}, options = {})' })]),
    }),
    'site.routeAuthed.patch.economy.weekly-requests.key': Object.freeze({
        probeNames: Object.freeze(['economy-weekly-request-update']), contractId: 'site-economy-weekly-requests-key-v1', contractShapeId: 'site-economy-weekly-requests-update-shape-v1', familyId: 'economy-weekly-request-update-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['pricePercent']), properties: Object.freeze({ pricePercent: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "method === 'PATCH' && parts[0] === 'economy' && parts[1] === 'weekly-requests'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function updateWeeklyNpcRequest(db, actorId, requestKey, input = {})' })]),
    }),
    'site.routeAuthed.post.economy.weekly-requests.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-weekly-request-cancel']), contractId: 'site-economy-weekly-requests-key-cancel-v1', contractShapeId: 'site-economy-weekly-requests-cancel-shape-v1', familyId: 'economy-weekly-request-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'weekly-requests' && parts[2] && parts[3] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function cancelWeeklyNpcRequest(db, actorId, requestKey)' })]),
    }),
    'site.routeAuthed.post.economy.weekly-requests.key.deliver': Object.freeze({
        probeNames: Object.freeze(['economy-weekly-request-deliver']), contractId: 'site-economy-weekly-requests-key-deliver-v1', contractShapeId: 'site-economy-weekly-requests-deliver-shape-v1', familyId: 'economy-weekly-request-deliver-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['inventoryItemId']), properties: Object.freeze({ inventoryItemId: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'weekly-requests' && parts[2] && parts[3] === 'deliver'" }), Object.freeze({ sourceFile: 'helpers/clover/marketService.js', text: 'async function fulfillWeeklyNpcRequest(db, playerId, requestKey, inventoryItemId, quantity = 1, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.item-templates': Object.freeze({
        probeNames: Object.freeze(['economy-item-template-create']), contractId: 'site-economy-item-templates-v1', contractShapeId: 'site-economy-item-templates-create-shape-v1', familyId: 'economy-item-template-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['templateKey', 'itemName', 'description']), properties: Object.freeze({ templateKey: 'string', itemName: 'string', description: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'item-templates' && parts.length === 2" }), Object.freeze({ sourceFile: 'helpers/clover/itemAdminService.js', text: 'async function createItemTemplate(db, actorId, input = {})' })]),
    }),
    'site.routeAuthed.patch.economy.item-templates.key': Object.freeze({
        probeNames: Object.freeze(['economy-item-template-update']), contractId: 'site-economy-item-templates-key-v1', contractShapeId: 'site-economy-item-templates-update-shape-v1', familyId: 'economy-item-template-update-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['basePrice']), properties: Object.freeze({ basePrice: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "method === 'PATCH' && parts[0] === 'economy' && parts[1] === 'item-templates'" }), Object.freeze({ sourceFile: 'helpers/clover/itemAdminService.js', text: 'async function updateItemTemplate(db, actorId, templateKey, input = {})' })]),
    }),
    'site.routeAuthed.post.economy.item-templates.key.archive': Object.freeze({
        probeNames: Object.freeze(['economy-item-template-archive']), contractId: 'site-economy-item-templates-key-archive-v1', contractShapeId: 'site-economy-item-templates-archive-shape-v1', familyId: 'economy-item-template-archive-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'item-templates' && parts[2] && parts[3] === 'archive'" }), Object.freeze({ sourceFile: 'helpers/clover/itemAdminService.js', text: 'async function archiveItemTemplate(db, actorId, templateKey)' })]),
    }),
    'site.routeAuthed.post.economy.item-templates.key.grant': Object.freeze({
        probeNames: Object.freeze(['economy-item-template-grant']), contractId: 'site-economy-item-templates-key-grant-v1', contractShapeId: 'site-economy-item-templates-grant-shape-v1', familyId: 'economy-item-template-grant-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['playerId', 'quantity']), properties: Object.freeze({ playerId: 'string', quantity: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'item-templates' && parts[2] && parts[3] === 'grant'" }), Object.freeze({ sourceFile: 'helpers/clover/itemAdminService.js', text: 'async function grantItemCopies(db, actorId, playerId, templateKey, quantity = 1, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.redemptions': Object.freeze({
        probeNames: Object.freeze(['economy-redemption-create-approved', 'economy-redemption-create-rejected', 'economy-redemption-create-cancelled']), contractId: 'site-economy-redemptions-v1', contractShapeId: 'site-economy-redemptions-create-shape-v1', familyId: 'economy-redemption-create-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['inventoryItemId', 'note']), properties: Object.freeze({ inventoryItemId: 'number', note: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'redemptions' && parts.length === 2" }), Object.freeze({ sourceFile: 'helpers/clover/itemRedemptionService.js', text: 'async function requestItemRedemption(db, playerId, inventoryItemId, note = null, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.redemptions.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-redemption-cancel']), contractId: 'site-economy-redemptions-key-cancel-v1', contractShapeId: 'site-economy-redemptions-cancel-shape-v1', familyId: 'economy-redemption-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'redemptions' && parts[2] && parts[3] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/itemRedemptionService.js', text: 'async function cancelItemRedemption(db, playerId, redemptionKey, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.redemptions.key.approve': Object.freeze({
        probeNames: Object.freeze(['economy-redemption-approve']), contractId: 'site-economy-redemptions-key-approve-v1', contractShapeId: 'site-economy-redemptions-resolve-shape-v1', familyId: 'economy-redemption-approve-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['note']), properties: Object.freeze({ note: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "['approve', 'reject'].includes(parts[3])" }), Object.freeze({ sourceFile: 'helpers/clover/itemRedemptionService.js', text: 'async function resolveItemRedemption(db, actorId, redemptionKey, decision, note = null)' })]),
    }),
    'site.routeAuthed.post.economy.redemptions.key.reject': Object.freeze({
        probeNames: Object.freeze(['economy-redemption-reject']), contractId: 'site-economy-redemptions-key-reject-v1', contractShapeId: 'site-economy-redemptions-resolve-shape-v1', familyId: 'economy-redemption-reject-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['note']), properties: Object.freeze({ note: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "['approve', 'reject'].includes(parts[3])" }), Object.freeze({ sourceFile: 'helpers/clover/itemRedemptionService.js', text: 'async function resolveItemRedemption(db, actorId, redemptionKey, decision, note = null)' })]),
    }),
    'site.routeAuthed.post.economy.titles.deactivate': Object.freeze({
        probeNames: Object.freeze(['economy-title-deactivate']), contractId: 'site-economy-titles-deactivate-v1', contractShapeId: 'site-economy-titles-deactivate-shape-v1', familyId: 'economy-title-deactivate-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'titles' && parts[2] === 'deactivate'" }), Object.freeze({ sourceFile: 'helpers/clover/titleService.js', text: 'async function deactivatePlayerTitle(db, playerId, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.titles.key.activate': Object.freeze({
        probeNames: Object.freeze(['economy-title-activate']), contractId: 'site-economy-titles-key-activate-v1', contractShapeId: 'site-economy-titles-activate-shape-v1', familyId: 'economy-title-activate-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'titles' && parts[2] && parts[3] === 'activate'" }), Object.freeze({ sourceFile: 'helpers/clover/titleService.js', text: 'async function activatePlayerTitle(db, playerId, titleRef, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.initial-package': Object.freeze({
        probeNames: Object.freeze(['economy-initial-package']), contractId: 'site-economy-initial-package-v1', contractShapeId: 'site-economy-initial-package-shape-v1', familyId: 'economy-initial-package-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['equipmentTemplateKey']), properties: Object.freeze({ equipmentTemplateKey: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'initial-package'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function grantInitialPackage(db, playerId, equipmentTemplateKey, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.purchases.preview': Object.freeze({
        probeNames: Object.freeze(['economy-purchase-preview-confirm', 'economy-purchase-preview-cancel']), contractId: 'site-economy-purchases-preview-v1', contractShapeId: 'site-economy-purchases-preview-shape-v1', familyId: 'economy-purchase-preview-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['listingKey', 'quantity']), properties: Object.freeze({ listingKey: 'string', quantity: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'purchases' && parts[2] === 'preview'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function previewPurchase(db, playerId, listingKey, quantity = 1, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.purchases.key.confirm': Object.freeze({
        probeNames: Object.freeze(['economy-purchase-confirm']), contractId: 'site-economy-purchases-key-confirm-v1', contractShapeId: 'site-economy-purchases-confirm-shape-v1', familyId: 'economy-purchase-confirm-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'purchases' && parts[2] && parts[3] === 'confirm'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function confirmPurchase(db, playerId, intentKey, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.purchases.key.cancel': Object.freeze({
        probeNames: Object.freeze(['economy-purchase-cancel']), contractId: 'site-economy-purchases-key-cancel-v1', contractShapeId: 'site-economy-purchases-cancel-shape-v1', familyId: 'economy-purchase-cancel-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'purchases' && parts[2] && parts[3] === 'cancel'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function cancelPurchase(db, playerId, intentKey, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.sales.preview': Object.freeze({
        probeNames: Object.freeze(['economy-sale-preview']), contractId: 'site-economy-sales-preview-v1', contractShapeId: 'site-economy-sales-preview-shape-v1', familyId: 'economy-sale-preview-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['inventoryItemId', 'quantity']), properties: Object.freeze({ inventoryItemId: 'number', quantity: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'sales' && parts[2] === 'preview'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function previewNpcSale(db, playerId, inventoryItemId, quantity = 1, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.sales.key.confirm': Object.freeze({
        probeNames: Object.freeze(['economy-sale-confirm']), contractId: 'site-economy-sales-key-confirm-v1', contractShapeId: 'site-economy-sales-confirm-shape-v1', familyId: 'economy-sale-confirm-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'sales' && parts[2] && parts[3] === 'confirm'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function confirmNpcSale(db, playerId, intentKey)' })]),
    }),
    'site.routeAuthed.post.economy.repairs.preview': Object.freeze({
        probeNames: Object.freeze(['economy-repair-preview']), contractId: 'site-economy-repairs-preview-v1', contractShapeId: 'site-economy-repairs-preview-shape-v1', familyId: 'economy-repair-preview-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['inventoryItemId']), properties: Object.freeze({ inventoryItemId: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'repairs' && parts[2] === 'preview'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function previewRepair(db, playerId, inventoryItemId, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.repairs.key.confirm': Object.freeze({
        probeNames: Object.freeze(['economy-repair-confirm']), contractId: 'site-economy-repairs-key-confirm-v1', contractShapeId: 'site-economy-repairs-confirm-shape-v1', familyId: 'economy-repair-confirm-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'repairs' && parts[2] && parts[3] === 'confirm'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function confirmRepair(db, playerId, orderKey, options = {})' })]),
    }),
    'site.routeAuthed.post.economy.consumables.itemId.use': Object.freeze({
        probeNames: Object.freeze(['economy-consumable-use']), contractId: 'site-economy-consumables-itemId-use-v1', contractShapeId: 'site-economy-consumables-use-shape-v1', familyId: 'economy-consumable-use-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['contextType']), properties: Object.freeze({ contextType: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/siteApiServerBase.js', text: "parts[1] === 'consumables' && parts[2] && parts[3] === 'use'" }), Object.freeze({ sourceFile: 'helpers/clover/economyService.js', text: 'async function useConsumable(db, playerId, inventoryItemId, options = {})' })]),
    }),
});

const PRE_RESET_TARGETS = Object.freeze({
    'prereset.future-character.read': Object.freeze({
        probeNames: Object.freeze(['prereset-future-character-read']), contractId: 'future-character-v1', contractShapeId: 'future-character-read-shape-v1', familyId: 'prereset-future-character-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'GET' && path === '/pre-reset/future-character')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetCharacterService.js', text: 'async function getFutureCharacter(db, playerId)' })]),
    }),
    'prereset.future-character.write': Object.freeze({
        probeNames: Object.freeze(['prereset-future-character-post', 'prereset-future-character-put']), contractId: 'future-character-v1', contractShapeId: 'future-character-write-shape-v1', familyId: 'prereset-future-character-write-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['expectedRevision', 'draft']), properties: Object.freeze({ expectedRevision: 'number', draft: 'object' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if ((method === 'POST' || method === 'PUT') && path === '/pre-reset/future-character')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetCharacterService.js', text: 'const expectedRevision = positiveRevision(request.expectedRevision);' }), Object.freeze({ sourceFile: 'helpers/clover/preResetCharacterService.js', text: 'const draft = normalizeFutureDraft(request.draft' })]),
    }),
    'prereset.future-character.submit': Object.freeze({
        probeNames: Object.freeze(['prereset-future-character-submit']), contractId: 'future-character-v1', contractShapeId: 'future-character-submit-shape-v1', familyId: 'prereset-future-character-submit-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['expectedRevision', 'draft']), properties: Object.freeze({ expectedRevision: 'number', draft: 'object' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'POST' && path === '/pre-reset/future-character/submit')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "operationType: 'submit'" })]),
    }),
    'prereset.return-points.balance': Object.freeze({
        probeNames: Object.freeze(['prereset-return-points-balance']), contractId: 'return-points-balance-v1', contractShapeId: 'return-points-balance-v1', familyId: 'prereset-return-points-balance-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'GET' && path === '/pre-reset/return-points/balance')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: 'getReturnPointsLedger(db, auth.player.id)' })]),
    }),
    'prereset.conversion.read': Object.freeze({
        probeNames: Object.freeze(['prereset-conversion-read']), contractId: 'conversion-v1', contractShapeId: 'conversion-read-shape-v1', familyId: 'prereset-conversion-read-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'GET' && path === '/pre-reset/conversion')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: 'previewReturnPointConversion(db, auth.player.id, { policy })' })]),
    }),
    'prereset.conversion.claim': Object.freeze({
        probeNames: Object.freeze(['prereset-conversion-claim']), contractId: 'conversion-v1', contractShapeId: 'conversion-claim-shape-v1', familyId: 'prereset-conversion-claim-v1',
        body: Object.freeze({ mode: 'optional', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'POST' && path === '/pre-reset/conversion/claim')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "requireEnabledPolicy(registry, 'PH_RETURN_CONVERSION')" })]),
    }),
    'prereset.shop.catalog': Object.freeze({
        probeNames: Object.freeze(['prereset-shop-catalog']), contractId: 'reset-shop-catalog-v1', contractShapeId: 'reset-shop-catalog-v1', familyId: 'prereset-shop-catalog-v1',
        body: Object.freeze({ mode: 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'GET' && path === '/pre-reset/shop/catalog')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: 'items: policy.enabled ? policy.products.map(serializeCatalogItem) : []' })]),
    }),
    'prereset.shop.purchase': Object.freeze({
        probeNames: Object.freeze(['prereset-shop-purchase']), contractId: 'reset-shop-purchase-v1', contractShapeId: 'reset-shop-purchase-v1', familyId: 'prereset-shop-purchase-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['itemKey']), properties: Object.freeze({ itemKey: 'string' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'POST' && path === '/pre-reset/shop/purchase')" }), Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: 'itemKey: body.itemKey' })]),
    }),
    'prereset.admin.review': Object.freeze({
        probeNames: Object.freeze(['prereset-admin-review']), contractId: 'future-character-review-v1', contractShapeId: 'future-character-review-shape-v1', familyId: 'prereset-admin-review-v1',
        body: Object.freeze({ mode: 'required', required: Object.freeze(['action', 'reason', 'expectedRevision']), properties: Object.freeze({ action: 'string', reason: 'string', expectedRevision: 'number' }) }),
        witnesses: Object.freeze([Object.freeze({ sourceFile: 'helpers/clover/preResetSiteApiService.js', text: "if (method === 'POST' && review)" }), Object.freeze({ sourceFile: 'helpers/clover/preResetCharacterService.js', text: "if (!['approve', 'lock'].includes(action))" }), Object.freeze({ sourceFile: 'helpers/clover/preResetCharacterService.js', text: "const reason = text(request.reason, 'Motivo', { required: true, limit: 500 });" })]),
    }),
});

const SEMANTIC_TARGETS = Object.freeze({ ...RAID_CORE_TARGETS, ...ADMIN_TARGETS, ...BASE_ECONOMY_TARGETS, ...PRE_RESET_TARGETS });
function semanticTarget(descriptor) { return SEMANTIC_TARGETS[descriptor.id] || null; }
function sourceWitnessesHold(witnesses) { return witnesses.every((witness) => fs.readFileSync(path.resolve(ROOT, witness.sourceFile), 'utf8').includes(witness.text)); }

function requestEvidence(descriptor, target) {
    if (!target) return null;
    return Object.freeze({ sourceFile: descriptor.sourceFile, handlerOwner: descriptor.handlerOwner, evidenceKind: 'ROUTE_AND_SERVICE_WITNESS', path: pathContract(descriptor.template), query: Object.freeze({ required: Object.freeze([]), properties: Object.freeze({}) }), body: target.body, witnesses: target.witnesses });
}
function responseEvidence(descriptor, target) {
    if (!target) return null;
    return Object.freeze({ sourceFile: descriptor.sourceFile, handlerOwner: descriptor.handlerOwner, evidenceKind: 'REAL_HANDLER_CAPTURE', captureFamily: target.familyId, probeNames: target.probeNames || Object.freeze([target.probeName]) });
}

function buildCriticalContractEvidence(descriptors, isCritical) {
    return Object.freeze(descriptors.filter(isCritical).map((descriptor) => {
        const target = semanticTarget(descriptor);
        return Object.freeze({ descriptorId: descriptor.id, contractId: descriptor.contractId, contractShapeId: descriptor.contractShapeId, familyId: target?.familyId || null, proofState: target ? 'PENDING_CAPTURE' : 'UNPROVEN', requestEvidence: requestEvidence(descriptor, target), responseEvidence: responseEvidence(descriptor, target) });
    }));
}

function pathAndMethodMatch(descriptor, capture) {
    if (!capture?.request || !descriptor.methods.includes(capture.request.method)) return false;
    const pathname = new URL(capture.request.url, 'http://localhost').pathname;
    return Boolean(matchDescriptor([descriptor], capture.request.method, pathname));
}
function sameRequestShape(shape, evidence) {
    return JSON.stringify({ required: shape?.required || [], properties: shape?.properties || {} })
        === JSON.stringify({ required: evidence?.required || [], properties: evidence?.properties || {} });
}

function captureBodyMatches(descriptor, target, capture, registry) {
    if (target.body.mode === 'none') return capture.request.body === null;
    if (target.body.mode === 'optional') return capture.request.body === null || validateDescriptorContractPayload(descriptor, 'request', capture.request.body, registry).ok;
    return validateDescriptorContractPayload(descriptor, 'request', capture.request.body, registry).ok;
}

function methodContractMatches(descriptor, target, capture, registry) {
    const methodContract = target.methodContracts?.[capture.request.method];
    if (!methodContract) return false;
    // Per-method shapes are intentionally finer-grained than the descriptor's
    // public collection shape, so they are resolved from the explicit
    // registry rather than the descriptor-only runtime registry.
    const shape = resolveContractShape(methodContract.contractShapeId);
    if (!shape || !sameRequestShape(shape.request, methodContract.body) || shape.requestMode !== methodContract.body.mode) return false;
    if (methodContract.body.mode === 'none') return capture.request.body === null && validateShape(shape.response, capture.payload).ok;
    if (methodContract.body.mode === 'optional') return (capture.request.body === null || validateShape(shape.request, capture.request.body).ok) && validateShape(shape.response, capture.payload).ok;
    return validateShape(shape.request, capture.request.body).ok && validateShape(shape.response, capture.payload).ok;
}

function validateEvidence(descriptor, entry, captures, registry) {
    const target = semanticTarget(descriptor);
    if (!target) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'semantic_family_not_captured' });
    if (!entry || entry.contractId !== target.contractId || entry.contractShapeId !== descriptor.contractShapeId || entry.familyId !== target.familyId) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'family_or_contract_misclassified' });
    const probeNames = target.probeNames || [target.probeName];
    const targetCaptures = probeNames.map((name) => captures.find((candidate) => candidate.name === name));
    if (targetCaptures.some((capture) => !capture || capture.descriptorId !== descriptor.id || capture.contractId !== descriptor.contractId || capture.contractShapeId !== target.contractShapeId || capture.semanticFamily !== target.familyId)) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'capture_not_correlated' });
    const shape = resolveDescriptorContractShape(descriptor, registry);
    if (!shape || (!target.methodContracts && (!sameRequestShape(shape.request, target.body) || shape.requestMode !== target.body.mode)) || (target.methodContracts && shape.requestMode !== 'per-method')) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'request_schema_not_independent' });
    if (targetCaptures.some((capture) => !pathAndMethodMatch(descriptor, capture))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'path_schema_mismatch' });
    if (new Set(targetCaptures.map((capture) => capture.request.method)).size !== descriptor.methods.length || descriptor.methods.some((method) => !targetCaptures.some((capture) => capture.request.method === method))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'method_coverage_mismatch' });
    if (!sourceWitnessesHold(target.witnesses)) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'service_witness_missing' });
    if (target.methodContracts && targetCaptures.some((capture) => !methodContractMatches(descriptor, target, capture, registry))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'body_mode_or_schema_mismatch' });
    if (!target.methodContracts && targetCaptures.some((capture) => !captureBodyMatches(descriptor, target, capture, registry))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'body_mode_or_schema_mismatch' });
    if (targetCaptures.some((capture) => capture.outcome !== 'MATCHED_SUCCESS' || (!target.methodContracts && !validateDescriptorContractPayload(descriptor, 'response', capture.payload, registry).ok))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'real_response_schema_mismatch' });
    return Object.freeze({ descriptorId: descriptor.id, proven: true, reason: null, captureNames: probeNames, familyId: target.familyId });
}

function auditCriticalContractEvidence(descriptors, isCritical, evidence = buildCriticalContractEvidence(descriptors, isCritical), options = {}) {
    const critical = descriptors.filter(isCritical);
    const byId = new Map(evidence.map((entry) => [entry.descriptorId, entry]));
    const validations = critical.map((descriptor) => validateEvidence(descriptor, byId.get(descriptor.id), options.captures || [], options.registry));
    const proven = validations.filter((entry) => entry.proven);
    const unproven = validations.filter((entry) => !entry.proven);
    const semantic = evidence.filter((entry) => entry.familyId);
    return Object.freeze({ total: critical.length, evidenced: proven.length, proven: proven.map((entry) => entry.descriptorId), unevidenced: unproven.map((entry) => entry.descriptorId), unproven: unproven.map((entry) => Object.freeze({ descriptorId: entry.descriptorId, reason: entry.reason })), requestFamilies: new Set(semantic.map((entry) => entry.familyId)).size, requestFamiliesEvidenced: new Set(proven.map((entry) => entry.familyId)).size, responseFamilies: new Set(semantic.map((entry) => entry.familyId)).size, responseFamiliesCaptured: new Set(proven.map((entry) => entry.familyId)).size, evidence, validations });
}

module.exports = { ADMIN_TARGETS, BASE_ECONOMY_TARGETS, PRE_RESET_TARGETS, RAID_CORE_TARGETS, SEMANTIC_TARGETS, auditCriticalContractEvidence, buildCriticalContractEvidence, pathContract, requestEvidence, responseEvidence, semanticTarget, validateEvidence };
