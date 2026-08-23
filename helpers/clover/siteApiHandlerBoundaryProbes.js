'use strict';

const { Readable } = require('stream');
const { __test: base } = require('./siteApiServerBase');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleDreamWorldsHttp } = require('./dreamWorldsHttp');
const { handlePrShopSupport } = require('./siteApiServerLegacy');

function request(method, url, body) {
    const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = {};
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
function result(name, handled, res, error) {
    const recognized = handled === true || Boolean(error) || res.statusCode >= 400;
    let payload = null;
    try { payload = res.body ? JSON.parse(res.body) : null; } catch { payload = null; }
    return Object.freeze({ name, recognized, outcome: error ? 'MATCHED_DEPENDENCY_FAILURE' : res.statusCode >= 400 ? 'MATCHED_EXPECTED_DENIAL' : 'MATCHED_SUCCESS', status: res.statusCode, payload, error: error ? String(error.code || error.message || 'error') : null });
}
async function invoke(name, handler, req, options) {
    const res = response();
    try { return result(name, await handler(req, res, options), res, null); }
    catch (error) { return result(name, false, res, error); }
}

async function runCriticalHandlerBoundaryProbes(overrides = {}) {
    const missingDb = { getDb: () => null };
    const basePublic = await invoke('base-public', (req, res) => base.routePublic(req, res, null, 'GET', ['health'], '/health'), request('GET', '/health'), {});
    const baseSession = await invoke('base-session', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['auth', 'logout'], { player: { id: 'probe' } }, '/auth/logout'), request('POST', '/auth/logout'), {});
    const baseEconomy = await invoke('base-economy', (req, res) => base.routeAuthed(req, res, {}, 'POST', ['economy', 'purchases', 'preview'], { player: { id: 'probe' } }, '/economy/purchases/preview'), request('POST', '/economy/purchases/preview', {}), {});
    const probes = [
        basePublic, baseSession, baseEconomy,
        await invoke('pre-reset', handlePreResetSiteApi, request('GET', '/pre-reset/future-character'), missingDb),
        await invoke('admin', handleAdminApiSupport, request('GET', '/admin/bootstrap'), missingDb),
        await invoke('raid', handleRaidCoreIdempotentHttp, request('POST', '/raids', {}), missingDb),
        await invoke('skill-approval', handleSkillApprovalHttp, request('POST', '/trees/example-tree/purchase', {}), missingDb),
        await invoke('squad', handleSquadMembershipTransferHttp, request('POST', '/squads/a/members/b/transfer', {}), missingDb),
        await invoke('dream-worlds', handleDreamWorldsHttp, request('GET', '/dream-worlds'), missingDb),
        await invoke('recruitment', handlePrShopSupport, request('GET', '/recruitment/shop'), missingDb),
    ];
    const selected = overrides.disableFamily ? probes.filter((probe) => probe.name !== overrides.disableFamily) : probes;
    return Object.freeze({ total: probes.length, probed: selected.length, failures: selected.filter((probe) => !probe.recognized), captures: selected.filter((probe) => probe.outcome === 'MATCHED_SUCCESS' && probe.payload), probes: selected });
}

module.exports = { runCriticalHandlerBoundaryProbes };
