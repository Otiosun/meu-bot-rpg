'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { handleAdminApiSupport } = require('../helpers/clover/adminApiSupport');

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value || '');
        },
    };
}

function request(method, url, body = null) {
    const stream = Readable.from(body === null ? [] : [JSON.stringify(body)]);
    stream.method = method;
    stream.url = url;
    stream.headers = { authorization: 'Bearer test' };
    return stream;
}

function optionsFor(role = 'owner') {
    const owner = role === 'owner';
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({
            ok: true,
            player: { id: owner ? '111@lid' : '222@lid', personagem_nome: owner ? 'Proprietário' : 'Avaliadora' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: {
                id: owner ? '111@lid' : '222@lid',
                role,
                capabilities: owner
                    ? ['operation.view', 'player.view', 'catalog.view', 'raid.view', 'integrity.view']
                    : ['operation.view', 'player.view', 'catalog.view'],
            },
        }),
    };
}

test('bootstrap mostra Equipe ADM somente ao Proprietário', async () => {
    const ownerResponse = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/bootstrap'), ownerResponse, optionsFor('owner'));
    const ownerPayload = JSON.parse(ownerResponse.body);
    assert.equal(ownerPayload.sections.some((section) => section.key === 'team'), true);

    const evaluatorResponse = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/bootstrap'), evaluatorResponse, optionsFor('evaluator'));
    const evaluatorPayload = JSON.parse(evaluatorResponse.body);
    assert.equal(evaluatorPayload.sections.some((section) => section.key === 'team'), false);
});

test('lista equipe apenas para Owner e encaminha identidade do proprietário', async () => {
    const res = responseRecorder();
    let received = null;
    await handleAdminApiSupport(request('GET', '/admin/team?revoked=true&changes=12'), res, {
        ...optionsFor('owner'),
        teamList: async (_db, input) => {
            received = input;
            return { ok: true, owner: { role: 'owner' }, members: [], recentChanges: [] };
        },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(received.ownerActor.id, '111@lid');
    assert.equal(received.ownerActor.displayName, 'Proprietário');
    assert.equal(received.includeRevoked, true);
    assert.equal(received.changeLimit, '12');

    const denied = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/team'), denied, {
        ...optionsFor('evaluator'),
        teamList: async () => {
            throw new Error('não deveria executar');
        },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(JSON.parse(denied.body).error, 'owner_required');
});

test('Owner cria prévia sem aplicar cargo imediatamente', async () => {
    const res = responseRecorder();
    let received = null;
    await handleAdminApiSupport(request('POST', '/admin/team/changes', {
        targetId: '222@lid',
        action: 'set',
        role: 'evaluator',
        reason: 'Responsável por avaliações',
    }), res, {
        ...optionsFor('owner'),
        teamChangeCreate: async (_db, input) => {
            received = input;
            return { ok: true, change: { code: 'AC-01020304', status: 'draft' } };
        },
    });

    assert.equal(res.statusCode, 201);
    assert.deepEqual(received, {
        actorId: '111@lid',
        targetId: '222@lid',
        action: 'set',
        role: 'evaluator',
        reason: 'Responsável por avaliações',
    });
    assert.equal(JSON.parse(res.body).change.status, 'draft');
});

test('rotas de aplicar, desfazer e cancelar usam o código AC correto', async () => {
    const calls = [];
    const base = {
        ...optionsFor('owner'),
        teamChangeApply: async (_db, code, actorId) => {
            calls.push(['apply', code, actorId]);
            return { ok: true, change: { code, status: 'applied' } };
        },
        teamChangeUndo: async (_db, code, actorId, reason) => {
            calls.push(['undo', code, actorId, reason]);
            return { ok: true, change: { code, status: 'undone' } };
        },
        teamChangeCancel: async (_db, code, actorId) => {
            calls.push(['cancel', code, actorId]);
            return { ok: true, change: { code, status: 'cancelled' } };
        },
    };

    for (const [command, body] of [
        ['apply', {}],
        ['undo', { reason: 'Correção de acesso' }],
        ['cancel', {}],
    ]) {
        const res = responseRecorder();
        await handleAdminApiSupport(
            request('POST', `/admin/team/changes/AC-01020304/${command}`, body),
            res,
            base
        );
        assert.equal(res.statusCode, 200);
    }

    assert.deepEqual(calls, [
        ['apply', 'AC-01020304', '111@lid'],
        ['undo', 'AC-01020304', '111@lid', 'Correção de acesso'],
        ['cancel', 'AC-01020304', '111@lid'],
    ]);
});

test('reconhece detalhe AC e rejeita método inadequado', async () => {
    const get = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/team/changes/AC-A1B2C3D4'), get, {
        ...optionsFor('owner'),
        teamChangeGet: async (_db, code) => ({ code, status: 'draft' }),
    });
    assert.equal(get.statusCode, 200);
    assert.equal(JSON.parse(get.body).change.code, 'AC-A1B2C3D4');

    const invalid = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/team/changes'), invalid, optionsFor('owner'));
    assert.equal(invalid.statusCode, 405);
    assert.equal(JSON.parse(invalid.body).error, 'method_not_allowed');
});
