'use strict';

// F7 proof is intentionally narrower than route ownership. A descriptor only
// becomes proven when a named semantic operation has a route-specific request
// contract, a checked service witness, and a successful handler capture.
const fs = require('fs');
const path = require('path');
const { matchDescriptor } = require('./httpRouteDescriptor');
const { resolveDescriptorContractShape, validateDescriptorContractPayload } = require('./siteApiContractShapes');

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

const SEMANTIC_TARGETS = Object.freeze({ ...RAID_CORE_TARGETS, ...ADMIN_TARGETS, ...PRE_RESET_TARGETS });
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

function validateEvidence(descriptor, entry, captures, registry) {
    const target = semanticTarget(descriptor);
    if (!target) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'semantic_family_not_captured' });
    if (!entry || entry.contractId !== target.contractId || entry.contractShapeId !== descriptor.contractShapeId || entry.familyId !== target.familyId) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'family_or_contract_misclassified' });
    const probeNames = target.probeNames || [target.probeName];
    const targetCaptures = probeNames.map((name) => captures.find((candidate) => candidate.name === name));
    if (targetCaptures.some((capture) => !capture || capture.descriptorId !== descriptor.id || capture.contractId !== descriptor.contractId || capture.contractShapeId !== target.contractShapeId || capture.semanticFamily !== target.familyId)) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'capture_not_correlated' });
    const shape = resolveDescriptorContractShape(descriptor, registry);
    if (!shape || !sameRequestShape(shape.request, target.body) || shape.requestMode !== target.body.mode) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'request_schema_not_independent' });
    if (targetCaptures.some((capture) => !pathAndMethodMatch(descriptor, capture))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'path_schema_mismatch' });
    if (new Set(targetCaptures.map((capture) => capture.request.method)).size !== descriptor.methods.length || descriptor.methods.some((method) => !targetCaptures.some((capture) => capture.request.method === method))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'method_coverage_mismatch' });
    if (!sourceWitnessesHold(target.witnesses)) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'service_witness_missing' });
    if (targetCaptures.some((capture) => !captureBodyMatches(descriptor, target, capture, registry))) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'body_mode_or_schema_mismatch' });
    if (targetCaptures.some((capture) => capture.outcome !== 'MATCHED_SUCCESS' || !validateDescriptorContractPayload(descriptor, 'response', capture.payload, registry).ok)) return Object.freeze({ descriptorId: descriptor.id, proven: false, reason: 'real_response_schema_mismatch' });
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

module.exports = { ADMIN_TARGETS, PRE_RESET_TARGETS, RAID_CORE_TARGETS, SEMANTIC_TARGETS, auditCriticalContractEvidence, buildCriticalContractEvidence, pathContract, requestEvidence, responseEvidence, semanticTarget, validateEvidence };
