'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Module = require('node:module');
const test = require('node:test');

let createDb;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    createDb = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return {
                    changes: Number(result.changes || 0),
                    lastID: Number(result.lastInsertRowid || 0),
                };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const PLAYER = 'player@lid';
const ADMIN = 'admin@lid';

const originalLoad = Module._load;
Module._load = function loadDreamHttpStubs(request, parent, isMain) {
    const parentFile = String(parent?.filename || '');
    const isDreamHttp = parentFile.endsWith('dreamWorldsHttp.js')
        || parentFile.endsWith('dreamWorldsOperationsHttp.js');
    if (request === './siteAuthService' && isDreamHttp) {
        return {
            authenticateSiteSession: async (_db, token) => {
                if (token === 'player-token') return { ok: true, player: { id: PLAYER } };
                if (token === 'admin-token') return { ok: true, player: { id: ADMIN } };
                return { ok: false, reason: 'invalid_token' };
            },
        };
    }
    if (request === './adminAccessService' && isDreamHttp) {
        return {
            getAdminActorAccess: async (_db, playerId) => playerId === ADMIN
                ? {
                    ok: true,
                    actor: {
                        id: ADMIN,
                        role: 'owner',
                        capabilities: [
                            'raid.view', 'raid.manage', 'resource.adjust',
                            'catalog.view', 'catalog.manage.rewards', 'reward.grant',
                        ],
                    },
                }
                : { ok: false, code: 'admin_access_denied' },
        };
    }
    if (request === './economyMutationQueue' && parentFile.endsWith('dreamWorldsHttp.js')) {
        return { runEconomyMutationExclusive: async (operation) => operation() };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { ensureCloverYullsLedgerSchema } = require('../database');
const {
    createDreamWorld,
    ensureDreamWorldsSchema,
} = require('../helpers/clover/dreamWorldsService');
const {
    handleDreamWorldsHttp,
    parseAdminDreamPath,
    parseDreamPath,
} = require('../helpers/clover/dreamWorldsHttp');
Module._load = originalLoad;

class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = {};
        this.body = '';
        this.headersSent = false;
    }

    setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
        this.headersSent = true;
    }

    end(value = '') {
        this.body += String(value || '');
        this.ended = true;
    }

    json() {
        return this.body ? JSON.parse(this.body) : null;
    }
}

function makeRequest(method, url, options = {}) {
    const payload = options.body === undefined
        ? []
        : [Buffer.from(JSON.stringify(options.body), 'utf8')];
    const req = Readable.from(payload);
    req.method = method;
    req.url = url;
    req.headers = {
        origin: 'https://site.example',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {}),
    };
    return req;
}

async function invoke(db, method, url, options = {}) {
    const req = makeRequest(method, url, options);
    const res = new MockResponse();
    const handled = await handleDreamWorldsHttp(req, res, { getDb: () => db });
    return { handled, res, json: res.json() };
}

async function setup() {
    const db = await createDb();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado'
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            captain_player_id TEXT DEFAULT NULL,
            vice_captain_player_id TEXT DEFAULT NULL
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES (?, 'Mago HTTP', 9000, 'veu_negro')`,
        [PLAYER]
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES (?, 'Administrador HTTP', 0, '-')`,
        [ADMIN]
    );
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, captain_player_id)
         VALUES ('veu_negro', 'Véu Negro', ?)`,
        [PLAYER]
    );
    await ensureCloverYullsLedgerSchema(db);
    await ensureDreamWorldsSchema(db);
    return db;
}

async function seedWorld(db) {
    return createDreamWorld(db, {
        name: 'A Biblioteca Sem Amanhã',
        universe: 'Arquivo de Teste',
        arc: 'O Primeiro Registro',
        synopsis: 'Uma biblioteca registra futuros que não deveriam existir.',
        dreamType: 'self',
        rank: 'A',
        status: 'available',
        riskLevel: 'alto',
        yullsPrice: 2500,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 25,00',
        minPlayers: 2,
        maxPlayers: 5,
        slots: { squad: 2, invited: 1, public: 2 },
        knownChapters: 3,
    }, ADMIN);
}

function adminWorldBody(overrides = {}) {
    return {
        name: 'O Palácio das Vozes',
        universe: 'Arquivo de Teste',
        synopsis: 'Vozes antigas disputam o corpo de quem atravessa a Fenda.',
        dreamType: 'assumed_identity',
        rank: 'A',
        status: 'announced',
        yullsPrice: 3000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 30,00',
        minPlayers: 2,
        maxPlayers: 4,
        slots: { squad: 1, invited: 1, public: 2 },
        ...overrides,
    };
}

test('Parser reconhece apenas as rotas oficiais de MS', () => {
    assert.deepEqual(parseDreamPath('/dream-worlds'), { kind: 'world-list' });
    assert.deepEqual(parseDreamPath('/dream-worlds/me'), { kind: 'dashboard' });
    assert.deepEqual(parseDreamPath('/dream-worlds/fenda-um/requests'), {
        kind: 'request-submit',
        world: 'fenda-um',
    });
    assert.deepEqual(parseAdminDreamPath('/admin/dream-worlds/requests/42/approve'), {
        kind: 'admin-request-approve',
        requestId: 42,
    });
    assert.equal(parseDreamPath('/raids'), null);
});

test('Catálogo e detalhe públicos usam o contrato esperado', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await seedWorld(db);

    const catalog = await invoke(db, 'GET', '/dream-worlds');
    assert.equal(catalog.handled, true);
    assert.equal(catalog.res.statusCode, 200);
    assert.equal(catalog.json.ok, true);
    assert.equal(catalog.json.worlds.length, 1);
    assert.equal(catalog.json.worlds[0].slug, world.slug);

    const detail = await invoke(db, 'GET', `/dream-worlds/${world.slug}`);
    assert.equal(detail.res.statusCode, 200);
    assert.equal(detail.json.world.name, world.name);
    assert.equal(detail.json.data.players.distribution.public, 2);
});

test('Jogador envia solicitação e acompanha a própria jornada', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await seedWorld(db);

    const submitted = await invoke(db, 'POST', `/dream-worlds/${world.id}/requests`, {
        token: 'player-token',
        body: {
            buyerType: 'player',
            paymentMethod: 'yulls',
            playerNote: 'Quero entrar nesta história.',
            idempotencyKey: 'http:dream-request:1',
        },
    });
    assert.equal(submitted.res.statusCode, 201);
    assert.equal(submitted.json.ok, true);
    assert.equal(submitted.json.request.status, 'submitted');

    const dashboard = await invoke(db, 'GET', '/dream-worlds/me', { token: 'player-token' });
    assert.equal(dashboard.res.statusCode, 200);
    assert.equal(dashboard.json.dashboard.wallet.balance, 9000);
    assert.equal(dashboard.json.dashboard.requests.length, 1);
    assert.equal(dashboard.json.dashboard.requests[0].world.slug, world.slug);
    assert.deepEqual(dashboard.json.dashboard.invites, []);
});

test('Rotas administrativas exigem capacidade e criam Fenda com os dois valores', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const denied = await invoke(db, 'GET', '/admin/dream-worlds', { token: 'player-token' });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.json.error, 'admin_access_denied');

    const created = await invoke(db, 'POST', '/admin/dream-worlds', {
        token: 'admin-token',
        body: adminWorldBody(),
    });
    assert.equal(created.res.statusCode, 201);
    assert.equal(created.json.world.status, 'announced');
    assert.equal(created.json.world.price.yulls, 3000);
    assert.equal(created.json.world.price.manualEnabled, true);
    assert.equal(created.json.world.price.manualLabel, 'R$ 30,00');

    const list = await invoke(db, 'GET', '/admin/dream-worlds', { token: 'admin-token' });
    assert.equal(list.res.statusCode, 200);
    assert.equal(list.json.worlds.length, 1);
});

test('Central ADM recusa Fenda sem preço positivo em Yuls', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const result = await invoke(db, 'POST', '/admin/dream-worlds', {
        token: 'admin-token',
        body: adminWorldBody({ yullsPrice: 0 }),
    });

    assert.equal(result.res.statusCode, 400);
    assert.equal(result.json.error, 'missing_yulls_price');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_worlds')).total), 0);
});

test('Central ADM recusa Fenda sem dinheiro real e valor público', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const disabled = await invoke(db, 'POST', '/admin/dream-worlds', {
        token: 'admin-token',
        body: adminWorldBody({ manualPaymentEnabled: false }),
    });
    assert.equal(disabled.res.statusCode, 400);
    assert.equal(disabled.json.error, 'missing_real_money_option');

    const missingValue = await invoke(db, 'POST', '/admin/dream-worlds', {
        token: 'admin-token',
        body: adminWorldBody({ manualPriceLabel: '' }),
    });
    assert.equal(missingValue.res.statusCode, 400);
    assert.equal(missingValue.json.error, 'missing_real_money_value');
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_worlds')).total), 0);
});
