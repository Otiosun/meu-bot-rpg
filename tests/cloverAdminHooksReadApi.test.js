'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createHookTemplate,
    insertHookAssignment,
} = (() => {
    const service = require('../helpers/clover/adminHookService');
    return {
        createHookTemplate: service.createHookTemplate,
        insertHookAssignment: async (db, playerId, hookId, payload, context) => {
            const executor = service.createHookExecutors()['player.hook.assign'];
            const target = { playerId, characterName: 'Edmund' };
            const operation = { code: context.operationCode, actor: { id: context.actorId } };
            const unit = { id: 1 };
            return (await executor.apply({ db, operation, action: { payload: { hookId, ...payload } }, target, unit })).after;
        },
    };
})();
const {
    handleAdminHooksReadApi,
    isAdminHooksPath,
    parseHookDetailPath,
} = require('../helpers/clover/adminHooksReadApi');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            jogo_status TEXT,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );
        INSERT INTO jogadores
        (id, personagem_nome, nome, jogo_status, canonical_player_id)
        VALUES ('owner@lid', 'Administrador', 'Owner', 'Liberado', 'owner@lid');
        INSERT INTO jogadores
        (id, personagem_nome, nome, jogo_status, canonical_player_id)
        VALUES ('player@lid', 'Edmund', 'Jogador', 'Liberado', 'player@lid');
    `);
    return db;
}

function fakeResponse() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body = String(value); },
    };
}

async function request(db, url, options = {}) {
    const req = {
        method: options.method || 'GET',
        url,
        headers: { authorization: 'Bearer test-token', origin: 'https://example.test' },
    };
    const res = fakeResponse();
    const handled = await handleAdminHooksReadApi(req, res, {
        getDb: () => db,
        authenticateSession: async () => ({ ok: true, player: { id: 'owner@lid' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'owner@lid', capabilities: options.capabilities || ['catalog.view', 'catalog.manage.hooks'] },
        }),
    });
    return { handled, status: res.statusCode, body: JSON.parse(res.body || '{}'), headers: res.headers };
}

test('reconhece somente rotas administrativas de Ganchos', () => {
    assert.equal(isAdminHooksPath('/admin/hooks'), true);
    assert.equal(isAdminHooksPath('/admin/hooks/assignments'), true);
    assert.equal(isAdminHooksPath('/admin/hooks/HK-ABCDEF12'), true);
    assert.equal(isAdminHooksPath('/admin/items'), false);
    assert.equal(parseHookDetailPath('/admin/hooks/HK-ABCDEF12'), 'HK-ABCDEF12');
    assert.equal(parseHookDetailPath('/admin/hooks/assignments'), null);
});

test('lista catálogo, detalhe e vínculos sem expor rota pública', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const hook = await createHookTemplate(db, {
        id: 'HK-ABCDEF12',
        name: 'O Relógio Parado',
        description: 'O relógio para sempre no mesmo horário.',
    }, { actorId: 'owner@lid' });
    await insertHookAssignment(db, 'player@lid', hook.id, {
        developmentText: 'A falha coincide com a chegada de uma carta.',
    }, { actorId: 'owner@lid', operationCode: 'OP-ABC123' });

    const list = await request(db, '/admin/hooks?q=relogio&limit=20');
    assert.equal(list.handled, true);
    assert.equal(list.status, 200);
    assert.equal(list.body.hooks.length, 1);
    assert.equal(list.body.hooks[0].id, hook.id);
    assert.equal(list.headers['cache-control'], 'private, no-store, max-age=0');

    const detail = await request(db, `/admin/hooks/${hook.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.hook.name, 'O Relógio Parado');

    const assignments = await request(db, '/admin/hooks/assignments?playerId=player%40lid&status=active');
    assert.equal(assignments.status, 200);
    assert.equal(assignments.body.assignments.length, 1);
    assert.equal(assignments.body.assignments[0].characterName, 'Edmund');
});

test('nega leitura sem catalog.view e rejeita método de escrita', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const forbidden = await request(db, '/admin/hooks', { capabilities: ['player.view'] });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, 'missing_capability');

    const method = await request(db, '/admin/hooks', { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.body.error, 'method_not_allowed');
});
