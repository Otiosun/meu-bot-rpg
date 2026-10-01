'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { handleAdminApiSupport } = require('../helpers/clover/adminApiSupport');
const { searchAdminPlayers } = require('../helpers/clover/adminPlayerSearchService');

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

function request(method = 'GET', url = '/admin/bootstrap') {
    return {
        method,
        url,
        headers: { authorization: 'Bearer test' },
    };
}

function authorizedOptions(capabilities = ['operation.view', 'player.view', 'catalog.view']) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({
            ok: true,
            player: { id: '222@lid', personagem_nome: 'Avaliador' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: {
                id: '222@lid',
                role: 'evaluator',
                capabilities,
            },
        }),
    };
}

test('ignora rotas fora do namespace administrativo', async () => {
    const res = responseRecorder();
    const handled = await handleAdminApiSupport(request('GET', '/character'), res, {});
    assert.equal(handled, false);
    assert.equal(res.body, '');
});

test('retorna bootstrap filtrado pelas capacidades do ADM', async () => {
    const res = responseRecorder();
    const handled = await handleAdminApiSupport(request(), res, authorizedOptions());

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.actor.role, 'evaluator');
    assert.equal(payload.contractVersion, 'clover.admin-operation.v1');
    assert.deepEqual(payload.sections.map((section) => section.key), [
        'operations',
        'players',
        'traits',
        'skill-approvals',
        'trees',
        'shops',
        'missions',
        'items',
        'hooks',
        'rewards',
        'boxes',
        'history',
    ]);
    assert.equal(payload.sections.some((section) => section.key === 'integrity'), false);
});

test('busca jogador somente com capacidade player.view', async () => {
    const res = responseRecorder();
    let receivedQuery = null;
    await handleAdminApiSupport(request('GET', '/admin/players/search?q=Rangar'), res, {
        ...authorizedOptions(),
        playerSearch: async (_db, query) => {
            receivedQuery = query;
            return {
                ok: true,
                query,
                exact: [],
                suggestions: [{ playerId: '1@lid', characterName: 'Ragnar' }],
                ambiguous: false,
            };
        },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(receivedQuery, 'Rangar');
    const payload = JSON.parse(res.body);
    assert.equal(payload.suggestions[0].characterName, 'Ragnar');
});

test('rota real de busca aceita tabela sem lifecycle_status', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT
        );
    `);
    await db.run(
        'INSERT INTO jogadores (id, personagem_nome, nome, esquadrao, jogo_status) VALUES (?, ?, ?, ?, ?)',
        ['126959367540919@lid', 'Emil', 'Emil', 'Kings of Sun', 'liberado']
    );

    const res = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/players/search?q=Emil'), res, {
        ...authorizedOptions(),
        getDb: () => db,
        playerSearch: (database, query, options) => searchAdminPlayers(database, query, {
            ...options,
            findMatches: async () => [],
            getCanonical: async (_db, player) => player,
        }),
    });

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.suggestions.length, 1);
    assert.equal(payload.suggestions[0].characterName, 'Emil');
    assert.equal(payload.suggestions[0].squad, 'Kings of Sun');
    assert.equal(payload.suggestions[0].lifecycleStatus, null);
});

test('bloqueia busca quando o perfil não possui player.view', async () => {
    const res = responseRecorder();
    await handleAdminApiSupport(request('GET', '/admin/players/search?q=Gohhan'), res, {
        ...authorizedOptions(['operation.view']),
        playerSearch: async () => {
            throw new Error('não deveria executar');
        },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'missing_capability');
});

test('nega sessão válida sem permissão administrativa', async () => {
    const res = responseRecorder();
    await handleAdminApiSupport(request(), res, {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: '333@lid' } }),
        accessResolver: async () => ({ ok: false, code: 'admin_access_denied' }),
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'admin_access_denied');
});

test('nega chamada sem sessão', async () => {
    const res = responseRecorder();
    await handleAdminApiSupport(request(), res, {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: false, reason: 'expired_token' }),
    });

    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'expired_token');
});

test('responde preflight e bloqueia método inadequado', async () => {
    const preflight = responseRecorder();
    await handleAdminApiSupport(request('OPTIONS'), preflight, {});
    assert.equal(preflight.statusCode, 204);

    const post = responseRecorder();
    await handleAdminApiSupport(request('POST'), post, authorizedOptions());
    assert.equal(post.statusCode, 405);
    assert.equal(JSON.parse(post.body).error, 'method_not_allowed');
});
