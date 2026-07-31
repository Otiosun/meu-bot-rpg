'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class SquadMembershipError extends Error {
    constructor(message, code, details = null) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './siteAuthService') {
        return { authenticateSiteSession: async () => ({ ok: true, player: { id: 'actor@lid' } }) };
    }
    if (request === './squadMembershipService') return { SquadMembershipError };
    if (request === './squadMembershipTransitionService') {
        return { transferSquadMember: async () => ({ ok: true, duplicate: false }) };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const httpHandler = require('../helpers/clover/squadMembershipTransferHttp');
Module._load = originalLoad;

function request({ method = 'POST', url = '/squads/lobos/members/player%40lid/transfer', headers = {}, body = null } = {}) {
    return {
        method,
        url,
        headers,
        async *[Symbol.asyncIterator]() {
            if (body !== null) yield Buffer.from(JSON.stringify(body));
        },
    };
}

function response() {
    return {
        statusCode: null,
        headers: {},
        payload: null,
        setHeader(name, value) { this.headers[name] = value; },
        end(value = '') { this.payload = value ? JSON.parse(value) : null; },
    };
}

test('rota alheia não é interceptada', async () => {
    const res = response();
    const handled = await httpHandler.handleSquadMembershipTransferHttp(
        request({ url: '/other' }), res, {}
    );
    assert.equal(handled, false);
    assert.equal(res.statusCode, null);
});

test('OPTIONS retorna 204', async () => {
    const res = response();
    const handled = await httpHandler.handleSquadMembershipTransferHttp(
        request({ method: 'OPTIONS' }), res, {}
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 204);
});

test('somente POST é aceito', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request({ method: 'GET' }), res, {});
    assert.equal(res.statusCode, 405);
    assert.equal(res.payload.error, 'method_not_allowed');
});

test('banco indisponível retorna 503', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request(), res, {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.error, 'database_unavailable');
});

test('sessão inválida retorna 401', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request(), res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: false, reason: 'expired' }),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.error, 'expired');
});

test('Idempotency-Key é obrigatório', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request({ body: { toSquad: 'trevos' } }), res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'actor@lid' } }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, 'missing_idempotency_key');
});

test('destino é obrigatório', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request({
        headers: { 'idempotency-key': 'membership:001' },
        body: { reason: 'Mudança' },
    }), res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'actor@lid' } }),
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error, 'missing_target_squad');
});

test('encaminha identidade, origem, destino, motivo e chave', async () => {
    const res = response();
    let received = null;
    await httpHandler.handleSquadMembershipTransferHttp(request({
        headers: { authorization: 'Bearer token', 'idempotency-key': 'membership:001' },
        body: { toSquad: 'trevos', reason: 'Reestruturação' },
    }), res, {
        getDb: () => ({ id: 'db' }),
        authenticateSession: async (db, token) => {
            assert.equal(token, 'token');
            return { ok: true, player: { id: 'actor@lid' } };
        },
        transferMember: async (db, input) => {
            received = input;
            return { ok: true, duplicate: false, transition: { transitionKey: input.transitionKey } };
        },
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(received, {
        actorId: 'actor@lid',
        characterId: 'player@lid',
        fromSquadInput: 'lobos',
        toSquadInput: 'trevos',
        reason: 'Reestruturação',
        transitionKey: 'membership:001',
    });
});

test('retry idempotente retorna 200', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request({
        headers: { 'idempotency-key': 'membership:001' },
        body: { toSquad: 'trevos', reason: 'Reestruturação' },
    }), res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'actor@lid' } }),
        transferMember: async () => ({ ok: true, duplicate: true }),
    });
    assert.equal(res.statusCode, 200);
});

test('conflitos de integridade retornam 409', async () => {
    const res = response();
    await httpHandler.handleSquadMembershipTransferHttp(request({
        headers: { 'idempotency-key': 'membership:001' },
        body: { toSquad: 'trevos', reason: 'Reestruturação' },
    }), res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'actor@lid' } }),
        transferMember: async () => {
            throw new SquadMembershipError('Duplicado', 'multiple_active_memberships');
        },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.error, 'multiple_active_memberships');
});

test('recibo idempotente inválido retorna 409', () => {
    assert.equal(httpHandler.transferHttpStatus({ code: 'membership_transition_receipt_corrupt' }), 409);
    assert.equal(httpHandler.transferHttpStatus({ code: 'membership_transition_not_completed' }), 409);
});
