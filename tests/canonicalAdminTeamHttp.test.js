'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
    handleCanonicalAdminTeamHttp,
    parseCanonicalAdminTeamPath,
} = require('../helpers/clover/canonicalAdminTeamHttp');
const adminApi = require('../helpers/clover/adminApiSupport');

class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = {};
        this.body = '';
        this.ended = false;
    }

    setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
    }

    end(value = '') {
        this.body += String(value || '');
        this.ended = true;
    }

    json() {
        return this.body ? JSON.parse(this.body) : null;
    }
}

function request(method, url, body = null) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { origin: 'https://clover.example' };
    req.bodyForTest = body;
    return req;
}

function contextOptions(overrides = {}) {
    const calls = [];
    const options = {
        resolveAdminContext: async () => ({
            db: { marker: 'db' },
            access: {
                actor: {
                    id: '5500000000000@s.whatsapp.net',
                    role: 'owner',
                    capabilities: ['*'],
                },
            },
        }),
        readJsonBody: async (req) => req.bodyForTest || {},
        listTeam: async (_db, input) => {
            calls.push(['list', input]);
            return { ok: true, owner: { playerId: input.actorId }, members: [] };
        },
        createChange: async (_db, input) => {
            calls.push(['create', input]);
            return { ok: true, change: { code: 'AC-ABCDEF1234', ...input } };
        },
        getChange: async (_db, code) => {
            calls.push(['get', code]);
            return { code, status: 'draft' };
        },
        applyChange: async (_db, code, actorId) => {
            calls.push(['apply', code, actorId]);
            return { ok: true, change: { code, status: 'applied' } };
        },
        cancelChange: async (_db, code, actorId) => {
            calls.push(['cancel', code, actorId]);
            return { ok: true, change: { code, status: 'cancelled' } };
        },
        undoChange: async (_db, code, actorId, reason) => {
            calls.push(['undo', code, actorId, reason]);
            return { ok: true, change: { code, status: 'undone', undoReason: reason } };
        },
        ...overrides,
    };
    return { options, calls };
}

async function run(method, url, body, overrides = {}) {
    const req = request(method, url, body);
    const res = new MockResponse();
    const { options, calls } = contextOptions(overrides);
    const handled = await handleCanonicalAdminTeamHttp(req, res, options);
    return { handled, res, calls };
}

test('parser reconhece somente as rotas canônicas da Equipe ADM', () => {
    assert.deepEqual(parseCanonicalAdminTeamPath('/admin/team'), { kind: 'team' });
    assert.deepEqual(parseCanonicalAdminTeamPath('/admin/team/changes'), { kind: 'changes' });
    assert.deepEqual(
        parseCanonicalAdminTeamPath('/admin/team/changes/ac-abcdef1234/apply'),
        { kind: 'change', code: 'AC-ABCDEF1234', command: 'apply' }
    );
    assert.deepEqual(
        parseCanonicalAdminTeamPath('/admin/team/changes/AC-ABCDEF1234'),
        { kind: 'change', code: 'AC-ABCDEF1234', command: 'read' }
    );
    assert.equal(parseCanonicalAdminTeamPath('/admin/operations/OP-ABC123'), null);
    assert.equal(parseCanonicalAdminTeamPath('/admin/team/changes/AC-curto'), null);
});

test('GET /admin/team usa somente o ator autenticado do contexto', async () => {
    const { handled, res, calls } = await run('GET', '/admin/team');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().owner.playerId, '5500000000000@s.whatsapp.net');
    assert.equal(calls[0][0], 'list');
    assert.equal(calls[0][1].actorId, '5500000000000@s.whatsapp.net');
});

test('POST /admin/team/changes encaminha alvo, ação, cargo e motivo', async () => {
    const { res, calls } = await run('POST', '/admin/team/changes', {
        targetId: '5511111111111@s.whatsapp.net',
        action: 'set',
        role: 'narrator',
        reason: 'Necessidade operacional.',
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls[0], ['create', {
        actorId: '5500000000000@s.whatsapp.net',
        targetId: '5511111111111@s.whatsapp.net',
        action: 'set',
        role: 'narrator',
        reason: 'Necessidade operacional.',
    }]);
});

test('leitura, aplicação, cancelamento e undo usam código AC normalizado', async () => {
    const read = await run('GET', '/admin/team/changes/ac-abcdef1234');
    assert.equal(read.res.statusCode, 200);
    assert.deepEqual(read.calls[0], ['get', 'AC-ABCDEF1234']);

    const apply = await run('POST', '/admin/team/changes/ac-abcdef1234/apply');
    assert.deepEqual(apply.calls[0], [
        'apply',
        'AC-ABCDEF1234',
        '5500000000000@s.whatsapp.net',
    ]);

    const cancel = await run('POST', '/admin/team/changes/ac-abcdef1234/cancel');
    assert.deepEqual(cancel.calls[0], [
        'cancel',
        'AC-ABCDEF1234',
        '5500000000000@s.whatsapp.net',
    ]);

    const undo = await run(
        'POST',
        '/admin/team/changes/ac-abcdef1234/undo',
        { reason: 'Revisão concluída.' }
    );
    assert.deepEqual(undo.calls[0], [
        'undo',
        'AC-ABCDEF1234',
        '5500000000000@s.whatsapp.net',
        'Revisão concluída.',
    ]);
});

test('métodos inválidos retornam 405 e OPTIONS não consulta contexto', async () => {
    const invalid = await run('POST', '/admin/team');
    assert.equal(invalid.res.statusCode, 405);
    assert.equal(invalid.res.json().error, 'method_not_allowed');

    let resolved = false;
    const preflight = await run('OPTIONS', '/admin/team', null, {
        resolveAdminContext: async () => {
            resolved = true;
            return null;
        },
    });
    assert.equal(preflight.res.statusCode, 204);
    assert.equal(resolved, false);
});

test('falha do serviço mantém código, status e detalhes sem vazar stack', async () => {
    const failure = await run('POST', '/admin/team/changes', {
        targetId: 'x',
        action: 'set',
        role: 'admin',
        reason: 'Teste',
    }, {
        createChange: async () => {
            const error = new Error('Conflito detectado.');
            error.code = 'admin_role_integrity_conflict';
            error.status = 409;
            error.details = { parity: 'mismatch' };
            throw error;
        },
    });
    assert.equal(failure.res.statusCode, 409);
    assert.deepEqual(failure.res.json(), {
        ok: false,
        error: 'admin_role_integrity_conflict',
        message: 'Conflito detectado.',
        details: { parity: 'mismatch' },
    });
});

test('adminApiSupport registra Equipe ADM sem perder operações e recuperação', () => {
    assert.equal(
        adminApi.isRecognizedAdminPath(new URL('http://localhost/admin/team')),
        true
    );
    assert.equal(
        adminApi.isRecognizedAdminPath(
            new URL('http://localhost/admin/team/changes/AC-ABCDEF1234/apply')
        ),
        true
    );
    assert.equal(
        adminApi.isRecognizedAdminPath(
            new URL('http://localhost/admin/operations/OP-ABC123/retry')
        ),
        true
    );
    assert.equal(typeof adminApi.handleCanonicalAdminTeamHttp, 'function');
    assert.equal(typeof adminApi.handlePolicyCatalog, 'function');
});
