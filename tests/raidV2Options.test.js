'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const { resolveRaidCategory } = require('../helpers/clover/raidCategoryCatalog');
const { createRaid } = require('../helpers/clover/raidService');
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');
const {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
} = require('../helpers/clover/raidV2OptionsService');
const {
    handleRaidV2OptionsHttp,
} = require('../helpers/clover/raidV2OptionsHttp');
const {
    endpointEntries,
    handleSiteEndpointDiscoveryHttp,
} = require('../helpers/clover/siteEndpointDiscoveryHttp');

const NARRATOR = '5511111111111@s.whatsapp.net';
const PLAYER = '5522222222222@s.whatsapp.net';

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            jogo_status TEXT DEFAULT 'liberado'
        );
        INSERT INTO jogadores
            (id, personagem_nome, magia, esquadrao, jogo_status)
        VALUES
            ('${NARRATOR}', 'Narrador', 'Registro', '-', 'liberado'),
            ('${PLAYER}', 'Player Um', 'Fogo', 'Coringas Magenta', 'liberado'),
            ('5533333333333@s.whatsapp.net', 'Arquivado', 'Água', '-', 'arquivado');
    `);
    await prepareCanonicalRaidSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('coringas_magenta', 'Coringas Magenta')`
    );
    await assignAccessRole(db, {
        subjectId: NARRATOR,
        role: 'narrator',
        assignedBy: NARRATOR,
        reason: 'teste de opções de raid',
    });
    return db;
}

function responseHarness() {
    const headers = new Map();
    return {
        statusCode: 0,
        body: '',
        setHeader(name, value) {
            headers.set(String(name).toLowerCase(), value);
        },
        getHeader(name) {
            return headers.get(String(name).toLowerCase());
        },
        end(value = '') {
            this.body = String(value);
        },
    };
}

function request(url, headers = {}) {
    return { method: 'GET', url, headers };
}

test('opções de criação trazem quatro categorias oficiais', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const options = await getRaidCreationOptions(db, NARRATOR);
    assert.equal(options.categories.length, 4);
    assert.deepEqual(options.categories.map((category) => category.key), [
        'saga_pessoal',
        'missao_esquadrao',
        'treino_esquadrao',
        'evento_especial',
    ]);
    assert.deepEqual(options.players.map((player) => player.name), ['Narrador', 'Player Um']);
    assert.equal(options.players.find((player) => player.id === PLAYER).magic, 'Fogo');
    assert.deepEqual(options.squads.map((squad) => squad.name), ['Coringas Magenta']);
});

test('categorias legadas danificadas preservam o tipo mensal correto na migração', () => {
    assert.equal(resolveRaidCategory('miss?o').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('investiga??o').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('sobreviv?ncia').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('evento??').key, 'evento_especial');
    assert.equal(resolveRaidCategory('torneio??').key, 'evento_especial');
});

test('criação nova recusa categoria danificada em vez de escapar da quota', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await assert.rejects(
        () => createRaid(db, NARRATOR, {
            name: 'Categoria quebrada',
            category: 'miss?o',
        }),
        { code: 'invalid_raid_category' }
    );
    const count = await db.get('SELECT COUNT(*) AS total FROM clover_raids');
    assert.equal(Number(count.total), 0);
});

test('prévia mensal usa reserva real sem fingir conclusão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const before = await previewRaidMonthlyUsage(db, NARRATOR, {
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    assert.equal(before.usage.completed, 0);
    assert.equal(before.usage.reserved, 0);
    assert.equal(before.usage.used, 0);
    assert.equal(before.usage.remaining, 1);

    await createRaid(db, NARRATOR, {
        name: 'Saga em andamento',
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });

    const after = await previewRaidMonthlyUsage(db, NARRATOR, {
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    assert.equal(after.usage.completed, 0);
    assert.equal(after.usage.reserved, 1);
    assert.equal(after.usage.used, 1);
    assert.equal(after.usage.remaining, 0);
    assert.equal(after.usage.exhausted, true);
});

test('HTTP público expõe catálogo de categorias sem exigir sessão', async () => {
    const res = responseHarness();
    const handled = await handleRaidV2OptionsHttp(
        request('/raids/categories'),
        res,
        {
            getRaidCategoryCatalog: () => [{ key: 'saga_pessoal', label: 'Saga Pessoal' }],
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
        ok: true,
        categories: [{ key: 'saga_pessoal', label: 'Saga Pessoal' }],
    });
});

test('HTTP de opções usa a identidade autenticada da sessão', async () => {
    const res = responseHarness();
    const db = { fake: true };
    let receivedActorId = null;

    const handled = await handleRaidV2OptionsHttp(
        request('/raids/options', { authorization: 'Bearer test-session' }),
        res,
        {
            getDb: () => db,
            authenticateSession: async (receivedDb, token) => {
                assert.equal(receivedDb, db);
                assert.equal(token, 'test-session');
                return { ok: true, player: { id: NARRATOR } };
            },
            getRaidCreationOptions: async (receivedDb, actorId) => {
                assert.equal(receivedDb, db);
                receivedActorId = actorId;
                return { categories: [], players: [], squads: [] };
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(receivedActorId, NARRATOR);
    assert.deepEqual(JSON.parse(res.body).options, { categories: [], players: [], squads: [] });
});

test('HTTP de prévia mensal preserva categoria e escopo da query', async () => {
    const res = responseHarness();
    const db = { fake: true };
    let receivedInput = null;

    const handled = await handleRaidV2OptionsHttp(
        request('/raids/usage?category=saga_pessoal&scopePlayerId=player%40id&referenceDate=2026-10-04', { authorization: 'Bearer test-session' }),
        res,
        {
            getDb: () => db,
            authenticateSession: async () => ({ ok: true, player: { id: NARRATOR } }),
            previewRaidMonthlyUsage: async (_db, actorId, input) => {
                assert.equal(actorId, NARRATOR);
                receivedInput = input;
                return { category: { key: input.category }, scope: { playerId: input.scopePlayerId }, usage: { used: 0 } };
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(receivedInput, {
        category: 'saga_pessoal',
        scopePlayerId: 'player@id',
        scopeSquadKey: undefined,
        referenceDate: '2026-10-04',
    });
    assert.equal(JSON.parse(res.body).preview.category.key, 'saga_pessoal');
});

test('discovery deriva endpoints do contrato e inclui rotas antes omitidas', () => {
    const endpoints = endpointEntries();
    assert.ok(endpoints.includes('POST /economy/market/listings/preview'));
    assert.ok(endpoints.includes('POST /raids/:key/leave'));
    assert.ok(endpoints.includes('GET /raids/categories'));
    assert.ok(endpoints.includes('GET /raids/options'));
    assert.ok(endpoints.includes('GET /raids/usage'));
});

test('GET / devolve discovery canônico para o frontend', () => {
    const res = responseHarness();
    const handled = handleSiteEndpointDiscoveryHttp(request('/'), res);
    const body = JSON.parse(res.body);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.ok(body.endpoints.includes('GET /character/spellbook'));
    assert.ok(body.endpoints.includes('POST /economy/market/listings/preview'));
    assert.ok(body.endpoints.includes('GET /raids/options'));
});
