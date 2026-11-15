'use strict';

const { Readable } = require('stream');
const { fork } = require('child_process');
const path = require('path');
const { __test: base } = require('./siteApiServerBase');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleAdminItemsReadApi } = require('./adminItemsReadApi');
const { handleAdminRewardsReadApi } = require('./adminRewardsReadApi');
const { handleAdminHooksReadApi } = require('./adminHooksReadApi');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleRaidIdempotentHttp } = require('./raidIdempotentHttp');
const { handleRaidAtomicFinalizationHttp } = require('./raidAtomicFinalizationHttp');
const { handleRaidFinalizationIdempotentHttp } = require('./raidFinalizationIdempotentHttp');
const { handleRaidRewardProposalIdempotentHttp } = require('./raidRewardProposalIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleAdminRaidRewardReviewReadHttp } = require('./adminRaidRewardReviewReadHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleDreamWorldsHttp } = require('./dreamWorldsHttp');
const { handleDreamWorldsOperationsHttp } = require('./dreamWorldsOperationsHttp');
const { handlePrShopSupport, handleRaidCatalog, handleRaidRewardProposalSupport, handleRaidSupport, handleSquadCaptainSupport, handleSquadSupport } = require('./siteApiServerLegacy');
const { addCatalogItem } = require('./inventoryService');
const { createItemTemplate } = require('./itemAdminService');
const { grantPlayerTitle } = require('./titleService');
const { createMarketListing, createSecureTrade, createWeeklyNpcRequest } = require('./marketService');
const { assignAccessRole } = require('./accessControlLegacyService');
const { setAdminRole } = require('./adminAccessService');
const { createRewardPackage } = require('./adminRewardService');
const { createHookTemplate } = require('./adminHookService');
const { createTraitTemplate } = require('./adminTraitService');
const { addPh } = require('./phService');
const { addRecruitmentPr } = require('./prService');
const { configureRecruitmentEvent, getRecruitmentDashboard } = require('./recruitmentService');
const { ensureSquadMembershipSchema } = require('./squadMembershipService');
const { createSiteLoginCode } = require('./siteAuthService');
const { buyNode } = require('./skillTreeService');
const { requestSkillApproval } = require('./skillApprovalService');
const { addYulls } = require('./yullsService');
const { createDreamWorld, submitDreamRequest, approveDreamRequest } = require('./dreamWorldsService');
const { assignDreamSlotWithPolicy } = require('./dreamWorldsSlotPolicyService');
const { transitionDreamRun } = require('./dreamWorldsOperationsService');
const {
    createPreResetSiteApiEvidenceFixture,
    createTestOnlyPreResetPolicy,
    futureCharacterDraft,
    requestPreResetApi,
} = require('./preResetSiteApiEvidenceFixture');

function request(method, url, body, headers = {}) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = { ...headers };
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

async function runBaseSessionProgressionProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const handleRouteAuthed = (playerId) => async (req, res) => base.routeAuthed(
            req,
            res,
            db,
            req.method,
            new URL(req.url, 'http://localhost').pathname.slice(1).split('/').filter(Boolean),
            { player: { id: playerId } },
            req.url
        );
        const authHeaders = { authorization: `Bearer ${sessions.alpha}` };
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0KAAAAABJRU5ErkJggg==';
        const profileImage = await invoke('site-character-profile-image', handleRouteAuthed(players.alpha), request('PUT', '/character/profile-image', { image }, authHeaders), {}, metadata('site.routeAuthed.put.character.profile-image', 'site-character-profile-image-v1', 'site-character-profile-image-v1', 'site-character-profile-image-update-v1'));
        await addPh(db, players.alpha, 1000, 'f7_evidence', 'Hexagon evidence budget', players.alpha);
        const hexagono = await invoke('site-hexagono-upgrade', handleRouteAuthed(players.alpha), request('POST', '/hexagono', { side: 'controle', confirm: false }, authHeaders), {}, metadata('site.routeAuthed.post.hexagono', 'site-hexagono-v1', 'site-hexagono-v1', 'site-hexagon-upgrade-v1'));
        const hexagon = await invoke('site-hexagon-upgrade', handleRouteAuthed(players.alpha), request('POST', '/hexagon', { side: 'alcance', confirm: false }, authHeaders), {}, metadata('site.routeAuthed.post.hexagon', 'site-hexagon-v1', 'site-hexagon-v1', 'site-hexagon-upgrade-v1'));
        const attributes = await invoke('site-attributes-update', handleRouteAuthed(players.alpha), request('PUT', '/attributes', { forca: 1, velocidade: 1, agilidade: 1, resistencia: 1, poder_magico: 1 }, authHeaders), {}, metadata('site.routeAuthed.put.attributes', 'site-attributes-v1', 'site-attributes-v1', 'site-attributes-update-v1'));
        const logout = await invoke('site-auth-logout', handleRouteAuthed(players.alpha), request('POST', '/auth/logout', undefined, authHeaders), {}, metadata('site.routeAuthed.post.auth.logout', 'site-auth-logout-v1', 'site-auth-logout-v1', 'site-auth-logout-v1'));
        return Object.freeze([profileImage, hexagono, hexagon, attributes, logout]);
    } finally {
        await fixture.close();
    }
}

async function runBaseRaidLifecycleProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const handleRouteAuthed = (playerId) => async (req, res) => base.routeAuthed(req, res, db, req.method, new URL(req.url, 'http://localhost').pathname.slice(1).split('/').filter(Boolean), { player: { id: playerId } }, req.url);
        const authHeaders = (token) => ({ authorization: `Bearer ${token}` });
        await assignAccessRole(db, { subjectId: players.alpha, role: 'admin', assignedBy: players.admin, reason: 'f7_raid_lifecycle' });
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_raid_lifecycle' });
        const create = async (name) => {
            const created = await invoke(`site-raid-create-fixture-${name}`, handleRouteAuthed(players.alpha), request('POST', '/raids', { name: `F7 ${name}`, category: 'evento_especial' }, authHeaders(sessions.alpha)), {});
            if (created.status !== 201) throw new Error(`site_raid_fixture_create_failed:${created.status}`);
            return created.payload.raid.key;
        };
        const key = await create('Lifecycle');
        const join = await invoke('site-raid-join', handleRouteAuthed(players.beta), request('POST', `/raids/${encodeURIComponent(key)}/join`, undefined, authHeaders(sessions.beta)), {}, metadata('site.routeAuthed.post.raids.key.join', 'site-raids-key-join-v1', 'site-raids-key-join-v1', 'site-raid-join-v1'));
        const leave = await invoke('site-raid-leave', handleRouteAuthed(players.beta), request('POST', `/raids/${encodeURIComponent(key)}/leave`, undefined, authHeaders(sessions.beta)), {}, metadata('site.routeAuthed.post.raids.key.leave', 'site-raids-key-leave-v1', 'site-raids-key-leave-v1', 'site-raid-leave-v1'));
        const rejoin = await invoke('site-raid-rejoin-fixture', handleRouteAuthed(players.beta), request('POST', `/raids/${encodeURIComponent(key)}/join`, undefined, authHeaders(sessions.beta)), {});
        if (rejoin.status !== 200) throw new Error(`site_raid_fixture_rejoin_failed:${rejoin.status}`);
        const host = await invoke('site-raid-host-add', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/hosts`, { playerId: players.admin }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.hosts', 'site-raids-key-hosts-v1', 'site-raids-key-hosts-v1', 'site-raid-host-add-v1'));
        const revokeHost = await invoke('site-raid-host-revoke', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/hosts/revoke`, { playerId: players.admin }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.hosts.revoke', 'site-raids-key-hosts-revoke-v1', 'site-raids-key-hosts-revoke-v1', 'site-raid-host-revoke-v1'));
        const removeKey = await create('Remove');
        const removeJoin = await invoke('site-raid-remove-join-fixture', handleRouteAuthed(players.beta), request('POST', `/raids/${encodeURIComponent(removeKey)}/join`, undefined, authHeaders(sessions.beta)), {});
        if (removeJoin.status !== 200) throw new Error(`site_raid_fixture_remove_join_failed:${removeJoin.status}`);
        const remove = await invoke('site-raid-participant-remove', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(removeKey)}/participants/remove`, { playerId: players.beta, reason: 'Remoção descartável F7.' }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.participants.remove', 'site-raids-key-participants-remove-v1', 'site-raids-key-participants-remove-v1', 'site-raid-participant-remove-v1'));
        const sword = (await addCatalogItem(db, players.beta, 'adaga', 1, { source: 'f7_raid_lifecycle' })).items[0];
        const kit = (await addCatalogItem(db, players.beta, 'kit_campo', 1, { source: 'f7_raid_lifecycle' })).items[0];
        const loadout = await invoke('site-raid-loadout-slot', handleRouteAuthed(players.beta), request('PUT', `/raids/${encodeURIComponent(key)}/loadout/main_hand`, { inventoryItemId: sword.id }, authHeaders(sessions.beta)), {}, metadata('site.routeAuthed.put.raids.key.loadout.slot', 'site-raids-key-loadout-slot-v1', 'site-raids-key-loadout-slot-v1', 'site-raid-loadout-slot-v1'));
        const quickLoadout = await invoke('site-raid-quick-loadout-fixture', handleRouteAuthed(players.beta), request('PUT', `/raids/${encodeURIComponent(key)}/loadout/quick_1`, { inventoryItemId: kit.id }, authHeaders(sessions.beta)), {});
        if (quickLoadout.status !== 200) throw new Error(`site_raid_fixture_quick_loadout_failed:${quickLoadout.status}`);
        const start = await invoke('site-raid-start', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/start`, undefined, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.start', 'site-raids-key-start-v1', 'site-raids-key-start-v1', 'site-raid-start-v1'));
        const wear = await invoke('site-raid-item-wear', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/items/${loadout.payload.item.id}/wear`, { amount: 1, cause: 'Desgaste descartável F7.' }, { ...authHeaders(sessions.alpha), 'idempotency-key': 'f7-raid-wear-0001' }), {}, metadata('site.routeAuthed.post.raids.key.items.inventoryItemId.wear', 'site-raids-key-items-inventoryItemId-wear-v1', 'site-raids-key-items-inventoryItemId-wear-v1', 'site-raid-item-wear-v1'));
        const consume = await invoke('site-raid-item-consume', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/items/${quickLoadout.payload.item.id}/consume`, { quantity: 1, cause: 'Consumo descartável F7.' }, { ...authHeaders(sessions.alpha), 'idempotency-key': 'f7-raid-consume-0001' }), {}, metadata('site.routeAuthed.post.raids.key.items.inventoryItemId.consume', 'site-raids-key-items-inventoryItemId-consume-v1', 'site-raids-key-items-inventoryItemId-consume-v1', 'site-raid-item-consume-v1'));
        const condition = await invoke('site-raid-condition-add', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/conditions`, { label: 'Névoa F7', targetType: 'general', severity: 'normal' }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.conditions', 'site-raids-key-conditions-v1', 'site-raids-key-conditions-v1', 'site-raid-condition-add-v1'));
        const resolveCondition = await invoke('site-raid-condition-resolve', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/conditions/${condition.payload.condition.id}/resolve`, { note: 'Resolução descartável F7.' }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.conditions.conditionId.resolve', 'site-raids-key-conditions-conditionId-resolve-v1', 'site-raids-key-conditions-conditionId-resolve-v1', 'site-raid-condition-resolve-v1'));
        const reward = await invoke('site-raid-reward-add', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/rewards`, { rewardType: 'ph', amount: 1, targetType: 'general' }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.rewards', 'site-raids-key-rewards-v1', 'site-raids-key-rewards-v1', 'site-raid-reward-add-v1'));
        const cancelReward = await invoke('site-raid-reward-cancel', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/rewards/${reward.payload.reward.id}/cancel`, undefined, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.rewards.rewardId.cancel', 'site-raids-key-rewards-rewardId-cancel-v1', 'site-raids-key-rewards-rewardId-cancel-v1', 'site-raid-reward-cancel-v1'));
        const finalize = await invoke('site-raid-finalize', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/finalize`, undefined, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.finalize', 'site-raids-key-finalize-v1', 'site-raids-key-finalize-v1', 'site-raid-finalize-v1'));
        const reviewed = await invoke('site-raid-finalization-review-fixture', handleRaidSupport, request('POST', `/raids/${encodeURIComponent(key)}/finalization/participants/${encodeURIComponent(players.beta)}`, { status: 'eligible' }, authHeaders(sessions.alpha)), { getDb: () => db });
        if (reviewed.status !== 200) throw new Error(`site_raid_fixture_review_failed:${reviewed.status}`);
        const complete = await invoke('site-raid-complete', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/complete`, undefined, { ...authHeaders(sessions.alpha), 'idempotency-key': 'f7-raid-complete-0001' }), {}, metadata('site.routeAuthed.post.raids.key.complete', 'site-raids-key-complete-v1', 'site-raids-key-complete-v1', 'site-raid-complete-v1'));
        const cancelKey = await create('Cancel');
        const cancel = await invoke('site-raid-cancel', handleRouteAuthed(players.alpha), request('POST', `/raids/${encodeURIComponent(cancelKey)}/cancel`, { reason: 'Cancelamento descartável F7.' }, authHeaders(sessions.alpha)), {}, metadata('site.routeAuthed.post.raids.key.cancel', 'site-raids-key-cancel-v1', 'site-raids-key-cancel-v1', 'site-raid-cancel-v1'));
        return Object.freeze([join, leave, host, revokeHost, remove, loadout, start, wear, consume, condition, resolveCondition, reward, cancelReward, finalize, complete, cancel]);
    } finally { await fixture.close(); }
}

// These probes deliberately enter each canonical Raid owner instead of
// reusing the base-route captures above.  Setup uses the real base endpoint
// against the disposable SQLite fixture; every asserted mutation below then
// crosses its public canonical handler and reaches its production service.
async function runRaidCanonicalProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const headers = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
        const options = { getDb: () => db };
        const handleBase = (playerId) => async (req, res) => base.routeAuthed(req, res, db, req.method, new URL(req.url, 'http://localhost').pathname.slice(1).split('/').filter(Boolean), { player: { id: playerId } }, req.url);
        await assignAccessRole(db, { subjectId: players.alpha, role: 'admin', assignedBy: players.admin, reason: 'f7_canonical_raid' });
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_canonical_raid' });
        const create = async (suffix, joinBeta = false) => {
            const made = await invoke(`raid-canonical-fixture-${suffix}`, handleBase(players.alpha), request('POST', '/raids', { name: `F7 canonical ${suffix}`, category: 'evento_especial' }, headers(sessions.alpha)), {});
            if (made.status !== 201) throw new Error(`raid_canonical_fixture_create_failed:${suffix}:${made.status}`);
            const key = made.payload.raid.key;
            if (joinBeta) {
                const joined = await invoke(`raid-canonical-fixture-join-${suffix}`, handleBase(players.beta), request('POST', `/raids/${encodeURIComponent(key)}/join`, undefined, headers(sessions.beta)), {});
                if (joined.status !== 200) throw new Error(`raid_canonical_fixture_join_failed:${suffix}:${joined.status}`);
            }
            return key;
        };
        const start = async (key, suffix) => {
            const started = await invoke(`raid-canonical-fixture-start-${suffix}`, handleBase(players.alpha), request('POST', `/raids/${encodeURIComponent(key)}/start`, undefined, headers(sessions.alpha)), {});
            if (started.status !== 200) throw new Error(`raid_canonical_fixture_start_failed:${suffix}:${started.status}:${started.error || 'no_error'}`);
        };

        const joinKey = await create('join-idempotent', false);
        const joinIntent = { idempotencyKey: 'f7-canonical-raid-join-0001' };
        const join = await invoke(
            'raid-join',
            handleRaidIdempotentHttp,
            request('POST', `/raids/${encodeURIComponent(joinKey)}/join`, joinIntent, headers(sessions.beta)),
            options,
            metadata('raid.participant.join', 'site-raids-key-join-v1', 'site-raids-key-join-v1', 'raid-participant-join-v1')
        );
        if (join.status !== 200 || join.payload?.duplicate !== false) {
            throw new Error(`raid_join_idempotent_first_failed:${join.status}:${join.error || join.payload?.error || 'unknown'}`);
        }
        const joinReplay = await invoke(
            'raid-join-replay-fixture',
            handleRaidIdempotentHttp,
            request('POST', `/raids/${encodeURIComponent(joinKey)}/join`, joinIntent, headers(sessions.beta)),
            options,
            metadata('raid.participant.join', 'site-raids-key-join-v1', 'site-raids-key-join-v1', 'raid-participant-join-v1')
        );
        if (joinReplay.status !== 200 || joinReplay.payload?.duplicate !== true) {
            throw new Error(`raid_join_idempotent_replay_failed:${joinReplay.status}:${joinReplay.error || joinReplay.payload?.error || 'unknown'}`);
        }
        const joinEvents = await db.get(
            `SELECT COUNT(*) AS total FROM clover_raid_events
             WHERE raid_id = (SELECT id FROM clover_raids WHERE raid_key = ?)
               AND action = 'participant_joined'`,
            [joinKey]
        );
        if (Number(joinEvents?.total || 0) !== 1) throw new Error('raid_join_duplicate_domain_event');

        const startKey = await create('start-idempotent', true);
        const startIntent = { idempotencyKey: 'f7-canonical-raid-start-0001' };
        const startCapture = await invoke(
            'raid-start',
            handleRaidIdempotentHttp,
            request('POST', `/raids/${encodeURIComponent(startKey)}/start`, startIntent, headers(sessions.alpha)),
            options,
            metadata('raid.start', 'site-raids-key-start-v1', 'site-raids-key-start-v1', 'raid-start-v1')
        );
        if (startCapture.status !== 200 || startCapture.payload?.duplicate !== false) {
            throw new Error(`raid_start_idempotent_first_failed:${startCapture.status}:${startCapture.error || startCapture.payload?.error || 'unknown'}`);
        }
        const startReplay = await invoke(
            'raid-start-replay-fixture',
            handleRaidIdempotentHttp,
            request('POST', `/raids/${encodeURIComponent(startKey)}/start`, startIntent, headers(sessions.alpha)),
            options,
            metadata('raid.start', 'site-raids-key-start-v1', 'site-raids-key-start-v1', 'raid-start-v1')
        );
        if (startReplay.status !== 200 || startReplay.payload?.duplicate !== true) {
            throw new Error(`raid_start_idempotent_replay_failed:${startReplay.status}:${startReplay.error || startReplay.payload?.error || 'unknown'}`);
        }
        const startEvents = await db.get(
            `SELECT COUNT(*) AS total FROM clover_raid_events
             WHERE raid_id = (SELECT id FROM clover_raids WHERE raid_key = ?)
               AND action = 'raid_started'`,
            [startKey]
        );
        if (Number(startEvents?.total || 0) !== 1) throw new Error('raid_start_duplicate_domain_event');

        const leaveKey = await create('leave', true);
        const leave = await invoke('raid-participant-leave', handleRaidIdempotentHttp, request('POST', `/raids/${encodeURIComponent(leaveKey)}/leave`, undefined, headers(sessions.beta, { 'idempotency-key': 'f7-canonical-raid-leave-0001' })), options, metadata('raid.participant.leave', 'raid-participant-v1', 'raid-participant-v1', 'raid-participant-leave-v1'));

        const removeKey = await create('remove', true);
        const remove = await invoke('raid-participant-remove', handleRaidIdempotentHttp, request('POST', `/raids/${encodeURIComponent(removeKey)}/participants/remove`, { playerId: players.beta, reason: 'Remoção descartável F7.' }, headers(sessions.alpha, { 'idempotency-key': 'f7-canonical-raid-remove-0001' })), options, metadata('raid.participant.remove', 'raid-participant-v1', 'raid-participant-v1', 'raid-participant-remove-v1'));

        const loadoutKey = await create('loadout', true);
        const sword = (await addCatalogItem(db, players.beta, 'adaga', 1, { source: 'f7_canonical_raid' })).items[0];
        const loadout = await invoke('raid-loadout-slot-update', handleRaidIdempotentHttp, request('PUT', `/raids/${encodeURIComponent(loadoutKey)}/loadout/main_hand`, { inventoryItemId: sword.id }, headers(sessions.beta, { 'idempotency-key': 'f7-canonical-raid-loadout-0001' })), options, metadata('raid.loadout.slot.update', 'raid-loadout-v1', 'raid-loadout-v1', 'raid-loadout-slot-update-v1'));

        const activeKey = await create('active', true);
        await start(activeKey, 'active');
        const conditionSetup = await invoke('raid-canonical-condition-setup', handleBase(players.alpha), request('POST', `/raids/${encodeURIComponent(activeKey)}/conditions`, { label: 'Névoa F7', targetType: 'general', severity: 'normal' }, headers(sessions.alpha)), {});
        const condition = await invoke('raid-condition-resolve', handleRaidIdempotentHttp, request('POST', `/raids/${encodeURIComponent(activeKey)}/conditions/${conditionSetup.payload.condition.id}/resolve`, { note: 'Condição resolvida na prova F7.' }, headers(sessions.alpha, { 'idempotency-key': 'f7-canonical-raid-condition-0001' })), options, metadata('raid.condition.resolve', 'raid-condition-v1', 'raid-condition-v1', 'raid-condition-resolve-v1'));
        const rewardSetup = await invoke('raid-canonical-reward-setup', handleBase(players.alpha), request('POST', `/raids/${encodeURIComponent(activeKey)}/rewards`, { rewardType: 'ph', amount: 1, targetType: 'general' }, headers(sessions.alpha)), {});
        const reward = await invoke('raid-reward-cancel', handleRaidIdempotentHttp, request('POST', `/raids/${encodeURIComponent(activeKey)}/rewards/${rewardSetup.payload.reward.id}/cancel`, undefined, headers(sessions.alpha, { 'idempotency-key': 'f7-canonical-raid-reward-cancel-0001' })), options, metadata('raid.reward.cancel', 'raid-reward-v1', 'raid-reward-v1', 'raid-reward-cancel-v1'));
        const cancel = await invoke('raid-cancel', handleRaidIdempotentHttp, request('POST', `/raids/${encodeURIComponent(activeKey)}/cancel`, { reason: 'Cancelamento descartável F7.' }, headers(sessions.alpha, { 'idempotency-key': 'f7-canonical-raid-cancel-0001' })), options, metadata('raid.cancel', 'raid-v1', 'raid-v1', 'raid-cancel-v1'));

        const finalKey = await create('finalization', true);
        await start(finalKey, 'finalization');
        const finalization = await invoke('raid-finalization-start', handleRaidAtomicFinalizationHttp, request('POST', `/raids/${encodeURIComponent(finalKey)}/finalize`, undefined, headers(sessions.alpha)), options, metadata('raid.finalization.start', 'raid-finalization-start-v1', 'raid-finalization-start-v1', 'raid-finalization-start-v1'));
        const summary = await invoke('raid-finalization-summary', handleRaidSupport, request('GET', `/raids/${encodeURIComponent(finalKey)}/finalization`, undefined, headers(sessions.beta)), options, metadata('raid.finalization.summary', 'raid-finalization-summary-v1', 'raid-finalization-summary-v1', 'raid-finalization-summary-v1'));
        const review = await invoke('raid-finalization-participant-review', handleRaidFinalizationIdempotentHttp, request('POST', `/raids/${encodeURIComponent(finalKey)}/finalization/participants/${encodeURIComponent(players.beta)}`, { status: 'eligible', note: 'Elegível na prova F7.' }, headers(sessions.alpha, { 'idempotency-key': 'f7-canonical-finalization-review-0001' })), options, metadata('raid.finalization.participant.review', 'raid-finalization-review-v1', 'raid-finalization-review-v1', 'raid-finalization-review-v1'));

        const proposalKey = await create('proposal', true);
        await start(proposalKey, 'proposal');
        await invoke('raid-canonical-proposal-reward-setup', handleBase(players.alpha), request('POST', `/raids/${encodeURIComponent(proposalKey)}/rewards`, { rewardType: 'ph', amount: 1, targetType: 'general' }, headers(sessions.alpha)), {});
        const proposal = await invoke('raid-reward-proposals-create', handleRaidRewardProposalSupport, request('POST', `/raids/${encodeURIComponent(proposalKey)}/reward-proposals`, { metadata: { source: 'f7' } }, headers(sessions.alpha)), options, metadata('raid.reward-proposals.create', 'raid-reward-proposal-v1', 'raid-reward-proposal-v1', 'raid-reward-proposal-create-v1'));
        const proposalList = await invoke('raid-reward-proposals-list', handleRaidRewardProposalSupport, request('GET', '/raid-reward-proposals?status=pending', undefined, headers(sessions.admin)), options, metadata('raid.reward-proposals.list', 'raid-reward-proposal-list-v1', 'raid-reward-proposal-list-v1', 'raid-reward-proposal-list-v1'));
        const proposalReview = await invoke('raid-reward-proposal-review', handleRaidRewardProposalIdempotentHttp, request('POST', `/raid-reward-proposals/${encodeURIComponent(proposal.payload.proposal.id)}/review`, { decision: 'return', note: 'Revisão descartável F7.' }, headers(sessions.admin, { 'idempotency-key': 'f7-canonical-proposal-review-0001' })), options, metadata('raid.reward-proposal.review', 'raid-reward-proposal-review-v1', 'raid-reward-proposal-review-v1', 'raid-reward-proposal-review-v1'));

        const categories = await invoke('raid-categories-read', handleRaidCatalog, request('GET', '/raids/categories'), {}, metadata('raid.categories.read', 'raid-categories-v1', 'raid-categories-v1', 'raid-categories-read-v1'));
        const raidOptions = await invoke('raid-options-read', handleRaidSupport, request('GET', '/raids/options', undefined, headers(sessions.alpha)), options, metadata('raid.options.read', 'raid-options-v1', 'raid-options-v1', 'raid-options-read-v1'));
        const usage = await invoke('raid-usage-read', handleRaidSupport, request('GET', '/raids/usage?category=evento_especial', undefined, headers(sessions.alpha)), options, metadata('raid.usage.read', 'raid-usage-v1', 'raid-usage-v1', 'raid-usage-read-v1'));
        const checklist = await invoke('raid-checklist-read', handleRaidSupport, request('GET', '/raids/checklist', undefined, headers(sessions.alpha)), options, metadata('raid.checklist.read', 'raid-checklist-v1', 'raid-checklist-v1', 'raid-checklist-read-v1'));
        return Object.freeze([join, startCapture, leave, remove, loadout, condition, reward, finalization, summary, review, proposal, proposalList, proposalReview, cancel, categories, raidOptions, usage, checklist].map((capture) => {
            const contractShapeId = capture.descriptorId === 'raid.participant.leave' ? 'raid-participant-leave-shape-v1'
                : capture.descriptorId === 'raid.participant.remove' ? 'raid-participant-remove-shape-v1'
                    : capture.contractShapeId;
            return contractShapeId === capture.contractShapeId ? capture : Object.freeze({ ...capture, contractShapeId });
        }));
    } finally { await fixture.close(); }
}

// Player-facing Dream Worlds evidence crosses the two public owners with the
// same disposable SQLite data that creates its real run, slots and ledger.
// Setup calls services only to establish legal state; every captured action
// below enters its production HTTP handler and semantic operation.
async function runDreamWorldsCanonicalProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const options = { getDb: () => db };
        const headers = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        await addYulls(db, players.alpha, 50000, 'fixture', 'Disposable F7 Dream Worlds balance.', 'fixture');
        const createRun = async (suffix) => {
            const world = await createDreamWorld(db, {
                name: `F7 Dream ${suffix}`,
                slug: `f7-dream-${suffix}`,
                universe: 'Disposable evidence', synopsis: 'Real SQLite-only Dream Worlds proof.',
                dreamType: 'self', rank: 'A', status: 'available', yullsPrice: 1000,
                manualPaymentEnabled: true, manualPriceLabel: 'R$ 10', minPlayers: 2, maxPlayers: 4,
                slots: { squad: 0, invited: 1, public: 3 }, knownChapters: 3,
            }, players.admin);
            const submitted = await submitDreamRequest(db, players.alpha, world.slug, {
                buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: `f7-dream-setup-${suffix}`,
            });
            const approved = await approveDreamRequest(db, submitted.request.id, players.admin, { narratorIds: [players.admin] });
            return Object.freeze({ world, run: approved.run });
        };
        const applicationFixture = await createRun('application');
        const application = await invoke('dream-application-submit', handleDreamWorldsHttp, request('POST', `/dream-worlds/${encodeURIComponent(applicationFixture.world.slug)}/applications`, { playerNote: 'Real handler application.', metadata: { source: 'f7' } }, headers(sessions.beta, { 'idempotency-key': 'f7-dream-application-0001' })), options, metadata('dream-worlds.application.submit', 'dream-application-v1', 'dream-application-submit-shape-v1', 'dream-application-submit-v1'));
        if (application.status !== 201) throw new Error(`dream_application_submit_failed:${application.status}`);
        const withdraw = await invoke('dream-application-withdraw', handleDreamWorldsHttp, request('POST', `/dream-worlds/applications/${encodeURIComponent(application.payload.application.id)}/withdraw`, {}, headers(sessions.beta)), options, metadata('dream-worlds.application.withdraw', 'dream-application-v1', 'dream-application-withdraw-shape-v1', 'dream-application-withdraw-v1'));

        const requestWorld = await createDreamWorld(db, {
            name: 'F7 Dream request', slug: 'f7-dream-request', universe: 'Disposable evidence', synopsis: 'Request route proof.',
            dreamType: 'self', rank: 'A', status: 'available', yullsPrice: 1000,
            manualPaymentEnabled: true, manualPriceLabel: 'R$ 10', minPlayers: 2, maxPlayers: 4,
            slots: { squad: 0, invited: 1, public: 3 }, knownChapters: 3,
        }, players.admin);
        const submittedRequest = await invoke('dream-request-submit', handleDreamWorldsHttp, request('POST', `/dream-worlds/${encodeURIComponent(requestWorld.slug)}/requests`, { buyerType: 'player', paymentMethod: 'yulls', playerNote: 'Real handler request.', metadata: { source: 'f7' } }, headers(sessions.alpha, { 'idempotency-key': 'f7-dream-request-0001' })), options, metadata('dream-worlds.request.submit', 'dream-request-v1', 'dream-request-submit-shape-v1', 'dream-request-submit-v1'));

        const inviteSlot = async (suffix) => {
            const fixtureRun = await createRun(suffix);
            const slot = await db.get("SELECT id FROM clover_dream_slots WHERE run_id = ? AND category = 'public' AND status = 'open' ORDER BY id LIMIT 1", [fixtureRun.run.id]);
            if (!slot) throw new Error(`dream_invite_slot_missing:${suffix}`);
            await assignDreamSlotWithPolicy(db, fixtureRun.run.id, slot.id, players.beta, players.admin, { mode: 'invited' });
            return slot.id;
        };
        const acceptSlot = await inviteSlot('accept');
        const accept = await invoke('dream-invite-accept', handleDreamWorldsOperationsHttp, request('POST', `/dream-worlds/invites/${encodeURIComponent(acceptSlot)}/accept`, {}, headers(sessions.beta)), options, metadata('dream-worlds.invite.accept', 'dream-run-v1', 'dream-invite-accept-shape-v1', 'dream-invite-accept-v1'));
        const declineSlot = await inviteSlot('decline');
        const decline = await invoke('dream-invite-decline', handleDreamWorldsOperationsHttp, request('POST', `/dream-worlds/invites/${encodeURIComponent(declineSlot)}/decline`, { reason: 'Disposable F7 decline.' }, headers(sessions.beta)), options, metadata('dream-worlds.invite.decline', 'dream-run-v1', 'dream-invite-decline-shape-v1', 'dream-invite-decline-v1'));
        return Object.freeze([application, withdraw, submittedRequest, accept, decline]);
    } finally { await fixture.close(); }
}

async function runSkillTreePurchaseProbe() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await addPh(db, players.alpha, 200, 'fixture', 'Disposable F7 skill purchase balance.', 'fixture');
        return Object.freeze([await invoke('skill-tree-purchase', handleSkillApprovalHttp, request('POST', '/trees/mana/purchase', { nodeId: 'mana' }, { authorization: `Bearer ${sessions.alpha}`, 'x-request-id': 'f7-skill-tree-purchase-0001' }), { getDb: () => db }, { descriptorId: 'skill.tree.purchase', contractId: 'skill-purchase-v1', contractShapeId: 'skill-purchase-v1', semanticFamily: 'skill-tree-purchase-v1' })]);
    } finally { await fixture.close(); }
}

async function runSquadCanonicalProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.alpha}` };
        await ensureSquadMembershipSchema(db);
        await db.run("UPDATE jogadores SET personagem_nome = ?, jogo_liberado_at = CURRENT_TIMESTAMP WHERE id = ?", ['Alpha Squad', players.alpha]);
        await db.run("UPDATE jogadores SET personagem_nome = ?, jogo_liberado_at = CURRENT_TIMESTAMP WHERE id = ?", ['Beta Squad', players.beta]);
        await db.run(`INSERT INTO clover_squads (squad_key, name, captain_player_id, current_stars, historical_stars)
            VALUES ('f7_aurora', 'F7 Aurora', ?, 0, 0)`, [players.alpha]);
        await db.run(`INSERT INTO clover_squads (squad_key, name, captain_player_id, current_stars, historical_stars)
            VALUES ('f7_bravo', 'F7 Bravo', ?, 0, 0)`, [players.alpha]);
        await assignAccessRole(db, { subjectId: players.alpha, role: 'admin', assignedBy: players.admin, reason: 'f7_squad_canonical' });

        const candidates = await invoke('squad-member-candidates-read', handleSquadCaptainSupport, request('GET', '/squads/f7_aurora/member-candidates?q=Beta', undefined, headers), options, metadata('squad.member-candidates.read', 'squad-member-candidate-list-v1', 'squad-member-candidates-read-shape-v1', 'squad-member-candidates-read-v1'));
        const added = await invoke('squad-member-add', handleSquadCaptainSupport, request('POST', '/squads/f7_aurora/members', { characterId: players.beta }, headers), options, metadata('squad.member.add', 'squad-member-v1', 'squad-member-add-shape-v1', 'squad-member-add-v1'));
        const operations = await invoke('squad-operations-read', handleSquadSupport, request('GET', '/squads/f7_aurora/operations', undefined, headers), options, metadata('squad.operations.read', 'squad-operations-v1', 'squad-operations-read-shape-v1', 'squad-operations-read-v1'));
        const removed = await invoke('squad-member-remove', handleSquadCaptainSupport, request('POST', `/squads/f7_aurora/members/${encodeURIComponent(players.beta)}/remove`, { reason: 'Disposable F7 member removal.' }, headers), options, metadata('squad.member.remove', 'squad-member-v1', 'squad-member-remove-shape-v1', 'squad-member-remove-v1'));
        const readded = await invoke('squad-member-readd-fixture', handleSquadCaptainSupport, request('POST', '/squads/f7_aurora/members', { characterId: players.beta }, headers), options);
        if (readded.status !== 201) throw new Error(`squad_fixture_readd_failed:${readded.status}:${readded.error || readded.payload?.error || 'unknown'}:add=${added.status}/${added.payload?.error || 'ok'}:remove=${removed.status}/${removed.payload?.error || 'ok'}`);
        const transferred = await invoke('squad-member-transfer', handleSquadMembershipTransferHttp, request('POST', `/squads/f7_aurora/members/${encodeURIComponent(players.beta)}/transfer`, { toSquad: 'f7_bravo', reason: 'Disposable F7 membership transfer.' }, { ...headers, 'idempotency-key': 'f7-squad-transfer-0001' }), options, metadata('squad.member.transfer', 'squad-member-transfer-v1', 'squad-member-transfer-shape-v1', 'squad-member-transfer-v1'));
        return Object.freeze([operations, candidates, added, removed, transferred]);
    } finally { await fixture.close(); }
}

async function runRecruitmentCanonicalProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await configureRecruitmentEvent(db, { status: 'active', startsAt: new Date(Date.now() - 60_000), durationDays: 30, shopEnabled: true });
        await addRecruitmentPr(db, players.alpha, 100, 'Disposable F7 PR budget.', players.admin);
        return Object.freeze([await invoke('recruitment-shop-purchase', handlePrShopSupport, request('POST', '/recruitment/shop/yulls_2500/purchase', { quantity: 1 }, { authorization: `Bearer ${sessions.alpha}`, 'idempotency-key': 'f7-pr-shop-purchase-0001' }), { getDb: () => db }, { descriptorId: 'recruitment.shop.purchase', contractId: 'recruitment-shop-purchase-v1', contractShapeId: 'recruitment-shop-purchase-shape-v1', semanticFamily: 'recruitment-shop-purchase-v1' })]);
    } finally { await fixture.close(); }
}

async function runBaseCanonicalResidualProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const handleRouteAuthed = (playerId) => async (req, res) => base.routeAuthed(req, res, db, req.method, new URL(req.url, 'http://localhost').pathname.slice(1).split('/').filter(Boolean), { player: { id: playerId } }, req.url);
        const loginPlayer = '5511999998888@s.whatsapp.net';
        await db.run(`INSERT INTO jogadores (id, nome, personagem_nome, raca, dinheiro, ficha_status, jogo_status, jogo_liberado_at)
            VALUES (?, 'Login F7', 'Login F7', 'Humano ativo', 77, 'aprovada', 'liberado', CURRENT_TIMESTAMP)`, [loginPlayer]);
        const loginCode = await createSiteLoginCode(db, loginPlayer);
        if (!loginCode.ok) throw new Error(`site_login_fixture_failed:${loginCode.reason}`);
        const login = await invoke('site-auth-login', (req, res) => base.routePublic(req, res, db, req.method, ['auth', 'login'], req.url), request('POST', '/auth/login', { phone: loginCode.phoneDigits, code: loginCode.code }), {}, metadata('site.routePublic.post.auth.login', 'site-auth-login-v1', 'site-auth-login-shape-v1', 'site-auth-login-v1'));

        await addCatalogItem(db, players.alpha, 'box_simple_v1', 1, { source: 'f7_box_fixture' });
        const box = await invoke('site-box-open', handleRouteAuthed(players.alpha), request('POST', '/boxes/simples/open', {}, { authorization: `Bearer ${sessions.alpha}`, 'idempotency-key': 'f7-box-open-0001' }), {}, metadata('site.routeAuthed.post.boxes.key.open', 'site-boxes-key-open-v1', 'site-box-open-shape-v1', 'site-box-open-v1'));

        await db.run('UPDATE jogadores SET jogo_liberado_at = CURRENT_TIMESTAMP WHERE id IN (?, ?)', [players.alpha, players.admin]);
        const recruiter = await getRecruitmentDashboard(db, players.admin);
        const referrer = await invoke('site-recruitment-referrer', handleRouteAuthed(players.alpha), request('POST', '/recruitment/referrer', { code: recruiter.code }, { authorization: `Bearer ${sessions.alpha}` }), {}, metadata('site.routeAuthed.post.recruitment.referrer', 'site-recruitment-referrer-v1', 'site-recruitment-referrer-shape-v1', 'site-recruitment-referrer-v1'));
        return Object.freeze([login, box, referrer]);
    } finally { await fixture.close(); }
}

async function runBaseEconomyPaymentProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const options = { getDb: () => fixture.db };
        const headers = (key) => ({ authorization: `Bearer ${fixture.sessions.alpha}`, 'idempotency-key': key });
        const handleBase = async (req, res, options) => { await base.handleRequest(req, res, options); return true; };
        const preview = await invoke('economy-payment-preview', handleBase, request('POST', '/economy/payments/preview', { recipientId: fixture.players.beta, amount: 10, reason: 'evidence payment' }, headers('evidence-payment-preview-0001')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.preview', contractId: 'site-economy-payments-preview-v1', contractShapeId: 'site-economy-payments-preview-shape-v1', semanticFamily: 'economy-payment-intent-v1' });
        const confirm = await invoke('economy-payment-confirm', handleBase, request('POST', `/economy/payments/${encodeURIComponent(preview.payload.payment.key)}/confirm`, undefined, headers('evidence-payment-confirm-0001')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.key.confirm', contractId: 'site-economy-payments-key-confirm-v1', contractShapeId: 'site-economy-payments-confirm-shape-v1', semanticFamily: 'economy-payment-confirm-v1' });
        const cancellable = await invoke('economy-payment-cancel-preview', handleBase, request('POST', '/economy/payments/preview', { recipientId: fixture.players.beta, amount: 11, reason: 'evidence cancellation' }, headers('evidence-payment-preview-0002')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.preview', contractId: 'site-economy-payments-preview-v1', contractShapeId: 'site-economy-payments-preview-shape-v1', semanticFamily: 'economy-payment-intent-v1' });
        const cancel = await invoke('economy-payment-cancel', handleBase, request('POST', `/economy/payments/${encodeURIComponent(cancellable.payload.payment.key)}/cancel`, undefined, headers('evidence-payment-cancel-0001')), options, { descriptorId: 'site.routeAuthed.post.economy.payments.key.cancel', contractId: 'site-economy-payments-key-cancel-v1', contractShapeId: 'site-economy-payments-cancel-shape-v1', semanticFamily: 'economy-payment-cancel-v1' });
        return Object.freeze([preview, confirm, cancellable, cancel]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyMarketProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await db.run('UPDATE jogadores SET dinheiro = 1000 WHERE id IN (?, ?)', [players.alpha, players.beta]);
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key) => ({ authorization: `Bearer ${token}`, 'idempotency-key': key });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const sellerItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'f7_market_evidence' })).items[0];
        const quote = await invoke('economy-market-listing-preview', handleBase, request('POST', '/economy/market/listings/preview', { inventoryItemId: sellerItem.id, unitPrice: 100, title: 'Evidência de anúncio' }, headers(sessions.alpha, 'evidence-market-quote-0001')), options, metadata('site.routeAuthed.post.economy.market.listings.preview', 'site-economy-market-listings-preview-v1', 'site-economy-market-listings-preview-shape-v1', 'economy-market-listing-quote-v1'));
        const listing = await invoke('economy-market-listing-create', handleBase, request('POST', '/economy/market/listings', { inventoryItemId: sellerItem.id, unitPrice: 100, title: 'Evidência de anúncio' }, headers(sessions.alpha, 'evidence-market-listing-0001')), options, metadata('site.routeAuthed.post.economy.market.listings', 'site-economy-market-listings-v1', 'site-economy-market-listings-create-shape-v1', 'economy-market-listing-create-v1'));
        const purchasePreview = await invoke('economy-market-purchase-preview', handleBase, request('POST', '/economy/market/purchases/preview', { listingKey: listing.payload.listing.key }, headers(sessions.beta, 'evidence-market-purchase-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-v1', 'site-economy-market-purchases-preview-shape-v1', 'economy-market-purchase-intent-v1'));
        const confirm = await invoke('economy-market-purchase-confirm', handleBase, request('POST', `/economy/market/purchases/${encodeURIComponent(purchasePreview.payload.intent.intent_key)}/confirm`, undefined, headers(sessions.beta, 'evidence-market-confirm-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.key.confirm', 'site-economy-market-purchases-key-confirm-v1', 'site-economy-market-purchases-confirm-shape-v1', 'economy-market-purchase-confirm-v1'));

        const cancellableItem = (await addCatalogItem(db, players.alpha, 'pocao_antidoto', 1, { source: 'f7_market_evidence' })).items[0];
        const cancellableListing = await createMarketListing(db, players.alpha, { inventoryItemId: cancellableItem.id, unitPrice: 80 }, { via: 'f7_market_evidence', idempotencyKey: 'evidence-market-listing-cancel-setup' });
        const listingCancel = await invoke('economy-market-listing-cancel', handleBase, request('POST', `/economy/market/listings/${encodeURIComponent(cancellableListing.listing.key)}/cancel`, undefined, headers(sessions.alpha, 'evidence-market-listing-cancel-0001')), options, metadata('site.routeAuthed.post.economy.market.listings.key.cancel', 'site-economy-market-listings-key-cancel-v1', 'site-economy-market-listings-cancel-shape-v1', 'economy-market-listing-cancel-v1'));

        const pendingItem = (await addCatalogItem(db, players.alpha, 'adaga', 1, { source: 'f7_market_evidence' })).items[0];
        const pendingListing = await createMarketListing(db, players.alpha, { inventoryItemId: pendingItem.id, unitPrice: 90 }, { via: 'f7_market_evidence', idempotencyKey: 'evidence-market-purchase-cancel-setup' });
        const cancellablePurchase = await invoke('economy-market-purchase-cancel-preview', handleBase, request('POST', '/economy/market/purchases/preview', { listingKey: pendingListing.listing.key }, headers(sessions.beta, 'evidence-market-purchase-cancel-preview-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-v1', 'site-economy-market-purchases-preview-shape-v1', 'economy-market-purchase-intent-v1'));
        const purchaseCancel = await invoke('economy-market-purchase-cancel', handleBase, request('POST', `/economy/market/purchases/${encodeURIComponent(cancellablePurchase.payload.intent.intent_key)}/cancel`, undefined, headers(sessions.beta, 'evidence-market-purchase-cancel-0001')), options, metadata('site.routeAuthed.post.economy.market.purchases.key.cancel', 'site-economy-market-purchases-key-cancel-v1', 'site-economy-market-purchases-cancel-shape-v1', 'economy-market-purchase-cancel-v1'));

        const auctionItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'f7_market_evidence' })).items[0];
        const auction = await createMarketListing(db, players.alpha, { type: 'auction', inventoryItemId: auctionItem.id, startingBid: 100, durationHours: 24 }, { via: 'f7_market_evidence', idempotencyKey: 'evidence-market-auction-setup' });
        const bid = await invoke('economy-market-auction-bid', handleBase, request('POST', `/economy/market/auctions/${encodeURIComponent(auction.listing.key)}/bids`, { amount: 100 }, headers(sessions.beta, 'evidence-market-auction-bid-0001')), options, metadata('site.routeAuthed.post.economy.market.auctions.key.bids', 'site-economy-market-auctions-key-bids-v1', 'site-economy-market-auctions-bid-shape-v1', 'economy-market-auction-bid-v1'));
        return Object.freeze([quote, listing, purchasePreview, confirm, listingCancel, cancellablePurchase, purchaseCancel, bid]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyTradeProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await db.run('UPDATE jogadores SET dinheiro = 1000 WHERE id IN (?, ?)', [players.alpha, players.beta]);
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token) => ({ authorization: `Bearer ${token}` });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const creatorItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'f7_trade_evidence' })).items[0];
        const targetItem = (await addCatalogItem(db, players.beta, 'pocao_antidoto', 1, { source: 'f7_trade_evidence' })).items[0];
        const created = await invoke('economy-trade-create', handleBase, request('POST', '/economy/trades', { targetId: players.beta, creatorItems: [{ inventoryItemId: creatorItem.id, quantity: 1 }] }, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.trades', 'site-economy-trades-v1', 'site-economy-trades-create-shape-v1', 'economy-secure-trade-create-v1'));
        const tradeKey = created.payload.trade.key;
        const updated = await invoke('economy-trade-update', handleBase, request('PATCH', `/economy/trades/${encodeURIComponent(tradeKey)}`, { items: [{ inventoryItemId: targetItem.id, quantity: 1 }], yulls: 0 }, headers(sessions.beta)), options, metadata('site.routeAuthed.patch.economy.trades.key', 'site-economy-trades-key-v1', 'site-economy-trades-update-shape-v1', 'economy-secure-trade-update-v1'));
        const firstConfirmation = await invoke('economy-trade-confirm-first', handleBase, request('POST', `/economy/trades/${encodeURIComponent(tradeKey)}/confirm`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.trades.key.confirm', 'site-economy-trades-key-confirm-v1', 'site-economy-trades-confirm-shape-v1', 'economy-secure-trade-confirm-v1'));
        const finalConfirmation = await invoke('economy-trade-confirm-final', handleBase, request('POST', `/economy/trades/${encodeURIComponent(tradeKey)}/confirm`, undefined, headers(sessions.beta)), options, metadata('site.routeAuthed.post.economy.trades.key.confirm', 'site-economy-trades-key-confirm-v1', 'site-economy-trades-confirm-shape-v1', 'economy-secure-trade-confirm-v1'));
        const cancelTrade = await createSecureTrade(db, players.alpha, players.beta, { creatorYulls: 1 }, { via: 'f7_trade_evidence' });
        const cancelled = await invoke('economy-trade-cancel', handleBase, request('POST', `/economy/trades/${encodeURIComponent(cancelTrade.trade.key)}/cancel`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.trades.key.cancel', 'site-economy-trades-key-cancel-v1', 'site-economy-trades-cancel-shape-v1', 'economy-secure-trade-cancel-v1'));
        return Object.freeze([created, updated, firstConfirmation, finalConfirmation, cancelled]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyWeeklyRequestProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_weekly_evidence' });
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key = null) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const deliveryItem = (await addCatalogItem(db, players.alpha, 'kit_campo', 1, { source: 'raid' })).items[0];
        const created = await invoke('economy-weekly-request-create', handleBase, request('POST', '/economy/weekly-requests', { templateKey: 'kit_campo', pricePercent: 100, globalQuantity: 4, personalLimit: 2, requiredCondition: 'qualquer' }, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.weekly-requests', 'site-economy-weekly-requests-v1', 'site-economy-weekly-requests-create-shape-v1', 'economy-weekly-request-create-v1'));
        const requestKey = created.payload.request.key;
        const updated = await invoke('economy-weekly-request-update', handleBase, request('PATCH', `/economy/weekly-requests/${encodeURIComponent(requestKey)}`, { pricePercent: 110 }, headers(sessions.admin)), options, metadata('site.routeAuthed.patch.economy.weekly-requests.key', 'site-economy-weekly-requests-key-v1', 'site-economy-weekly-requests-update-shape-v1', 'economy-weekly-request-update-v1'));
        const delivered = await invoke('economy-weekly-request-deliver', handleBase, request('POST', `/economy/weekly-requests/${encodeURIComponent(requestKey)}/deliver`, { inventoryItemId: deliveryItem.id }, headers(sessions.alpha, 'evidence-weekly-delivery-0001')), options, metadata('site.routeAuthed.post.economy.weekly-requests.key.deliver', 'site-economy-weekly-requests-key-deliver-v1', 'site-economy-weekly-requests-deliver-shape-v1', 'economy-weekly-request-deliver-v1'));
        const cancellable = await createWeeklyNpcRequest(db, players.admin, { templateKey: 'pocao_antidoto', pricePercent: 100, globalQuantity: 4, personalLimit: 2, requiredCondition: 'qualquer' }, { via: 'f7_weekly_evidence' });
        const cancelled = await invoke('economy-weekly-request-cancel', handleBase, request('POST', `/economy/weekly-requests/${encodeURIComponent(cancellable.request.key)}/cancel`, undefined, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.weekly-requests.key.cancel', 'site-economy-weekly-requests-key-cancel-v1', 'site-economy-weekly-requests-cancel-shape-v1', 'economy-weekly-request-cancel-v1'));
        return Object.freeze([created, updated, delivered, cancelled]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyItemTemplateProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_item_template_evidence' });
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key = null) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const draft = { templateKey: 'f7_evidence_kit', itemName: 'Kit de Evidencia F7', description: 'Modelo descartavel exclusivo do banco de prova.', basePrice: 50, defaultQuality: 'comum', stackable: true, transferable: true, marketable: true, duplicable: true, requestable: false };
        const created = await invoke('economy-item-template-create', handleBase, request('POST', '/economy/item-templates', draft, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.item-templates', 'site-economy-item-templates-v1', 'site-economy-item-templates-create-shape-v1', 'economy-item-template-create-v1'));
        const templateKey = created.payload.template.key;
        const updated = await invoke('economy-item-template-update', handleBase, request('PATCH', `/economy/item-templates/${encodeURIComponent(templateKey)}`, { basePrice: 60 }, headers(sessions.admin)), options, metadata('site.routeAuthed.patch.economy.item-templates.key', 'site-economy-item-templates-key-v1', 'site-economy-item-templates-update-shape-v1', 'economy-item-template-update-v1'));
        const granted = await invoke('economy-item-template-grant', handleBase, request('POST', `/economy/item-templates/${encodeURIComponent(templateKey)}/grant`, { playerId: players.alpha, quantity: 2 }, headers(sessions.admin, 'evidence-item-template-grant-0001')), options, metadata('site.routeAuthed.post.economy.item-templates.key.grant', 'site-economy-item-templates-key-grant-v1', 'site-economy-item-templates-grant-shape-v1', 'economy-item-template-grant-v1'));
        const archived = await invoke('economy-item-template-archive', handleBase, request('POST', `/economy/item-templates/${encodeURIComponent(templateKey)}/archive`, undefined, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.item-templates.key.archive', 'site-economy-item-templates-key-archive-v1', 'site-economy-item-templates-archive-shape-v1', 'economy-item-template-archive-v1'));
        return Object.freeze([created, updated, granted, archived]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyRedemptionProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_redemption_evidence' });
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token, key = null) => ({ authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const redemptionTemplate = await createItemTemplate(db, players.admin, { templateKey: 'f7_redemption_coupon', itemName: 'Cupom de Resgate F7', description: 'Modelo descartavel para validar a fila de resgates.', category: 'consumivel', kind: 'cupom_pa', basePrice: 25, stackable: true, transferable: true, marketable: true, duplicable: true, requestable: true });
        const approvedItem = (await addCatalogItem(db, players.alpha, redemptionTemplate.template.key, 1, { source: 'f7_redemption_evidence', forceSeparate: true })).items[0];
        const approvedRequest = await invoke('economy-redemption-create-approved', handleBase, request('POST', '/economy/redemptions', { inventoryItemId: approvedItem.id, note: 'Solicitacao de aprovacao F7.' }, headers(sessions.alpha, 'evidence-redemption-approved-0001')), options, metadata('site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-v1', 'site-economy-redemptions-create-shape-v1', 'economy-redemption-create-v1'));
        const approved = await invoke('economy-redemption-approve', handleBase, request('POST', `/economy/redemptions/${encodeURIComponent(approvedRequest.payload.redemption.key)}/approve`, { note: 'Aprovado pela prova F7.' }, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.redemptions.key.approve', 'site-economy-redemptions-key-approve-v1', 'site-economy-redemptions-resolve-shape-v1', 'economy-redemption-approve-v1'));
        const rejectedItem = (await addCatalogItem(db, players.alpha, redemptionTemplate.template.key, 1, { source: 'f7_redemption_evidence', forceSeparate: true })).items[0];
        const rejectedRequest = await invoke('economy-redemption-create-rejected', handleBase, request('POST', '/economy/redemptions', { inventoryItemId: rejectedItem.id, note: 'Solicitacao de rejeicao F7.' }, headers(sessions.alpha, 'evidence-redemption-rejected-0001')), options, metadata('site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-v1', 'site-economy-redemptions-create-shape-v1', 'economy-redemption-create-v1'));
        const rejected = await invoke('economy-redemption-reject', handleBase, request('POST', `/economy/redemptions/${encodeURIComponent(rejectedRequest.payload.redemption.key)}/reject`, { note: 'Rejeitado pela prova F7.' }, headers(sessions.admin)), options, metadata('site.routeAuthed.post.economy.redemptions.key.reject', 'site-economy-redemptions-key-reject-v1', 'site-economy-redemptions-resolve-shape-v1', 'economy-redemption-reject-v1'));
        const cancelledItem = (await addCatalogItem(db, players.alpha, redemptionTemplate.template.key, 1, { source: 'f7_redemption_evidence', forceSeparate: true })).items[0];
        const cancelledRequest = await invoke('economy-redemption-create-cancelled', handleBase, request('POST', '/economy/redemptions', { inventoryItemId: cancelledItem.id, note: 'Solicitacao de cancelamento F7.' }, headers(sessions.alpha, 'evidence-redemption-cancelled-0001')), options, metadata('site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-v1', 'site-economy-redemptions-create-shape-v1', 'economy-redemption-create-v1'));
        const cancelled = await invoke('economy-redemption-cancel', handleBase, request('POST', `/economy/redemptions/${encodeURIComponent(cancelledRequest.payload.redemption.key)}/cancel`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.redemptions.key.cancel', 'site-economy-redemptions-key-cancel-v1', 'site-economy-redemptions-cancel-shape-v1', 'economy-redemption-cancel-v1'));
        return Object.freeze([approvedRequest, approved, rejectedRequest, rejected, cancelledRequest, cancelled]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyTitleAndInitialPackageProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (token) => ({ authorization: `Bearer ${token}` });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const grantedTitle = await grantPlayerTitle(db, players.alpha, { key: 'f7_evidence_title', name: 'Titulo de Evidencia F7' }, { source: 'f7_economy_fixture' });
        const activated = await invoke('economy-title-activate', handleBase, request('POST', `/economy/titles/${encodeURIComponent(grantedTitle.title.key)}/activate`, undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.titles.key.activate', 'site-economy-titles-key-activate-v1', 'site-economy-titles-activate-shape-v1', 'economy-title-activate-v1'));
        const deactivated = await invoke('economy-title-deactivate', handleBase, request('POST', '/economy/titles/deactivate', undefined, headers(sessions.alpha)), options, metadata('site.routeAuthed.post.economy.titles.deactivate', 'site-economy-titles-deactivate-v1', 'site-economy-titles-deactivate-shape-v1', 'economy-title-deactivate-v1'));
        const initialPackage = await invoke('economy-initial-package', handleBase, request('POST', '/economy/initial-package', { equipmentTemplateKey: 'espada_curta' }, headers(sessions.beta)), options, metadata('site.routeAuthed.post.economy.initial-package', 'site-economy-initial-package-v1', 'site-economy-initial-package-shape-v1', 'economy-initial-package-v1'));
        return Object.freeze([activated, deactivated, initialPackage]);
    } finally {
        await fixture.close();
    }
}

async function runBaseEconomyOperationsProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await db.run('UPDATE jogadores SET dinheiro = 100000 WHERE id = ?', [players.alpha]);
        const options = { getDb: () => db };
        const handleBase = async (req, res, requestOptions) => { await base.handleRequest(req, res, requestOptions); return true; };
        const headers = (key) => ({ authorization: `Bearer ${sessions.alpha}`, 'idempotency-key': key });
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const purchasePreview = await invoke('economy-purchase-preview-confirm', handleBase, request('POST', '/economy/purchases/preview', { listingKey: 'pocao_antidoto', quantity: 1 }, headers('evidence-purchase-preview-confirm-0001')), options, metadata('site.routeAuthed.post.economy.purchases.preview', 'site-economy-purchases-preview-v1', 'site-economy-purchases-preview-shape-v1', 'economy-purchase-preview-v1'));
        const purchaseConfirm = await invoke('economy-purchase-confirm', handleBase, request('POST', `/economy/purchases/${encodeURIComponent(purchasePreview.payload.purchase.key)}/confirm`, undefined, headers('evidence-purchase-confirm-0001')), options, metadata('site.routeAuthed.post.economy.purchases.key.confirm', 'site-economy-purchases-key-confirm-v1', 'site-economy-purchases-confirm-shape-v1', 'economy-purchase-confirm-v1'));
        const cancellablePurchase = await invoke('economy-purchase-preview-cancel', handleBase, request('POST', '/economy/purchases/preview', { listingKey: 'kit_campo', quantity: 1 }, headers('evidence-purchase-preview-cancel-0001')), options, metadata('site.routeAuthed.post.economy.purchases.preview', 'site-economy-purchases-preview-v1', 'site-economy-purchases-preview-shape-v1', 'economy-purchase-preview-v1'));
        const purchaseCancel = await invoke('economy-purchase-cancel', handleBase, request('POST', `/economy/purchases/${encodeURIComponent(cancellablePurchase.payload.purchase.key)}/cancel`, undefined, headers('evidence-purchase-cancel-0001')), options, metadata('site.routeAuthed.post.economy.purchases.key.cancel', 'site-economy-purchases-key-cancel-v1', 'site-economy-purchases-cancel-shape-v1', 'economy-purchase-cancel-v1'));
        const saleItem = (await addCatalogItem(db, players.alpha, 'espada_curta', 1, { source: 'f7_economy_operation_evidence', forceSeparate: true })).items[0];
        const salePreview = await invoke('economy-sale-preview', handleBase, request('POST', '/economy/sales/preview', { inventoryItemId: saleItem.id, quantity: 1 }, headers('evidence-sale-preview-0001')), options, metadata('site.routeAuthed.post.economy.sales.preview', 'site-economy-sales-preview-v1', 'site-economy-sales-preview-shape-v1', 'economy-sale-preview-v1'));
        const saleConfirm = await invoke('economy-sale-confirm', handleBase, request('POST', `/economy/sales/${encodeURIComponent(salePreview.payload.sale.key)}/confirm`, undefined, headers('evidence-sale-confirm-0001')), options, metadata('site.routeAuthed.post.economy.sales.key.confirm', 'site-economy-sales-key-confirm-v1', 'site-economy-sales-confirm-shape-v1', 'economy-sale-confirm-v1'));
        const repairItem = (await addCatalogItem(db, players.alpha, 'espada_curta', 1, { source: 'f7_economy_operation_evidence', forceSeparate: true })).items[0];
        await db.run('UPDATE clover_inventory_items SET durability_current = 2 WHERE id = ?', [repairItem.id]);
        const repairPreview = await invoke('economy-repair-preview', handleBase, request('POST', '/economy/repairs/preview', { inventoryItemId: repairItem.id }, headers('evidence-repair-preview-0001')), options, metadata('site.routeAuthed.post.economy.repairs.preview', 'site-economy-repairs-preview-v1', 'site-economy-repairs-preview-shape-v1', 'economy-repair-preview-v1'));
        const repairConfirm = await invoke('economy-repair-confirm', handleBase, request('POST', `/economy/repairs/${encodeURIComponent(repairPreview.payload.repair.key)}/confirm`, undefined, headers('evidence-repair-confirm-0001')), options, metadata('site.routeAuthed.post.economy.repairs.key.confirm', 'site-economy-repairs-key-confirm-v1', 'site-economy-repairs-confirm-shape-v1', 'economy-repair-confirm-v1'));
        const consumableItem = (await addCatalogItem(db, players.alpha, 'pocao_antidoto', 1, { source: 'f7_economy_operation_evidence', forceSeparate: true })).items[0];
        const consumableUse = await invoke('economy-consumable-use', handleBase, request('POST', `/economy/consumables/${encodeURIComponent(consumableItem.id)}/use`, { contextType: 'livre' }, headers('evidence-consumable-use-0001')), options, metadata('site.routeAuthed.post.economy.consumables.itemId.use', 'site-economy-consumables-itemId-use-v1', 'site-economy-consumables-use-shape-v1', 'economy-consumable-use-v1'));
        return Object.freeze([purchasePreview, purchaseConfirm, cancellablePurchase, purchaseCancel, salePreview, saleConfirm, repairPreview, repairConfirm, consumableUse]);
    } finally {
        await fixture.close();
    }
}

async function runAdminReadProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        // The canonical grant is part of the fixture.  The legacy admission is
        // established through the real Admin service so the handler exercises
        // canonical-parity authentication rather than an injected resolver.
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const search = await invoke('admin-player-search', handleAdminApiSupport, request('GET', '/admin/players/search?q=alpha', undefined, headers), options, metadata('admin.players.search', 'admin-player-search-v1', 'admin-player-search-shape-v1', 'admin-player-search-read-v1'));
        const detail = await invoke('admin-player-detail', handleAdminApiSupport, request('GET', `/admin/players/${encodeURIComponent(players.alpha)}`, undefined, headers), options, metadata('admin.player.detail', 'admin-player-detail-v1', 'admin-player-detail-shape-v1', 'admin-player-detail-read-v1'));
        const integrity = await invoke('admin-integrity-summary', handleAdminApiSupport, request('GET', '/admin/integrity/summary?sampleLimit=2', undefined, headers), options, metadata('admin.integrity.summary', 'admin-integrity-summary-v1', 'admin-integrity-summary-shape-v1', 'admin-integrity-summary-read-v1'));
        return Object.freeze([search, detail, integrity]);
    } finally {
        await fixture.close();
    }
}

async function runAdminCatalogReadProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        // Item-template setup deliberately calls the real manager, which also
        // requires the legacy catalog-manager grant in this historical path.
        await assignAccessRole(db, { subjectId: players.admin, role: 'admin', assignedBy: players.admin, reason: 'f7_admin_catalog_read_evidence' });
        const item = await createItemTemplate(db, players.admin, {
            templateKey: 'f7_admin_read_item', itemName: 'Item de Leitura F7', description: 'Modelo descartável para a captura do catálogo administrativo.',
            category: 'consumivel', kind: 'cura', basePrice: 10, stackable: true, transferable: true, marketable: true, duplicable: true, requestable: false,
        });
        const rewardPackage = await createRewardPackage(db, {
            name: 'Pacote de Leitura F7', description: 'Pacote descartável para a captura administrativa.', canonicalKey: 'f7_admin_catalog_reward', entries: [{ type: 'yulls', amount: 5 }],
        }, { actorId: players.admin });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const items = await invoke('admin-items-list', handleAdminItemsReadApi, request('GET', '/admin/items', undefined, headers), options, metadata('admin.items.list', 'admin-item-list-v1', 'admin-item-list-shape-v1', 'admin-item-catalog-list-v1'));
        const itemDetail = await invoke('admin-item-detail', handleAdminItemsReadApi, request('GET', `/admin/items/${encodeURIComponent(item.template.key)}`, undefined, headers), options, metadata('admin.items.detail', 'admin-item-v1', 'admin-item-shape-v1', 'admin-item-catalog-detail-v1'));
        const rewards = await invoke('admin-rewards-list', handleAdminRewardsReadApi, request('GET', '/admin/rewards', undefined, headers), options, metadata('admin.rewards.list', 'admin-reward-list-v1', 'admin-reward-list-shape-v1', 'admin-reward-package-list-v1'));
        const grants = await invoke('admin-reward-grants-list', handleAdminRewardsReadApi, request('GET', '/admin/rewards/grants', undefined, headers), options, metadata('admin.rewards.grants', 'admin-reward-grant-list-v1', 'admin-reward-grant-list-shape-v1', 'admin-reward-grant-list-v1'));
        const rewardDetail = await invoke('admin-reward-detail', handleAdminRewardsReadApi, request('GET', `/admin/rewards/${encodeURIComponent(rewardPackage.id)}`, undefined, headers), options, metadata('admin.rewards.detail', 'admin-reward-v1', 'admin-reward-shape-v1', 'admin-reward-package-detail-v1'));
        return Object.freeze([items, itemDetail, rewards, grants, rewardDetail]);
    } finally {
        await fixture.close();
    }
}

async function runAdminHooksReadProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const hook = await createHookTemplate(db, {
            name: 'Hook de Leitura F7', description: 'Gancho descartável para capturar o contrato administrativo.', objectiveText: 'Registrar a leitura.', completionText: 'Leitura registrada.', canonicalKey: 'f7_admin_read_hook',
        }, { actorId: players.admin });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const list = await invoke('admin-hooks-list', handleAdminHooksReadApi, request('GET', '/admin/hooks', undefined, headers), options, metadata('admin.hooks.list', 'admin-hooks-v2', 'admin-hooks-list-shape-v2', 'admin-hook-template-list-v2'));
        const schema = await invoke('admin-hooks-schema', handleAdminHooksReadApi, request('GET', '/admin/hooks/schema', undefined, headers), options, metadata('admin.hooks.schema', 'admin-hooks-v2', 'admin-hooks-schema-shape-v2', 'admin-hook-v2-schema-v2'));
        const assignments = await invoke('admin-hook-assignments-list', handleAdminHooksReadApi, request('GET', '/admin/hooks/assignments', undefined, headers), options, metadata('admin.hooks.assignments', 'admin-hooks-v2', 'admin-hook-assignments-list-shape-v2', 'admin-hook-assignment-list-v2'));
        const detail = await invoke('admin-hook-detail', handleAdminHooksReadApi, request('GET', `/admin/hooks/${encodeURIComponent(hook.id)}`, undefined, headers), options, metadata('admin.hooks.detail', 'admin-hooks-v2', 'admin-hook-detail-shape-v2', 'admin-hook-template-detail-v2'));
        return Object.freeze([list, schema, assignments, detail]);
    } finally {
        await fixture.close();
    }
}

async function runAdminCommandCenterProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractShapeId, semanticFamily) => ({ descriptorId, contractId: 'admin-command-center-v1', contractShapeId, semanticFamily });
        const inbox = await invoke('admin-command-center-inbox', handleAdminApiSupport, request('GET', '/admin/inbox?limit=2', undefined, headers), options, metadata('admin.command-center.inbox', 'admin-command-center-inbox-shape-v1', 'admin-command-center-inbox-read-v1'));
        const history = await invoke('admin-command-center-history', handleAdminApiSupport, request('GET', '/admin/history?limit=2', undefined, headers), options, metadata('admin.command-center.history', 'admin-command-center-history-shape-v1', 'admin-command-center-history-read-v1'));
        return Object.freeze([inbox, history]);
    } finally {
        await fixture.close();
    }
}

async function runCanonicalAdminTeamProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const ownerAccess = async (_db, actorId) => Object.freeze({
            ok: true,
            actor: Object.freeze({ id: actorId, role: 'owner', capabilities: Object.freeze([]) }),
        });
        const options = {
            getDb: () => db,
            accessResolver: ownerAccess,
            ownerCheck: (id) => id === players.admin,
        };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const metadata = (descriptorId, contractShapeId, semanticFamily) => ({ descriptorId, contractId: 'canonical-admin-team-v1', contractShapeId, semanticFamily });
        const read = await invoke('canonical-admin-team-read', handleAdminApiSupport, request('GET', '/admin/team?changes=2', undefined, headers), options, metadata('admin.canonical-team.read', 'canonical-admin-team-read-shape-v1', 'canonical-admin-team-read-v1'));
        const changeCreate = await invoke('canonical-admin-team-change-create', handleAdminApiSupport, request('POST', '/admin/team/changes', { targetId: players.beta, action: 'set', role: 'narrator', reason: 'EvidÃªncia descartÃ¡vel F7.' }, headers), options, metadata('admin.canonical-team.change.create', 'canonical-admin-team-change-create-shape-v1', 'canonical-admin-team-change-create-v1'));
        const appliedCode = changeCreate.payload.change.code;
        const changeRead = await invoke('canonical-admin-team-change-read', handleAdminApiSupport, request('GET', `/admin/team/changes/${encodeURIComponent(appliedCode)}`, undefined, headers), options, metadata('admin.canonical-team.change.read', 'canonical-admin-team-change-read-shape-v1', 'canonical-admin-team-change-read-v1'));
        const apply = await invoke('canonical-admin-team-change-apply', handleAdminApiSupport, request('POST', `/admin/team/changes/${encodeURIComponent(appliedCode)}/apply`, undefined, headers), options, metadata('admin.canonical-team.change.apply', 'canonical-admin-team-change-apply-shape-v1', 'canonical-admin-team-change-apply-v1'));
        const undo = await invoke('canonical-admin-team-change-undo', handleAdminApiSupport, request('POST', `/admin/team/changes/${encodeURIComponent(appliedCode)}/undo`, { reason: 'Desfazer evidÃªncia descartÃ¡vel F7.' }, headers), options, metadata('admin.canonical-team.change.undo', 'canonical-admin-team-change-undo-shape-v1', 'canonical-admin-team-change-undo-v1'));
        const cancelCreate = await invoke('canonical-admin-team-change-create-for-cancel', handleAdminApiSupport, request('POST', '/admin/team/changes', { targetId: players.beta, action: 'set', role: 'assistant', reason: 'Cancelar evidÃªncia descartÃ¡vel F7.' }, headers), options);
        const cancelCode = cancelCreate.payload.change.code;
        const cancel = await invoke('canonical-admin-team-change-cancel', handleAdminApiSupport, request('POST', `/admin/team/changes/${encodeURIComponent(cancelCode)}/cancel`, undefined, headers), options, metadata('admin.canonical-team.change.cancel', 'canonical-admin-team-change-cancel-shape-v1', 'canonical-admin-team-change-cancel-v1'));
        return Object.freeze([read, changeCreate, changeRead, apply, undo, cancel]);
    } finally {
        await fixture.close();
    }
}

async function runAdminOperationAndTraitProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        // Admission uses the canonical-to-legacy parity service; every
        // operation below then reaches the normal production handler and its
        // Operation Kernel against this disposable SQLite database.
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const trait = await createTraitTemplate(db, {
            id: 'TR-F7A0B1C2', name: 'Traço de Operação F7', slotKey: 'aptidao_comum',
            description: 'Template descartável para evidência de operação administrativa.',
        }, { actorId: players.admin });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}`, 'idempotency-key': 'f7-admin-operation-evidence-0001' };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const traits = await invoke('admin-traits-list', handleAdminApiSupport, request('GET', '/admin/traits?q=Operação', undefined, headers), options, metadata('admin.traits.collection', 'admin-traits-v1', 'admin-traits-list-shape-v1', 'admin-trait-catalog-list-v1'));
        const traitDetail = await invoke('admin-trait-detail', handleAdminApiSupport, request('GET', `/admin/traits/${encodeURIComponent(trait.id)}`, undefined, headers), options, metadata('admin.trait.detail', 'admin-trait-v1', 'admin-trait-detail-shape-v1', 'admin-trait-catalog-detail-v1'));
        const created = await invoke('admin-operation-create', handleAdminApiSupport, request('POST', '/admin/operations', {
            title: 'Atribuir traço descartável F7',
            reason: 'Evidência isolada de contrato administrativo.',
            targets: [{ kind: 'player', playerId: players.alpha }],
            actions: [{ type: 'player.trait.assign', payload: { traitId: trait.id } }],
        }, headers), options, metadata('admin.operations.collection', 'admin-operations-v1', 'admin-operations-collection-shape-v1', 'admin-operations-collection-v1'));
        const code = created.payload.operation.code;
        // The collection read is deliberately executed too.  The public
        // descriptor has GET and POST; the semantic capture is POST because
        // it carries the descriptor's authoritative request contract.
        const list = await invoke('admin-operations-list', handleAdminApiSupport, request('GET', '/admin/operations?q=descartável', undefined, headers), options, metadata('admin.operations.collection', 'admin-operations-v1', 'admin-operations-collection-shape-v1', 'admin-operations-collection-v1'));
        const simulated = await invoke('admin-operation-simulate', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/simulate`, undefined, headers), options, metadata('admin.operation.simulate', 'admin-operation-v1', 'admin-operation-simulate-shape-v1', 'admin-operation-simulate-v1'));
        const approved = await invoke('admin-operation-approve', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/approve`, undefined, headers), options, metadata('admin.operation.approve', 'admin-operation-v1', 'admin-operation-approve-shape-v1', 'admin-operation-approve-v1'));
        const applied = await invoke('admin-operation-apply', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/apply`, undefined, headers), options, metadata('admin.operation.apply', 'admin-operation-v1', 'admin-operation-apply-shape-v1', 'admin-operation-apply-v1'));
        const detail = await invoke('admin-operation-detail', handleAdminApiSupport, request('GET', `/admin/operations/${encodeURIComponent(code)}`, undefined, headers), options, metadata('admin.operation.detail', 'admin-operation-v1', 'admin-operation-detail-shape-v1', 'admin-operation-detail-v1'));
        // retry on an already applied operation is an idempotent real-service
        // success, exercising the recovery handler and its semantic owner
        // without injecting an operation or executor stub.
        const recovery = await invoke('admin-operation-recovery-retry', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/retry`, undefined, headers), options, metadata('admin.operation.recovery', 'admin-operation-recovery-v1', 'admin-operation-recovery-retry-shape-v1', 'admin-operation-recovery-retry-v1'));
        const undone = await invoke('admin-operation-undo', handleAdminApiSupport, request('POST', `/admin/operations/${encodeURIComponent(code)}/undo`, { reason: 'Desfazer evidência descartável F7.' }, headers), options, metadata('admin.operation.undo', 'admin-operation-v1', 'admin-operation-undo-shape-v1', 'admin-operation-undo-v1'));
        return Object.freeze([traits, traitDetail, created, list, simulated, approved, applied, detail, recovery, undone]);
    } finally {
        await fixture.close();
    }
}

async function runAdminSkillApprovalAndRaidReviewProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        // The role grant and every domain operation below use the production
        // services, but only against the fixture's disposable SQLite file.
        await setAdminRole(db, {
            actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin',
        }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        await addPh(db, players.alpha, 200, 'fixture', 'PH extra para aprovações F7', 'fixture');
        const prerequisite = await buyNode(db, players.alpha, 'suporte', 'suporte', players.alpha, { source: 'f7_admin_skill_evidence' });
        if (!prerequisite.ok) throw new Error(`skill_approval_prerequisite_failed:${prerequisite.reason || 'unknown'}`);
        const approvalRequest = await requestSkillApproval(db, players.alpha, 'suporte', 'magigramatica', players.alpha);
        const rejectionRequest = await requestSkillApproval(db, players.alpha, 'suporte', 'praga', players.alpha);
        if (!approvalRequest.created || !rejectionRequest.created) throw new Error('skill_approval_fixture_request_not_created');
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}`, 'idempotency-key': 'f7-admin-skill-approval-evidence-0001' };
        const metadata = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const list = await invoke('admin-skill-approvals-list', handleSkillApprovalHttp, request('GET', '/admin/skill-approvals?status=pending&limit=10', undefined, headers), options, metadata('admin.skill-approvals.list', 'skill-approval-list-v1', 'admin-skill-approval-list-shape-v1', 'admin-skill-approval-list-v1'));
        const approved = await invoke('admin-skill-approval-approve', handleSkillApprovalHttp, request('POST', `/admin/skill-approvals/${encodeURIComponent(approvalRequest.request.request_key)}/approve`, { reason: 'Aprovação descartável F7.' }, headers), options, metadata('admin.skill-approvals.approve', 'skill-approval-v1', 'admin-skill-approval-approve-shape-v1', 'admin-skill-approval-approve-v1'));
        const rejected = await invoke('admin-skill-approval-reject', handleSkillApprovalHttp, request('POST', `/admin/skill-approvals/${encodeURIComponent(rejectionRequest.request.request_key)}/reject`, { reason: 'Rejeição descartável F7.' }, headers), options, metadata('admin.skill-approvals.reject', 'skill-approval-v1', 'admin-skill-approval-reject-shape-v1', 'admin-skill-approval-reject-v1'));
        const raidReviewList = await invoke('admin-raid-reward-proposals-list', handleAdminRaidRewardReviewReadHttp, request('GET', '/admin/raid-reward-proposals?status=pending', undefined, headers), options, metadata('admin.raid-reward-proposals.list', 'admin-raid-reward-proposal-list-v1', 'admin-raid-reward-proposal-list-shape-v1', 'admin-raid-reward-proposal-list-v1'));
        return Object.freeze([list, approved, rejected, raidReviewList]);
    } finally {
        await fixture.close();
    }
}

async function runAdminDreamWorldCatalogAndFragmentProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        await setAdminRole(db, { actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin' }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        const options = { getDb: () => db };
        const headers = { authorization: `Bearer ${sessions.admin}` };
        const meta = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const worldBody = { name: 'Fenda de Evidência F7', universe: 'Arquivo descartável', synopsis: 'Fenda criada somente na SQLite descartável.', dreamType: 'self', rank: 'A', status: 'announced', yullsPrice: 3000, manualPaymentEnabled: true, manualPriceLabel: 'R$ 30,00', minPlayers: 2, maxPlayers: 4, slots: { squad: 1, invited: 1, public: 2 } };
        const created = await invoke('admin-dream-world-create', handleDreamWorldsHttp, request('POST', '/admin/dream-worlds', worldBody, headers), options, meta('admin.dream-worlds.create', 'admin-dream-world-v1', 'admin-dream-world-create-shape-v1', 'admin-dream-world-create-v1'));
        const slug = created.payload.world.slug;
        const list = await invoke('admin-dream-worlds-list', handleDreamWorldsHttp, request('GET', '/admin/dream-worlds?status=announced', undefined, headers), options, meta('admin.dream-worlds.list', 'admin-dream-world-list-v1', 'admin-dream-world-list-shape-v1', 'admin-dream-world-list-v1'));
        const acquisition = await invoke('admin-dream-world-acquisition', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/${encodeURIComponent(slug)}/acquisition`, { yullsPrice: 3200, manualPaymentEnabled: true, manualPriceLabel: 'R$ 32,00', reason: 'Ajuste descartável F7.' }, headers), options, meta('admin.dream-worlds.acquisition.update', 'admin-dream-world-v1', 'admin-dream-world-acquisition-shape-v1', 'admin-dream-world-acquisition-v1'));
        const status = await invoke('admin-dream-world-status', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/${encodeURIComponent(slug)}/status`, { status: 'available' }, headers), options, meta('admin.dream-worlds.status.transition', 'admin-dream-world-v1', 'admin-dream-world-status-shape-v1', 'admin-dream-world-status-v1'));
        const fragmentBody = { name: 'Fragmento F7', category: 'style', publicDescription: 'Fragmento descartável de evidência.', status: 'review', publicVisible: true };
        const fragmentCreated = await invoke('admin-dream-fragment-create', handleDreamWorldsHttp, request('POST', '/admin/dream-worlds/fragments', fragmentBody, headers), options, meta('admin.dream-worlds.fragments.create', 'admin-dream-fragment-v1', 'admin-dream-fragment-create-shape-v1', 'admin-dream-fragment-create-v1'));
        const fragmentSlug = fragmentCreated.payload.fragment.slug;
        const fragmentList = await invoke('admin-dream-fragments-list', handleDreamWorldsHttp, request('GET', '/admin/dream-worlds/fragments?status=review', undefined, headers), options, meta('admin.dream-worlds.fragments.list', 'admin-dream-fragment-list-v1', 'admin-dream-fragment-list-shape-v1', 'admin-dream-fragment-list-v1'));
        const fragmentUpdated = await invoke('admin-dream-fragment-update', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/fragments/${encodeURIComponent(fragmentSlug)}/update`, { status: 'active', reason: 'Revisão descartável F7.' }, headers), options, meta('admin.dream-worlds.fragments.update', 'admin-dream-fragment-v1', 'admin-dream-fragment-update-shape-v1', 'admin-dream-fragment-update-v1'));
        const fragmentGranted = await invoke('admin-dream-fragment-grant', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/fragments/${encodeURIComponent(fragmentSlug)}/grant`, { playerId: players.alpha, status: 'active', reason: 'Concessão descartável F7.' }, headers), options, meta('admin.dream-worlds.fragments.grant', 'admin-dream-fragment-v1', 'admin-dream-fragment-grant-shape-v1', 'admin-dream-fragment-grant-v1'));
        return Object.freeze([created, list, acquisition, status, fragmentCreated, fragmentList, fragmentUpdated, fragmentGranted]);
    } finally { await fixture.close(); }
}

async function runAdminDreamWorldLifecycleProbes() {
    const fixture = await createPreResetSiteApiEvidenceFixture();
    try {
        const { db, players, sessions } = fixture;
        const replacementPlayer = 'fixture-dream-replacement@lid';
        await setAdminRole(db, { actorId: 'fixture-owner@lid', targetId: players.admin, role: 'admin' }, { ownerCheck: (id) => id === 'fixture-owner@lid' });
        await db.run(`INSERT INTO jogadores (id, nome, raca, dinheiro, ficha_status, jogo_status)
            VALUES (?, 'replacement', 'Humano ativo', 77, 'aprovada', 'liberado')`, [replacementPlayer]);
        await addYulls(db, players.alpha, 50000, 'fixture', 'Saldo descartável para evidência F7 Dream Worlds.', 'fixture');

        const options = { getDb: () => db };
        const adminHeaders = { authorization: `Bearer ${sessions.admin}` };
        const alphaHeaders = { authorization: `Bearer ${sessions.alpha}` };
        const betaHeaders = { authorization: `Bearer ${sessions.beta}` };
        const meta = (descriptorId, contractId, contractShapeId, semanticFamily) => ({ descriptorId, contractId, contractShapeId, semanticFamily });
        const worldBody = (suffix) => ({
            name: `Fenda Lifecycle F7 ${suffix}`,
            slug: `f7-lifecycle-${suffix}`,
            universe: 'Arquivo descartável de contratos',
            synopsis: 'Fenda criada somente na SQLite descartável para provar o ciclo administrativo.',
            dreamType: 'self', rank: 'A', status: 'available', yullsPrice: 1000,
            manualPaymentEnabled: true, manualPriceLabel: 'R$ 10,00',
            minPlayers: 2, maxPlayers: 4, slots: { squad: 0, invited: 1, public: 3 }, knownChapters: 3,
        });
        const firstOpenPublicSlot = async (runId) => db.get(
            `SELECT id FROM clover_dream_slots WHERE run_id = ? AND category = 'public' AND status = 'open' ORDER BY id LIMIT 1`,
            [Number(runId)]
        );
        const createRun = async (suffix) => {
            const world = await createDreamWorld(db, worldBody(suffix), players.admin);
            const submitted = await submitDreamRequest(db, players.alpha, world.slug, {
                buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: `f7-lifecycle-direct-${suffix}`,
            });
            const approval = await approveDreamRequest(db, submitted.request.id, players.admin, { narratorIds: [players.admin] });
            return { world, run: approval.run };
        };
        const createReadyRun = async (suffix) => {
            const created = await createRun(suffix);
            const slot = await firstOpenPublicSlot(created.run.id);
            await assignDreamSlotWithPolicy(db, created.run.id, slot.id, players.beta, players.admin, { mode: 'confirmed' });
            return created;
        };

        const approvalWorld = await createDreamWorld(db, worldBody('request-approval'), players.admin);
        const submittedRequest = await invoke(
            'admin-dream-request-submit-fixture', handleDreamWorldsHttp,
            request('POST', `/dream-worlds/${encodeURIComponent(approvalWorld.slug)}/requests`, {
                buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: 'f7-lifecycle-http-request-approval', playerNote: 'Solicitação descartável F7.',
            }, { ...alphaHeaders, 'idempotency-key': 'f7-lifecycle-http-request-approval' }), options
        );
        if (submittedRequest.status !== 201) throw new Error(`dream_request_fixture_failed:${submittedRequest.status}`);
        const requests = await invoke('admin-dream-requests-list', handleDreamWorldsHttp, request('GET', '/admin/dream-worlds/requests?status=submitted', undefined, adminHeaders), options, meta('admin.dream-worlds.requests', 'admin-dream-request-list-v1', 'admin-dream-request-list-shape-v1', 'admin-dream-request-list-v1'));
        const approved = await invoke('admin-dream-request-approve', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/requests/${encodeURIComponent(submittedRequest.payload.request.id)}/approve`, { narratorIds: [players.admin], adminNote: 'Aprovação descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.request.approve', 'admin-dream-request-v1', 'admin-dream-request-approve-shape-v1', 'admin-dream-request-approve-v1'));
        if (approved.status !== 200) throw new Error(`dream_request_approval_failed:${approved.status}`);
        const mainRun = approved.payload.run;

        const rejectedWorld = await createDreamWorld(db, worldBody('request-rejection'), players.admin);
        const rejectedRequest = await submitDreamRequest(db, players.alpha, rejectedWorld.slug, { buyerType: 'player', paymentMethod: 'yulls', idempotencyKey: 'f7-lifecycle-direct-request-rejection' });
        const rejected = await invoke('admin-dream-request-reject', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/requests/${encodeURIComponent(rejectedRequest.request.id)}/reject`, { adminNote: 'Recusa descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.request.reject', 'admin-dream-request-v1', 'admin-dream-request-reject-shape-v1', 'admin-dream-request-reject-v1'));

        const submittedApplication = await invoke('admin-dream-application-submit-fixture', handleDreamWorldsHttp, request('POST', `/dream-worlds/${encodeURIComponent(approvalWorld.slug)}/applications`, { idempotencyKey: 'f7-lifecycle-http-application-select', playerNote: 'Candidatura descartável F7.' }, { ...betaHeaders, 'idempotency-key': 'f7-lifecycle-http-application-select' }), options);
        if (submittedApplication.status !== 201) throw new Error(`dream_application_fixture_failed:${submittedApplication.status}`);
        const applications = await invoke('admin-dream-applications-list', handleDreamWorldsHttp, request('GET', `/admin/dream-worlds/applications?run=${encodeURIComponent(mainRun.id)}&status=submitted`, undefined, adminHeaders), options, meta('admin.dream-worlds.applications', 'admin-dream-application-list-v1', 'admin-dream-application-list-shape-v1', 'admin-dream-application-list-v1'));
        const reviewed = await invoke('admin-dream-application-review', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/applications/${encodeURIComponent(submittedApplication.payload.application.id)}/review`, { adminNote: 'Revisão descartável F7.', reason: 'Validação real de fluxo.' }, adminHeaders), options, meta('admin.dream-worlds.application.review', 'admin-dream-application-v1', 'admin-dream-application-review-shape-v1', 'admin-dream-application-review-v1'));
        const selected = await invoke('admin-dream-application-select', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/applications/${encodeURIComponent(submittedApplication.payload.application.id)}/select`, { mode: 'invited', adminNote: 'Seleção descartável F7.', reason: 'Reserva via fluxo real.' }, adminHeaders), options, meta('admin.dream-worlds.application.select', 'admin-dream-application-v1', 'admin-dream-application-select-shape-v1', 'admin-dream-application-select-v1'));

        const applicationRejectFixture = await createRun('application-reject');
        const rejectedApplicationFixture = await invoke('admin-dream-application-reject-fixture', handleDreamWorldsHttp, request('POST', `/dream-worlds/${encodeURIComponent(applicationRejectFixture.world.slug)}/applications`, { idempotencyKey: 'f7-lifecycle-http-application-reject', playerNote: 'Candidatura de recusa F7.' }, { ...betaHeaders, 'idempotency-key': 'f7-lifecycle-http-application-reject' }), options);
        if (rejectedApplicationFixture.status !== 201) throw new Error(`dream_application_reject_fixture_failed:${rejectedApplicationFixture.status}`);
        const applicationRejected = await invoke('admin-dream-application-reject', handleDreamWorldsHttp, request('POST', `/admin/dream-worlds/applications/${encodeURIComponent(rejectedApplicationFixture.payload.application.id)}/reject`, { adminNote: 'Recusa descartável F7.', reason: 'Fluxo recusado de modo real.' }, adminHeaders), options, meta('admin.dream-worlds.application.reject', 'admin-dream-application-v1', 'admin-dream-application-reject-shape-v1', 'admin-dream-application-reject-v1'));

        const runs = await invoke('admin-dream-runs-list', handleDreamWorldsOperationsHttp, request('GET', '/admin/dream-worlds/runs?status=forming_group', undefined, adminHeaders), options, meta('admin.dream-worlds.runs.list', 'admin-dream-run-list-v1', 'admin-dream-run-list-shape-v1', 'admin-dream-run-list-v1'));
        const detail = await invoke('admin-dream-run-detail', handleDreamWorldsOperationsHttp, request('GET', `/admin/dream-worlds/runs/${encodeURIComponent(mainRun.id)}`, undefined, adminHeaders), options, meta('admin.dream-worlds.runs.detail', 'admin-dream-run-v1', 'admin-dream-run-detail-shape-v1', 'admin-dream-run-detail-v1'));

        const inviteFixture = await createRun('slot-invite');
        const inviteSlot = await firstOpenPublicSlot(inviteFixture.run.id);
        const invited = await invoke('admin-dream-slot-invite', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(inviteFixture.run.id)}/slots/${encodeURIComponent(inviteSlot.id)}/invite`, { playerId: players.beta }, adminHeaders), options, meta('admin.dream-worlds.slot.invite', 'admin-dream-run-v1', 'admin-dream-slot-invite-shape-v1', 'admin-dream-slot-invite-v1'));

        const confirmFixture = await createRun('slot-confirm');
        const confirmSlot = await firstOpenPublicSlot(confirmFixture.run.id);
        const confirmed = await invoke('admin-dream-slot-confirm', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(confirmFixture.run.id)}/slots/${encodeURIComponent(confirmSlot.id)}/confirm`, { playerId: players.beta }, adminHeaders), options, meta('admin.dream-worlds.slot.confirm', 'admin-dream-run-v1', 'admin-dream-slot-confirm-shape-v1', 'admin-dream-slot-confirm-v1'));

        const removeFixture = await createRun('slot-remove');
        const removeSlot = await firstOpenPublicSlot(removeFixture.run.id);
        await assignDreamSlotWithPolicy(db, removeFixture.run.id, removeSlot.id, players.beta, players.admin, { mode: 'invited' });
        const removed = await invoke('admin-dream-slot-remove', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(removeFixture.run.id)}/slots/${encodeURIComponent(removeSlot.id)}/remove`, { reason: 'Remoção descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.slot.remove', 'admin-dream-run-v1', 'admin-dream-slot-remove-shape-v1', 'admin-dream-slot-remove-v1'));

        const replaceFixture = await createRun('slot-replace');
        const replaceSlot = await firstOpenPublicSlot(replaceFixture.run.id);
        await assignDreamSlotWithPolicy(db, replaceFixture.run.id, replaceSlot.id, players.beta, players.admin, { mode: 'invited' });
        const replaced = await invoke('admin-dream-slot-replace', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(replaceFixture.run.id)}/slots/${encodeURIComponent(replaceSlot.id)}/replace`, { playerId: replacementPlayer, mode: 'confirmed' }, adminHeaders), options, meta('admin.dream-worlds.slot.replace', 'admin-dream-run-v1', 'admin-dream-slot-replace-shape-v1', 'admin-dream-slot-replace-v1'));

        const lifecycleFixture = await createReadyRun('run-lifecycle');
        const started = await invoke('admin-dream-run-start', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/start`, undefined, adminHeaders), options, meta('admin.dream-worlds.run.start', 'admin-dream-run-v1', 'admin-dream-run-start-shape-v1', 'admin-dream-run-start-v1'));
        const advanced = await invoke('admin-dream-run-advance', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/advance`, { chapter: 2 }, adminHeaders), options, meta('admin.dream-worlds.run.advance', 'admin-dream-run-v1', 'admin-dream-run-advance-shape-v1', 'admin-dream-run-advance-v1'));
        const paused = await invoke('admin-dream-run-pause', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/pause`, { reason: 'Pausa descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.pause', 'admin-dream-run-v1', 'admin-dream-run-pause-shape-v1', 'admin-dream-run-pause-v1'));
        const resumed = await invoke('admin-dream-run-resume', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/resume`, { reason: 'Retomada descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.resume', 'admin-dream-run-v1', 'admin-dream-run-resume-shape-v1', 'admin-dream-run-resume-v1'));
        const completed = await invoke('admin-dream-run-complete', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(lifecycleFixture.run.id)}/complete`, { reason: 'Conclusão descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.complete', 'admin-dream-run-v1', 'admin-dream-run-complete-shape-v1', 'admin-dream-run-complete-v1'));

        const failFixture = await createReadyRun('run-fail');
        await transitionDreamRun(db, failFixture.run.id, 'start', players.admin);
        const failed = await invoke('admin-dream-run-fail', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(failFixture.run.id)}/fail`, { reason: 'Falha descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.fail', 'admin-dream-run-v1', 'admin-dream-run-fail-shape-v1', 'admin-dream-run-fail-v1'));
        const cancelFixture = await createRun('run-cancel');
        const cancelled = await invoke('admin-dream-run-cancel', handleDreamWorldsOperationsHttp, request('POST', `/admin/dream-worlds/runs/${encodeURIComponent(cancelFixture.run.id)}/cancel`, { reason: 'Cancelamento descartável F7.' }, adminHeaders), options, meta('admin.dream-worlds.run.cancel', 'admin-dream-run-v1', 'admin-dream-run-cancel-shape-v1', 'admin-dream-run-cancel-v1'));

        return Object.freeze([requests, applications, reviewed, selected, applicationRejected, approved, rejected, runs, detail, invited, confirmed, removed, replaced, started, advanced, paused, resumed, completed, failed, cancelled]);
    } finally { await fixture.close(); }
}

async function runBaseHandlerBoundaryProbes() {
    const missingDb = { getDb: () => null };
    const basePublic = await invoke('base-public', (req, res) => base.routePublic(req, res, null, 'GET', ['health'], '/health'), request('GET', '/health'), {});
    const baseSession = await invoke('base-session', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['auth', 'logout'], { player: { id: 'probe' } }, '/auth/logout'), request('POST', '/auth/logout'), {});
    const baseEconomy = await invoke('base-economy', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['economy', 'purchases', 'preview'], { player: { id: 'probe' } }, '/economy/purchases/preview'), request('POST', '/economy/purchases/preview', {}), {});
    const adminAccess = {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'probe-admin', nome: 'Probe Admin' } }),
        accessResolver: async () => ({ ok: true, actor: { id: 'probe-admin', role: 'admin', capabilities: ['operation.view'] } }),
    };
    return Object.freeze([
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
    ]);
}

const DEFAULT_PROBE_CONCURRENCY = 3;
const PARALLEL_SAFE = 'parallel-safe';
const SERIAL_REQUIRED = 'serial-required';

function criticalProbeGroups(options = {}) {
    // Source audit: every group owns a disposable SQLite fixture and its own
    // cleanup.  The serial groups additionally reach the process-global
    // economyMutationQueue (directly or through base/raid/skill/dream
    // handlers), so they must not overlap another group.  The admin fixture
    // helpers also share admission/cache state across their setup paths; the
    // focused concurrency smoke caught that coupling, so they remain serial.
    const localGroups = [
        { name: 'base', mode: PARALLEL_SAFE, run: runBaseHandlerBoundaryProbes },
        { name: 'pre-reset', mode: PARALLEL_SAFE, run: runPreResetRealSuccessProbes },
        { name: 'site-base-session-progression', mode: SERIAL_REQUIRED, run: runBaseSessionProgressionProbes },
        { name: 'site-base-raid-lifecycle', mode: SERIAL_REQUIRED, run: runBaseRaidLifecycleProbes },
        { name: 'raid-canonical', mode: SERIAL_REQUIRED, run: runRaidCanonicalProbes },
        { name: 'dream-worlds-canonical', mode: SERIAL_REQUIRED, run: runDreamWorldsCanonicalProbes },
        { name: 'skill-tree-purchase', mode: SERIAL_REQUIRED, run: runSkillTreePurchaseProbe },
        { name: 'squad-canonical', mode: PARALLEL_SAFE, run: runSquadCanonicalProbes },
        { name: 'recruitment-canonical', mode: SERIAL_REQUIRED, run: runRecruitmentCanonicalProbes },
        { name: 'base-canonical-residual', mode: SERIAL_REQUIRED, run: runBaseCanonicalResidualProbes },
        { name: 'economy-payment', mode: SERIAL_REQUIRED, run: runBaseEconomyPaymentProbes },
        { name: 'economy-market', mode: SERIAL_REQUIRED, run: runBaseEconomyMarketProbes },
        { name: 'economy-trade', mode: SERIAL_REQUIRED, run: runBaseEconomyTradeProbes },
        { name: 'economy-weekly-request', mode: SERIAL_REQUIRED, run: runBaseEconomyWeeklyRequestProbes },
        { name: 'economy-item-template', mode: SERIAL_REQUIRED, run: runBaseEconomyItemTemplateProbes },
        { name: 'economy-redemption', mode: SERIAL_REQUIRED, run: runBaseEconomyRedemptionProbes },
        { name: 'economy-title-initial-package', mode: SERIAL_REQUIRED, run: runBaseEconomyTitleAndInitialPackageProbes },
        { name: 'economy-operations', mode: SERIAL_REQUIRED, run: runBaseEconomyOperationsProbes },
        { name: 'admin-read', mode: SERIAL_REQUIRED, run: runAdminReadProbes },
        { name: 'admin-catalog-read', mode: SERIAL_REQUIRED, run: runAdminCatalogReadProbes },
        { name: 'admin-hooks-read', mode: SERIAL_REQUIRED, run: runAdminHooksReadProbes },
        { name: 'admin-command-center', mode: SERIAL_REQUIRED, run: runAdminCommandCenterProbes },
        { name: 'admin-canonical-team', mode: SERIAL_REQUIRED, run: runCanonicalAdminTeamProbes },
        { name: 'admin-operation-trait', mode: SERIAL_REQUIRED, run: runAdminOperationAndTraitProbes },
        { name: 'admin-skill-approval-raid-review', mode: SERIAL_REQUIRED, run: runAdminSkillApprovalAndRaidReviewProbes },
        { name: 'admin-dream-world-catalog-fragment', mode: SERIAL_REQUIRED, run: runAdminDreamWorldCatalogAndFragmentProbes },
        { name: 'admin-dream-world-lifecycle', mode: SERIAL_REQUIRED, run: runAdminDreamWorldLifecycleProbes },
    ];
    if (!options.isolated) return Object.freeze(localGroups);
    // Forking is orchestration-only isolation: all production handlers still
    // execute unchanged, but their module-level queues/caches are process
    // local. Fixtures already use mkdtemp and port 0, so no cross-worker DB,
    // filesystem, TCP, environment, or singleton state remains.
    return Object.freeze(localGroups.map((group) => Object.freeze({
        ...group,
        mode: PARALLEL_SAFE,
        run: () => runProbeGroupInWorker(group.name),
    })));
}

function runProbeGroupInWorker(name) {
    return new Promise((resolve, reject) => {
        const worker = fork(path.join(__dirname, 'siteApiHandlerBoundaryProbeWorker.js'), [name], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        let settled = false;
        const settle = (callback, value) => {
            if (settled) return;
            settled = true;
            callback(value);
        };
        worker.once('error', (error) => settle(reject, error));
        worker.on('message', (message) => {
            if (message?.ok) settle(resolve, message.captures);
            else if (message?.error) settle(reject, Object.assign(new Error(message.error.message), { stack: message.error.stack }));
        });
        worker.once('exit', (code, signal) => {
            if (!settled) settle(reject, new Error(`critical_probe_worker_exit:${name}:${code ?? 'null'}:${signal || 'none'}`));
        });
    });
}

class ProbeGroupExecutionError extends Error {
    constructor(group, cause, schedule) {
        super(`critical_probe_group_failed:${group.name}:${cause?.message || cause}`);
        this.name = 'ProbeGroupExecutionError';
        this.group = group.name;
        this.cause = cause;
        this.schedule = schedule;
    }
}

async function runBoundedProbeGroups(groups, options = {}) {
    const maxConcurrency = Number.isInteger(options.maxConcurrency) && options.maxConcurrency > 0
        ? options.maxConcurrency : DEFAULT_PROBE_CONCURRENCY;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const names = groups.map((group) => group?.name);
    if (new Set(names).size !== groups.length || groups.some((group) => !group?.name || typeof group.run !== 'function' || ![PARALLEL_SAFE, SERIAL_REQUIRED].includes(group.mode))) {
        throw new TypeError('invalid_critical_probe_groups');
    }
    const startedAt = Date.now();
    const outcomes = Array(groups.length);
    const executed = [];
    let inFlight = 0;
    let maxInFlightObserved = 0;
    let firstFailure = null;
    const emit = (stage, status, details = {}) => {
        try { onProgress(Object.freeze({ stage, status, ...details })); } catch { /* Observability must not change probe semantics. */ }
    };
    const execute = async (index) => {
        const group = groups[index];
        executed.push(group.name);
        inFlight += 1;
        maxInFlightObserved = Math.max(maxInFlightObserved, inFlight);
        emit(group.name, 'START');
        try {
            const captures = await group.run();
            outcomes[index] = Object.freeze({ name: group.name, mode: group.mode, status: 'PASS', captures: Object.freeze(Array.isArray(captures) ? captures : [captures]) });
            emit(group.name, 'PASS', { captures: outcomes[index].captures.length });
        } catch (error) {
            outcomes[index] = Object.freeze({ name: group.name, mode: group.mode, status: 'FAIL', captures: Object.freeze([]), error });
            emit(group.name, 'FAIL', { error: error?.message || String(error) });
            if (!firstFailure) firstFailure = { group, error };
        } finally {
            inFlight -= 1;
        }
    };
    const runParallelBatch = async (indexes) => {
        let cursor = 0;
        const worker = async () => {
            while (!firstFailure && cursor < indexes.length) {
                const index = indexes[cursor++];
                await execute(index);
            }
        };
        await Promise.all(Array.from({ length: Math.min(maxConcurrency, indexes.length) }, worker));
    };
    let parallelBatch = [];
    for (let index = 0; index < groups.length; index += 1) {
        if (groups[index].mode === PARALLEL_SAFE) {
            parallelBatch.push(index);
            continue;
        }
        if (parallelBatch.length) {
            await runParallelBatch(parallelBatch);
            parallelBatch = [];
            if (firstFailure) break;
        }
        await execute(index);
        if (firstFailure) break;
    }
    if (!firstFailure && parallelBatch.length) await runParallelBatch(parallelBatch);
    const schedule = Object.freeze({
        groups: groups.length,
        executed: executed.length,
        missing: groups.filter((group) => !executed.includes(group.name)).map((group) => group.name),
        duplicated: [...new Set(executed.filter((name, index) => executed.indexOf(name) !== index))],
        maxConcurrency,
        maxInFlightObserved,
        serialGroups: groups.filter((group) => group.mode === SERIAL_REQUIRED).length,
        parallelSafeGroups: groups.filter((group) => group.mode === PARALLEL_SAFE).length,
        wallClockMs: Date.now() - startedAt,
        outcomes: Object.freeze(outcomes.filter(Boolean)),
    });
    if (firstFailure) throw new ProbeGroupExecutionError(firstFailure.group, firstFailure.error, schedule);
    return schedule;
}

async function runCriticalHandlerBoundaryProbes(overrides = {}) {
    const groups = criticalProbeGroups({ isolated: true });
    let schedule;
    try {
        schedule = await runBoundedProbeGroups(groups, { maxConcurrency: overrides.maxConcurrency, onProgress: overrides.onProgress });
    } catch (error) {
        if (!(error instanceof ProbeGroupExecutionError)) throw error;
        const captures = error.schedule.outcomes.flatMap((outcome) => outcome.captures);
        const failures = error.schedule.outcomes.filter((outcome) => outcome.status === 'FAIL')
            .map((outcome) => Object.freeze({ name: `probe-group:${outcome.name}`, recognized: false, outcome: 'GROUP_FAILURE', error: outcome.error?.message || String(outcome.error) }));
        return Object.freeze({ total: captures.length + failures.length, probed: captures.length, failures, captures, probes: captures, schedule: error.schedule });
    }
    const probes = schedule.outcomes.flatMap((outcome) => outcome.captures);
    const selected = overrides.disableFamily ? probes.filter((probe) => !probe.name.startsWith(overrides.disableFamily)) : probes;
    return Object.freeze({ total: probes.length, probed: selected.length, failures: selected.filter((probe) => !probe.recognized), captures: selected.filter((probe) => probe.outcome === 'MATCHED_SUCCESS' && probe.payload), probes: selected, schedule });
}

module.exports = {
    runCriticalHandlerBoundaryProbes,
    __test: { DEFAULT_PROBE_CONCURRENCY, PARALLEL_SAFE, SERIAL_REQUIRED, criticalProbeGroups, runBoundedProbeGroups, runProbeGroupInWorker, runBaseHandlerBoundaryProbes, runPreResetRealSuccessProbes, runAdminReadProbes, runAdminCatalogReadProbes, runAdminHooksReadProbes, runAdminCommandCenterProbes, runCanonicalAdminTeamProbes, runAdminOperationAndTraitProbes, runBaseSessionProgressionProbes, runBaseRaidLifecycleProbes, runRaidCanonicalProbes, runDreamWorldsCanonicalProbes, runSkillTreePurchaseProbe, runSquadCanonicalProbes, runRecruitmentCanonicalProbes, runBaseCanonicalResidualProbes, runAdminSkillApprovalAndRaidReviewProbes, runAdminDreamWorldCatalogAndFragmentProbes, runAdminDreamWorldLifecycleProbes },
};
