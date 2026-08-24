'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Module = require('node:module');

const calls = [];
let storedOperation = null;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './adminOperationContract') {
        return {
            ADMIN_ROLES: Object.freeze({
                ADMIN: 'admin',
                EVALUATOR: 'evaluator',
                NARRATOR: 'narrator',
                ASSISTANT: 'assistant',
            }),
            getRoleCapabilities() { return []; },
            normalizeRole(value) { return value; },
            requiredCapabilitiesForActions(actions) {
                return [...new Set((actions || []).map((action) => (
                    action.type === 'catalog.trait.update' ? 'catalog.manage.traits' : null
                )).filter(Boolean))];
            },
        };
    }
    if (request === './adminOperationServiceBase') {
        return {
            async createAdminOperation(_db, input) {
                calls.push(['base-create', input]);
                storedOperation = {
                    code: 'OP-A1B2C3',
                    status: 'approved',
                    actions: input.actions || [],
                    metadata: input.metadata || {},
                    units: [{ id: 1 }],
                };
                return { ok: true, operation: storedOperation };
            },
            async applyAdminOperation() {
                calls.push(['base-apply']);
                return { ok: true, engine: 'per_target' };
            },
            async simulateAdminOperation() {
                calls.push(['base-simulate']);
                return { ok: true, engine: 'simulate' };
            },
            async getOperationByCode() {
                return storedOperation;
            },
        };
    }
    if (request === './adminOperationAtomicService') {
        return {
            async applyAtomicAdminOperation() {
                calls.push(['atomic-apply']);
                return { ok: true, engine: 'atomic' };
            },
            async retryAtomicAdminOperation() {
                calls.push(['atomic-retry']);
                return { ok: true, engine: 'atomic-retry' };
            },
            async compensateAtomicAdminOperation() {
                calls.push(['atomic-compensate']);
                return { ok: true, engine: 'atomic-compensate' };
            },
        };
    }
    if (request === './adminOperationRecoveryServiceBase') {
        return {
            async retryAdminOperation() {
                calls.push(['base-retry']);
                return { ok: true, engine: 'per-target-retry' };
            },
            async compensateAdminOperation() {
                calls.push(['base-compensate']);
                return { ok: true, engine: 'per-target-compensate' };
            },
            async acceptPartialAdminOperation() { return { ok: true }; },
        };
    }
    if (request === './adminApiSupportBase') {
        return {
            async resolveAdminContext(_req, _res, options) {
                const db = options.getDb();
                const auth = await options.authenticateSession(db);
                const access = await options.accessResolver(db, auth.player.id);
                return { db, auth, access };
            },
            async readJsonBody() { return {}; },
            parseOperationPath() { return null; },
            isRecognizedAdminPath() { return false; },
            async handleAdminApiSupport() { return 'delegated'; },
        };
    }
    if (request === './adminOperationRegistryBase') {
        return { getAdminOperationExecutors: () => ({ 'catalog.trait.update': { apply() {} } }) };
    }
    if (request === './adminOperationRegistry') {
        return {
            ATOMIC_SAFE_ACTION_TYPES: new Set(['catalog.trait.update']),
            getAdminOperationExecutors: () => ({
                'catalog.trait.update': { atomicSafe: true, apply() {}, undo() {} },
            }),
        };
    }
    if (request === './adminOperationService') {
        return {
            async getOperationByCode() { return storedOperation; },
        };
    }
    if (request === './adminOperationRecoveryService') {
        return {
            async retryAdminOperation() { return { ok: true }; },
            async compensateAdminOperation() { return { ok: true }; },
            async acceptPartialAdminOperation() { return { ok: true }; },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const service = require('../helpers/clover/adminOperationService');
const recovery = require('../helpers/clover/adminOperationRecoveryService');
const api = require('../helpers/clover/adminApiSupport');
Module._load = originalLoad;

function reset() {
    calls.length = 0;
    storedOperation = null;
}

function req(method, url) {
    const stream = Readable.from([]);
    stream.method = method;
    stream.url = url;
    stream.headers = {};
    return stream;
}

function res() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value || ''); },
    };
}

function apiOptions(capabilities = ['operation.view']) {
    return {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'admin@lid' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'admin@lid', role: 'admin', capabilities },
        }),
    };
}

test('create persiste política explícita no fingerprint via metadata', async () => {
    reset();
    await service.createAdminOperation({}, {
        executionPolicy: 'atomic',
        metadata: { source: 'test' },
        actions: [{ type: 'catalog.trait.update' }],
    }, { id: 'admin@lid' });
    const input = calls[0][1];
    assert.equal(input.metadata.executionPolicy, 'atomic');
    assert.equal(input.metadata.executionPolicyDeclared, true);
    assert.equal(input.metadata.source, 'test');
});

test('atomic inválido é bloqueado já na criação', async () => {
    reset();
    await assert.rejects(
        () => service.createAdminOperation({}, {
            executionPolicy: 'atomic',
            actions: [{ type: 'catalog.trait.create' }],
        }, { id: 'admin@lid' }),
        (error) => error.code === 'atomic_policy_unsupported'
    );
    assert.equal(calls.length, 0);
});

test('ausência de política preserva per_target', async () => {
    reset();
    await service.createAdminOperation({}, {
        actions: [{ type: 'catalog.trait.update' }],
    }, { id: 'admin@lid' });
    assert.equal(calls[0][1].metadata.executionPolicy, 'per_target');
    assert.equal(calls[0][1].metadata.executionPolicyDeclared, false);
});

test('apply despacha atomic e per_target sem ambiguidade', async () => {
    reset();
    storedOperation = { status: 'approved', metadata: { executionPolicy: 'atomic' }, units: [{}], actions: [] };
    const atomicResult = await service.applyAdminOperation({}, 'OP-A1B2C3', {});
    assert.equal(atomicResult.engine, 'atomic');
    assert.deepEqual(calls, [['atomic-apply']]);

    reset();
    storedOperation = { status: 'approved', metadata: { executionPolicy: 'per_target' }, units: [{}], actions: [] };
    const targetResult = await service.applyAdminOperation({}, 'OP-A1B2C3', {});
    assert.equal(targetResult.engine, 'per_target');
    assert.deepEqual(calls, [['base-apply']]);
});

test('retry e compensação respeitam a política persistida', async () => {
    reset();
    storedOperation = { metadata: { executionPolicy: 'atomic' }, units: [], actions: [] };
    assert.equal((await recovery.retryAdminOperation({}, 'OP-A1B2C3', {})).engine, 'atomic-retry');
    assert.equal((await recovery.compensateAdminOperation({}, 'OP-A1B2C3', {})).engine, 'atomic-compensate');

    reset();
    storedOperation = { metadata: { executionPolicy: 'per_target' }, units: [], actions: [] };
    assert.equal((await recovery.retryAdminOperation({}, 'OP-A1B2C3', {})).engine, 'per-target-retry');
    assert.equal((await recovery.compensateAdminOperation({}, 'OP-A1B2C3', {})).engine, 'per-target-compensate');
});

test('API publica catálogo de políticas para o frontend', async () => {
    const response = res();
    const handled = await api.handleAdminApiSupport(
        req('GET', '/admin/operation-policies'),
        response,
        apiOptions()
    );
    const payload = JSON.parse(response.body);
    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(payload.defaultPolicy, 'per_target');
    assert.deepEqual(payload.policies, ['atomic', 'per_target']);
    assert.deepEqual(payload.atomicSafeActionTypes, ['catalog.trait.update']);
});

test('catálogo exige operation.view e aceita somente GET', async () => {
    const forbidden = res();
    await api.handleAdminApiSupport(req('GET', '/admin/operation-policies'), forbidden, apiOptions([]));
    assert.equal(forbidden.statusCode, 403);
    assert.equal(JSON.parse(forbidden.body).error, 'missing_capability');

    const invalid = res();
    await api.handleAdminApiSupport(req('POST', '/admin/operation-policies'), invalid, apiOptions());
    assert.equal(invalid.statusCode, 405);
    assert.equal(JSON.parse(invalid.body).error, 'method_not_allowed');
});
