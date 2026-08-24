'use strict';

const { Readable } = require('stream');
const { __test: base } = require('./siteApiServerBase');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleRaidIdempotentHttp } = require('./raidIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleDreamWorldsHttp } = require('./dreamWorldsHttp');
const { handlePrShopSupport } = require('./siteApiServerLegacy');
const {
    createPreResetSiteApiEvidenceFixture,
    createTestOnlyPreResetPolicy,
    futureCharacterDraft,
    requestPreResetApi,
} = require('./preResetSiteApiEvidenceFixture');

function request(method, url, body) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = {};
    stream.f7RequestBody = body === undefined ? null : Object.freeze({ ...body });
    return stream;
}
function response() {
    return {
        statusCode: 0, headers: {}, body: '', headersSent: false,
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        writeHead(status, headers = {}) { this.statusCode = status; Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value)); },
        end(value = '') { this.headersSent = true; this.body += String(value || ''); },
    };
}
function result(name, handled, res, error, metadata = {}) {
    const recognized = handled === true || Boolean(error) || res.statusCode >= 400;
    let payload = null;
    try { payload = res.body ? JSON.parse(res.body) : null; } catch { payload = null; }
    return Object.freeze({ name, recognized, outcome: error ? 'MATCHED_DEPENDENCY_FAILURE' : res.statusCode >= 400 ? 'MATCHED_EXPECTED_DENIAL' : 'MATCHED_SUCCESS', status: res.statusCode, payload, error: error ? String(error.code || error.message || 'error') : null, ...metadata });
}
async function invoke(name, handler, req, options, metadata = {}) {
    const res = response();
    const requestCapture = Object.freeze({ method: req.method, url: req.url, body: req.f7RequestBody });
    try { return result(name, await handler(req, res, options), res, null, { ...metadata, request: requestCapture }); }
    catch (error) { return result(name, false, res, error, { ...metadata, request: requestCapture }); }
}

async function capturePreResetSuccess(fixture, name, metadata, method, pathname, token, body, headers) {
    const response = await requestPreResetApi(fixture.port, method, pathname, token, body, headers);
    return Object.freeze({
        name,
        recognized: response.status >= 200 && response.status < 300,
        outcome: response.status >= 200 && response.status < 300 ? 'MATCHED_SUCCESS' : 'MATCHED_EXPECTED_DENIAL',
        status: response.status,
        payload: response.body,
        error: null,
        ...metadata,
        request: Object.freeze({ method, url: pathname, body: body === undefined ? null : Object.freeze({ ...body }) }),
    });
}

async function runPreResetRealSuccessProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        fixture.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true' };
        fixture.options.preResetPolicyRegistry = createTestOnlyPreResetPolicy({ conversion: true, shop: true });
        const alpha = fixture.sessions.alpha;
        const admin = fixture.sessions.admin;
        const base = '/pre-reset';
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const captures = [];
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-read', metadata('prereset.future-character.read', 'future-character-v1', 'future-character-read-shape-v1', 'prereset-future-character-read-v1'), 'GET', `${base}/future-character`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-post', metadata('prereset.future-character.write', 'future-character-v1', 'future-character-write-shape-v1', 'prereset-future-character-write-v1'), 'POST', `${base}/future-character`, alpha, { expectedRevision: 0, draft: futureCharacterDraft() }, { 'Idempotency-Key': 'evidence-future-create-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-put', metadata('prereset.future-character.write', 'future-character-v1', 'future-character-write-shape-v1', 'prereset-future-character-write-v1'), 'PUT', `${base}/future-character`, alpha, { expectedRevision: 1, draft: futureCharacterDraft('Atualizado') }, { 'Idempotency-Key': 'evidence-future-update-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-future-character-submit', metadata('prereset.future-character.submit', 'future-character-v1', 'future-character-submit-shape-v1', 'prereset-future-character-submit-v1'), 'POST', `${base}/future-character/submit`, alpha, { expectedRevision: 2, draft: futureCharacterDraft('Atualizado') }, { 'Idempotency-Key': 'evidence-future-submit-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-return-points-balance', metadata('prereset.return-points.balance', 'return-points-balance-v1', 'return-points-balance-v1', 'prereset-return-points-balance-v1'), 'GET', `${base}/return-points/balance`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-conversion-read', metadata('prereset.conversion.read', 'conversion-v1', 'conversion-read-shape-v1', 'prereset-conversion-read-v1'), 'GET', `${base}/conversion`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-conversion-claim', metadata('prereset.conversion.claim', 'conversion-v1', 'conversion-claim-shape-v1', 'prereset-conversion-claim-v1'), 'POST', `${base}/conversion/claim`, alpha, {}, { 'Idempotency-Key': 'evidence-conversion-claim-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-shop-catalog', metadata('prereset.shop.catalog', 'reset-shop-catalog-v1', 'reset-shop-catalog-v1', 'prereset-shop-catalog-v1'), 'GET', `${base}/shop/catalog`, alpha));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-shop-purchase', metadata('prereset.shop.purchase', 'reset-shop-purchase-v1', 'reset-shop-purchase-v1', 'prereset-shop-purchase-v1'), 'POST', `${base}/shop/purchase`, alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': 'evidence-shop-purchase-0001' }));
        captures.push(await capturePreResetSuccess(fixture, 'prereset-admin-review', metadata('prereset.admin.review', 'future-character-review-v1', 'future-character-review-shape-v1', 'prereset-admin-review-v1'), 'POST', `${base}/admin/future-characters/${encodeURIComponent(fixture.players.alpha)}/review`, admin, { action: 'approve', reason: 'evidence review', expectedRevision: 3 }, { 'Idempotency-Key': 'evidence-review-approve-0001' }));
        return Object.freeze(captures);
    } finally {
        await fixture.close();
    }
}

async function runCriticalHandlerBoundaryProbes(overrides = {}) {
    const missingDb = { getDb: () => null };
    const basePublic = await invoke('base-public', (req, res) => base.routePublic(req, res, null, 'GET', ['health'], '/health'), request('GET', '/health'), {});
    const baseSession = await invoke('base-session', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['auth', 'logout'], { player: { id: 'probe' } }, '/auth/logout'), request('POST', '/auth/logout'), {});
    const baseEconomy = await invoke('base-economy', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['economy', 'purchases', 'preview'], { player: { id: 'probe' } }, '/economy/purchases/preview'), request('POST', '/economy/purchases/preview', {}), {});
    const adminAccess = {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'probe-admin', nome: 'Probe Admin' } }),
        accessResolver: async () => ({ ok: true, actor: { id: 'probe-admin', role: 'admin', capabilities: ['operation.view'] } }),
    };
    const preResetProbes = await runPreResetRealSuccessProbes();
    const probes = [
        basePublic, baseSession, baseEconomy,
        await invoke('pre-reset', handlePreResetSiteApi, request('GET', '/pre-reset/future-character'), missingDb),
        await invoke('admin', handleAdminApiSupport, request('GET', '/admin/bootstrap'), missingDb),
        await invoke('admin-bootstrap', handleAdminApiSupport, request('GET', '/admin/bootstrap'), adminAccess, { descriptorId: 'admin.bootstrap', contractId: 'admin-bootstrap-v1', semanticFamily: 'admin-bootstrap-read-v1' }),
        await invoke('admin-policy-catalog', handleAdminApiSupport, request('GET', '/admin/operation-policies'), adminAccess, { descriptorId: 'admin.operation-policies.read', contractId: 'admin-operation-policies-v1', semanticFamily: 'admin-policy-catalog-read-v1' }),
        await invoke('raid-create', handleRaidCoreIdempotentHttp, request('POST', '/raids', { name: 'Probe Raid' }), {
            getDb: () => ({}),
            authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }),
            mutationRunner: async (operation) => operation(),
            createRaid: async () => ({ ok: true, raid: { key: 'probe-raid' } }),
        }, { descriptorId: 'raid.create', contractId: 'raid-create-v1', semanticFamily: 'raid-core-create-v1' }),
        await invoke('raid-condition', handleRaidCoreIdempotentHttp, request('POST', '/raids/probe-raid/conditions', { label: 'Probe Condition' }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(),
            addRaidCondition: async () => ({ ok: true, condition: { id: 1 } }),
        }, { descriptorId: 'raid.condition.add', contractId: 'raid-condition-add-v1', semanticFamily: 'raid-core-condition-add-v1' }),
        await invoke('raid-reward', handleRaidCoreIdempotentHttp, request('POST', '/raids/probe-raid/rewards', { rewardType: 'pa', amount: 1 }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(),
            addRaidReward: async () => ({ ok: true, reward: { id: 1 } }),
        }, { descriptorId: 'raid.reward.add', contractId: 'raid-reward-add-v1', semanticFamily: 'raid-core-reward-add-v1' }),
        await invoke('raid-host-add', handleRaidIdempotentHttp, request('POST', '/raids/probe-raid/hosts', { playerId: 'probe-cohost' }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(),
            addRaidHost: async () => ({ ok: true, host: { player_id: 'probe-cohost' } }),
        }, { descriptorId: 'raid.host.add', contractId: 'raid-host-v1', semanticFamily: 'raid-host-add-v1' }),
        await invoke('raid-host-revoke', handleRaidIdempotentHttp, request('POST', '/raids/probe-raid/hosts/revoke', { playerId: 'probe-cohost' }), {
            getDb: () => ({}), authenticateSession: async () => ({ ok: true, player: { id: 'probe-player' } }), mutationRunner: async (operation) => operation(), revokeRaidHost: async () => ({ ok: true }),
        }, { descriptorId: 'raid.host.revoke', contractId: 'raid-host-v1', semanticFamily: 'raid-host-revoke-v1' }),
        await invoke('skill-approval', handleSkillApprovalHttp, request('POST', '/trees/example-tree/purchase', {}), missingDb),
        await invoke('squad', handleSquadMembershipTransferHttp, request('POST', '/squads/a/members/b/transfer', {}), missingDb),
        await invoke('dream-worlds', handleDreamWorldsHttp, request('GET', '/dream-worlds'), missingDb),
        await invoke('recruitment', handlePrShopSupport, request('GET', '/recruitment/shop'), missingDb),
        ...preResetProbes,
    ];
    const selected = overrides.disableFamily ? probes.filter((probe) => !probe.name.startsWith(overrides.disableFamily)) : probes;
    return Object.freeze({ total: probes.length, probed: selected.length, failures: selected.filter((probe) => !probe.recognized), captures: selected.filter((probe) => probe.outcome === 'MATCHED_SUCCESS' && probe.payload), probes: selected });
}

module.exports = { runCriticalHandlerBoundaryProbes };
