'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Module = require('node:module');

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const baseStub = {
    async resolveAdminContext(_req, _res, options) {
        const db = options.getDb();
        const auth = await options.authenticateSession(db);
        const access = await options.accessResolver(db, auth.player.id);
        return { db, auth, access };
    },
    readJsonBody: readBody,
    parseOperationPath(pathname) {
        const match = String(pathname || '').match(/^\/admin\/operations\/(OP-[A-F0-9]{6})$/i);
        return match ? { code: match[1].toUpperCase(), command: null } : null;
    },
    isRecognizedAdminPath() { return false; },
    async handleAdminApiSupport() { return 'delegated'; },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './adminApiSupportBase') return baseStub;
    if (request === './adminOperationService') {
        return { getOperationByCode: async () => { throw new Error('unexpected default get'); } };
    }
    if (request === './adminOperationRegistry') {
        return { getAdminOperationExecutors: () => ({ registry: 'default' }) };
    }
    if (request === './adminOperationRecoveryService') {
        const unused = async () => { throw new Error('unexpected default recovery call'); };
        return {
            acceptPartialAdminOperation: unused,
            compensateAdminOperation: unused,
            retryAdminOperation: unused,
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const operationContract = require('../helpers/clover/adminOperationContract');
const {
    handleAdminApiSupport,
    parseOperationPath,
} = require('../helpers/clover/adminApiSupport');
Module._load = originalLoad;

function request(method, url, body = null) {
    const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = {};
    return req;
}

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value || ''); },
    };
}

function operation(code = 'OP-A1B2C3') {
    return {
        code,
        status: 'partially_applied',
        actions: [{ type: 'resource.adjust', payload: {} }],
        units: [],
        events: [],
    };
}

function options(capabilities, overrides = {}) {
    return {
        getDb: () => ({ marker: 'db' }),
        authenticateSession: async () => ({ ok: true, player: { id: '111@lid' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: '111@lid', role: 'admin', capabilities },
        }),
        operationGet: async (_db, code) => operation(code),
        executors: { registry: 'test' },
        ...overrides,
    };
}

async function call(method, url, body, callOptions) {
    const res = responseRecorder();
    const handled = await handleAdminApiSupport(request(method, url, body), res, callOptions);
    return {
        handled,
        status: res.statusCode,
        payload: res.body ? JSON.parse(res.body) : null,
    };
}

test('parser reconhece recuperação e mantém rotas antigas', () => {
    assert.deepEqual(parseOperationPath('/admin/operations/op-a1b2c3/retry'), {
        code: 'OP-A1B2C3', command: 'retry',
    });
    assert.equal(parseOperationPath('/admin/operations/OP-A1B2C3/compensate').command, 'compensate');
    assert.equal(parseOperationPath('/admin/operations/OP-A1B2C3/accept-partial').command, 'accept-partial');
    assert.deepEqual(parseOperationPath('/admin/operations/OP-A1B2C3'), {
        code: 'OP-A1B2C3', command: null,
    });
    assert.equal(parseOperationPath('/admin/operations/OP-A1B2C3/recover'), null);
});

test('rotas não recuperáveis continuam delegadas ao handler original', async () => {
    assert.equal(await handleAdminApiSupport(request('GET', '/admin/bootstrap'), responseRecorder(), {}), 'delegated');
});

test('retry exige operation.apply, preserva executores e usa 409 quando incompleto', async () => {
    let received = null;
    const success = await call('POST', '/admin/operations/OP-A1B2C3/retry', {}, options(
        ['operation.apply', 'resource.adjust'],
        {
            operationRetry: async (db, code, actor, recoveryOptions) => {
                received = { db, code, actor, recoveryOptions };
                return { ok: true, operation: { status: 'applied' } };
            },
        }
    ));
    assert.equal(success.status, 200);
    assert.equal(received.code, 'OP-A1B2C3');
    assert.deepEqual(received.actor, { id: '111@lid', role: 'admin' });
    assert.deepEqual(received.recoveryOptions.executors, { registry: 'test' });

    const partial = await call('POST', '/admin/operations/OP-A1B2C3/retry', {}, options(
        ['operation.apply', 'resource.adjust'],
        { operationRetry: async () => ({ ok: false, operation: { status: 'partially_applied' } }) }
    ));
    assert.equal(partial.status, 409);
    assert.equal(partial.payload.operation.status, 'partially_applied');
});

test('compensate exige operation.undo', async () => {
    const result = await call('POST', '/admin/operations/OP-A1B2C3/compensate', {}, options(
        ['operation.undo', 'resource.adjust'],
        { operationCompensate: async () => ({ ok: true, operation: { status: 'compensated' } }) }
    ));
    assert.equal(result.status, 200);
    assert.equal(result.payload.operation.status, 'compensated');
});

test('accept-partial encaminha justificativa e exige operation.apply', async () => {
    let reason = null;
    const result = await call(
        'POST',
        '/admin/operations/OP-A1B2C3/accept-partial',
        { justification: 'Uma unidade exige correção manual.' },
        options(['operation.apply', 'resource.adjust'], {
            operationAcceptPartial: async (_db, _code, _actor, justification) => {
                reason = justification;
                return { ok: true, operation: { status: 'accepted_partial' } };
            },
        })
    );
    assert.equal(reason, 'Uma unidade exige correção manual.');
    assert.equal(result.payload.operation.status, 'accepted_partial');
});

test('capacidade do comando e da ação são verificadas separadamente', async () => {
    const missingCommand = await call(
        'POST', '/admin/operations/OP-A1B2C3/retry', {},
        options(['resource.adjust'], { operationRetry: async () => ({ ok: true }) })
    );
    assert.equal(missingCommand.status, 403);
    assert.equal(missingCommand.payload.error, 'missing_capability');
    assert.equal(missingCommand.payload.details.capability, 'operation.apply');

    const missingAction = await call(
        'POST', '/admin/operations/OP-A1B2C3/retry', {},
        options(['operation.apply'], { operationRetry: async () => ({ ok: true }) })
    );
    assert.equal(missingAction.status, 403);
    assert.equal(missingAction.payload.error, 'forbidden_actions');
    assert.deepEqual(missingAction.payload.details.missing, ['resource.adjust']);
});

test('recuperação aceita somente POST', async () => {
    const result = await call(
        'GET', '/admin/operations/OP-A1B2C3/retry', null,
        options(['operation.apply', 'resource.adjust'])
    );
    assert.equal(result.status, 405);
    assert.equal(result.payload.error, 'method_not_allowed');
});

test('contrato expõe estados e transições recuperáveis', () => {
    const { OPERATION_STATUSES, canTransitionOperation } = operationContract;
    for (const status of ['retrying', 'compensating', 'compensated', 'accepted_partial']) {
        assert.equal(OPERATION_STATUSES.includes(status), true);
    }
    assert.equal(canTransitionOperation('partially_applied', 'retrying'), true);
    assert.equal(canTransitionOperation('failed', 'retrying'), true);
    assert.equal(canTransitionOperation('applied', 'compensating'), true);
    assert.equal(canTransitionOperation('partially_applied', 'accepted_partial'), true);
    assert.equal(canTransitionOperation('compensating', 'compensated'), true);
    assert.equal(canTransitionOperation('accepted_partial', 'retrying'), false);
});
