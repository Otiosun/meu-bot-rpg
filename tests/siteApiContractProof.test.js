'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalRuntimeDescriptors, auditRoutes } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, baseRouteAudit, compareContractBaselines, criticalSchemaDrift, normalizedContractBaseline } = require('../helpers/clover/siteApiContractAudit');
const { validateContractPayload } = require('../helpers/clover/siteApiContractShapes');

function descriptors() { return canonicalRuntimeDescriptors(); }
function audit(overrides = {}) { return auditPublicContracts(descriptors(), overrides); }
function route(id) { return descriptors().find((descriptor) => descriptor.id === id); }
function baseSource() { return fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'siteApiServerBase.js'), 'utf8'); }

test('F7 resolves executable shapes and probes every public descriptor', () => {
    const result = audit();
    assert.deepEqual(result.unresolvedPublicContractShapes, []);
    assert.ok(result.opaqueDtoLabelsCritical.length > 0, 'broad critical family shapes must not receive a false-green');
    assert.deepEqual(result.descriptorSampleFailures, []);
    assert.ok(result.publicRoutes.every((descriptor) => validateContractPayload(descriptor.contractId, 'error', { ok: false, error: 'safe', message: 'safe' }, result.registry).ok));
});

test('F7 validator rejects missing and mistyped critical fields', () => {
    const registry = audit().registry;
    assert.equal(validateContractPayload('site-auth-login-v1', 'response', { ok: true, token: 'session-token', expiresAt: '2030-01-01T00:00:00.000Z', player: {} }, registry).ok, true);
    assert.equal(validateContractPayload('site-auth-login-v1', 'response', { ok: true, token: 1, expiresAt: 'x', player: {} }, registry).ok, false);
    assert.equal(validateContractPayload('skill-purchase-v1', 'response', { ok: true, purchase: {} }, registry).ok, false);
});

test('F7 independent source evidence, ownership, auth and public projection agree', () => {
    const result = audit();
    assert.deepEqual(result.unreachablePublicDescriptors, []);
    assert.deepEqual(result.sourceOnlyPublicRoutes, []);
    assert.deepEqual(result.publicDuplicateMethodPaths, []);
    assert.deepEqual(result.shadowedPublicLeaks, []);
    assert.deepEqual(result.genericMethodDescriptors, []);
    assert.deepEqual(result.handlerOwnerDrift, []);
    assert.deepEqual(result.authContractDrift, []);
    assert.ok(result.baseWitnesses.length > 0);
});

test('F7 negative matrix fails closed for source, descriptor, owner, auth and shape drift', (t) => {
    const all = descriptors();
    const source = baseSource();
    const login = route('site.routePublic.post.auth.login');
    assert.ok(audit({ baseSource: `${source}\nif (method === 'GET' && parts[0] === 'new-reachable-route' && parts.length === 1) {` }).sourceOnlyPublicRoutes.length > 0, 'new route');
    assert.ok(baseRouteAudit(all.map((descriptor) => descriptor.id === 'site.routeAuthed.post.economy.payments.key.confirm' ? { ...descriptor, template: '/economy/payments/confirm/:key' } : descriptor), source).unreachable.length > 0, 'dynamic route');
    const methodMutated = auditPublicContracts(all.map((descriptor) => descriptor.id === login.id ? { ...descriptor, methods: ['GET'] } : descriptor));
    assert.ok(methodMutated.methodContractDrift.length > 0, 'method drift');
    assert.ok(auditPublicContracts(all.map((descriptor) => descriptor.id === login.id ? { ...descriptor, handlerOwner: 'missingOwner' } : descriptor)).handlerOwnerDrift.length > 0, 'owner drift');
    assert.ok(auditPublicContracts(all.map((descriptor) => descriptor.id === login.id ? { ...descriptor, authClass: 'UNAUTHENTICATED' } : descriptor)).authContractDrift.length > 0, 'auth drift');
    const registry = { ...audit().registry, 'site-auth-login-v1': { ...audit().registry['site-auth-login-v1'], response: { required: ['ok'], properties: { ok: 'boolean' } } } };
    assert.ok(audit({ registry }).opaqueDtoLabelsCritical.includes(login.id), 'schema drift');
    assert.ok(criticalSchemaDrift(all, registry).response.includes(login.id), 'response schema drift');
    const noLoginRequest = { ...audit().registry, 'site-auth-login-v1': { ...audit().registry['site-auth-login-v1'], request: { required: [], properties: {} } } };
    assert.ok(criticalSchemaDrift(all, noLoginRequest).request.includes(login.id), 'request schema drift');
    assert.ok(baseRouteAudit(all, source.replace("if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'login') {", "if (method === 'PUT' && parts[0] === 'auth' && parts[1] === 'login') {")).unreachable.includes(login.id), 'route removal');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-f7-adhoc-')); const file = path.join(temp, 'router.js'); fs.writeFileSync(file, "if (path === '/ad-hoc-routing') {}\n"); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    assert.ok(auditRoutes([file]).unclassified.includes('/ad-hoc-routing'), 'ad-hoc routing');
    assert.ok(auditPublicContracts([...all, { ...login, id: 'opaque.contract', contractId: 'unknown-contract-v1', template: '/opaque-contract', samplePath: '/opaque-contract', match: (pathname) => pathname === '/opaque-contract' }]).unresolvedPublicContractShapes.includes('opaque.contract'), 'opaque dto');
});

test('F7 baseline rejects removal, method/auth changes and required response changes', () => {
    const result = audit();
    const baseline = normalizedContractBaseline(descriptors(), result.registry);
    const removed = baseline.filter((entry) => entry.descriptorId !== 'site.routePublic.post.auth.login');
    assert.ok(compareContractBaselines(baseline, removed).includes('site.routePublic.post.auth.login'));
    const weakened = baseline.map((entry) => entry.descriptorId === 'site.routePublic.post.auth.login' ? { ...entry, authClass: 'PUBLIC_AUTH_ENTRY' } : entry);
    assert.ok(compareContractBaselines(baseline, weakened).includes('site.routePublic.post.auth.login'));
    const changed = baseline.map((entry) => entry.descriptorId === 'site.routePublic.post.auth.login' ? { ...entry, requiredResponse: ['ok'], responseTypes: { ok: 'boolean' } } : entry);
    assert.ok(compareContractBaselines(baseline, changed).includes('site.routePublic.post.auth.login'));
    const economy = baseline.map((entry) => entry.contractId === 'site-economy-v1' ? { ...entry, oneOfResponse: [] } : entry);
    assert.ok(compareContractBaselines(baseline, economy).some((id) => id.startsWith('site.routeAuthed.get.economy')));
});
