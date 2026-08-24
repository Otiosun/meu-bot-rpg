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
const CANDIDATE = 'candidate@lid';
const ADMIN = 'admin@lid';
const VIEWER = 'viewer@lid';

const originalLoad = Module._load;
Module._load = function loadDreamHttpStubs(request, parent, isMain) {
    const parentFile = String(parent?.filename || '');
    const isDreamHttp = parentFile.endsWith('dreamWorldsHttp.js')
        || parentFile.endsWith('dreamWorldsOperationsHttp.js');
    if (request === './siteAuthService' && isDreamHttp) {
        return {
            authenticateSiteSession: async (_db, token) => {
                if (token === 'player-token') return { ok: true, player: { id: PLAYER } };
                if (token === 'candidate-token') return { ok: true, player: { id: CANDIDATE } };
                if (token === 'admin-token') return { ok: true, player: { id: ADMIN } };
                if (token === 'viewer-token') return { ok: true, player: { id: VIEWER } };
                return { ok: false, reason: 'invalid_token' };
            },
        };
    }
    if (request === './adminAccessService' && isDreamHttp) {
        return {
            getAdminActorAccess: async (_db, playerId) => {
                if (playerId === ADMIN) return {
                    ok: true,
                    actor: {
                        id: ADMIN,
                        role: 'owner',
                        capabilities: [
                            'raid.view', 'raid.manage', 'resource.adjust',
                            'catalog.view', 'catalog.manage.rewards', 'reward.grant',
                        ],
                    },
                };
                if (playerId === VIEWER) return {
                    ok: true,
                    actor: {
                        id: VIEWER,
                        role: 'narrator',
                        capabilities: ['raid.view'],
                    },
                };
                return { ok: false, code: 'admin_access_denied' };
            },
        };
    }
    if (request === './economyMutationQueue' && parentFile.endsWith('dreamWorldsHttp.js')) {
        return { runEconomyMutationExclusive: async (operation) => operation() };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { ensureCloverYullsLedgerSchema } = require('../database');
const {
    approveDreamRequest,
    createDreamWorld,
    ensureDreamWorldsSchema,
    submitDreamRequest,
} = require('../helpers/clover/dreamWorldsService');
const {
    DREAM_WORLDS_ROUTE_DESCRIPTORS,
    handleDreamWorldsHttp,
    parseAdminDreamPath,
    parseDreamPath,
} = require('../helpers/clover/dreamWorldsHttp');
const {
    DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS,
} = require('../helpers/clover/dreamWorldsOperationsHttp');
const { matchDescriptor } = require('../helpers/clover/httpRouteDescriptor');
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
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES (?, 'Candidato HTTP', 1000, '-')`,
        [CANDIDATE]
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

async function seedFormingRun(db) {
    const world = await seedWorld(db);
    const request = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: 'http:dream-request:forming',
    });
    const approved = await approveDreamRequest(db, request.request.id, ADMIN);
    return { world, run: approved.run };
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
    assert.deepEqual(parseDreamPath('/dream-worlds/me/applications'), { kind: 'applications-mine' });
    assert.deepEqual(parseDreamPath('/dream-worlds/fenda-um/applications'), {
        kind: 'application-submit',
        world: 'fenda-um',
    });
    assert.deepEqual(parseDreamPath('/dream-worlds/applications/DAPP-1/withdraw'), {
        kind: 'application-withdraw',
        application: 'DAPP-1',
    });
    assert.deepEqual(parseDreamPath('/dream-worlds/fenda-um/requests'), {
        kind: 'request-submit',
        world: 'fenda-um',
    });
    assert.deepEqual(parseAdminDreamPath('/admin/dream-worlds/applications'), {
        kind: 'admin-applications',
    });
    assert.deepEqual(parseAdminDreamPath('/admin/dream-worlds/applications/DAPP-1/select'), {
        kind: 'admin-application-select',
        application: 'DAPP-1',
    });
    assert.deepEqual(parseAdminDreamPath('/admin/dream-worlds/fenda-um/acquisition'), {
        kind: 'admin-world-acquisition',
        world: 'fenda-um',
    });
    assert.deepEqual(parseAdminDreamPath('/admin/dream-worlds/requests/42/approve'), {
        kind: 'admin-request-approve',
        requestId: 42,
    });
    assert.deepEqual(parseAdminDreamPath('/admin/dream-worlds/fenda-um/status'), {
        kind: 'admin-world-status',
        world: 'fenda-um',
    });
    assert.equal(parseDreamPath('/raids'), null);
});

test('descritores de Mundos dos Sonhos preservam operações e métodos concretos', () => {
    assert.equal(matchDescriptor(DREAM_WORLDS_ROUTE_DESCRIPTORS, 'POST', '/dream-worlds/fenda-um/applications')?.id, 'dream-worlds.application.submit');
    assert.equal(matchDescriptor(DREAM_WORLDS_ROUTE_DESCRIPTORS, 'GET', '/dream-worlds/fenda-um/applications'), null);
    assert.equal(matchDescriptor(DREAM_WORLDS_ROUTE_DESCRIPTORS, 'POST', '/admin/dream-worlds/requests/1/approve')?.id, 'admin.dream-worlds.request.approve');
    assert.equal(matchDescriptor(DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS, 'POST', '/admin/dream-worlds/runs/run-1/advance')?.id, 'admin.dream-worlds.run.advance');
    assert.equal(matchDescriptor(DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS, 'GET', '/admin/dream-worlds/runs/run-1/advance'), null);
    assert.equal(matchDescriptor(DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS, 'POST', '/admin/dream-worlds/runs/run-1/slots/2/replace')?.id, 'admin.dream-worlds.slot.replace');
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

test('Central ADM transiciona status da Fenda somente com raid.manage', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createDreamWorld(db, adminWorldBody({
        key: 'MSW-HTTP-STATUS',
        slug: 'http-status',
        status: 'draft',
    }), ADMIN);

    const denied = await invoke(db, 'POST', `/admin/dream-worlds/${world.id}/status`, {
        token: 'viewer-token',
        body: { status: 'announced' },
    });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.json.error, 'missing_capability');
    assert.deepEqual(denied.json.details, { capability: 'raid.manage' });

    const announced = await invoke(db, 'POST', `/admin/dream-worlds/${world.slug}/status`, {
        token: 'admin-token',
        body: { status: 'announced' },
    });
    assert.equal(announced.res.statusCode, 200);
    assert.equal(announced.json.ok, true);
    assert.equal(announced.json.world.status, 'announced');
    assert.equal(announced.json.data.slug, world.slug);

    const available = await invoke(db, 'POST', '/admin/dream-worlds/MSW-HTTP-STATUS/status', {
        token: 'admin-token',
        body: { status: 'available' },
    });
    assert.equal(available.res.statusCode, 200);
    assert.equal(available.json.world.status, 'available');

    const invalid = await invoke(db, 'POST', `/admin/dream-worlds/${world.id}/status`, {
        token: 'admin-token',
        body: { status: 'running' },
    });
    assert.equal(invalid.res.statusCode, 400);
    assert.equal(invalid.json.error, 'invalid_world_status_transition');

    const counts = await Promise.all([
        db.get('SELECT COUNT(*) AS total FROM clover_dream_runs'),
        db.get('SELECT COUNT(*) AS total FROM clover_dream_slots'),
        db.get('SELECT COUNT(*) AS total FROM clover_resonance_fragments'),
        db.get('SELECT COUNT(*) AS total FROM clover_dream_requests'),
    ]);
    assert.deepEqual(counts.map((row) => Number(row.total)), [0, 0, 0, 0]);
});

test('Rotas de candidaturas publicas permitem envio, listagem, selecao e retirada', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world } = await seedFormingRun(db);

    const submitted = await invoke(db, 'POST', `/dream-worlds/${world.slug}/applications`, {
        token: 'candidate-token',
        body: {
            playerNote: 'Quero uma vaga publica.',
            idempotencyKey: 'http:dream-application:1',
        },
    });
    assert.equal(submitted.res.statusCode, 201);
    assert.equal(submitted.json.application.status, 'submitted');
    assert.ok(submitted.json.application.submittedAt);

    const mine = await invoke(db, 'GET', '/dream-worlds/me/applications', { token: 'candidate-token' });
    assert.equal(mine.res.statusCode, 200);
    assert.equal(mine.json.applications.length, 1);
    assert.equal(mine.json.applications[0].world.slug, world.slug);

    const denied = await invoke(db, 'GET', '/admin/dream-worlds/applications', { token: 'candidate-token' });
    assert.equal(denied.res.statusCode, 403);

    const adminList = await invoke(db, 'GET', `/admin/dream-worlds/applications?world=${world.slug}`, { token: 'admin-token' });
    assert.equal(adminList.res.statusCode, 200);
    assert.equal(adminList.json.applications.length, 1);
    assert.equal(adminList.json.applications[0].publicSlots.open, 2);

    const reviewDenied = await invoke(db, 'POST', `/admin/dream-worlds/applications/${submitted.json.application.id}/review`, {
        token: 'viewer-token',
        body: { adminNote: 'Analisando.' },
    });
    assert.equal(reviewDenied.res.statusCode, 403);
    assert.equal(reviewDenied.json.error, 'missing_capability');

    const reviewing = await invoke(db, 'POST', `/admin/dream-worlds/applications/${submitted.json.application.id}/review`, {
        token: 'admin-token',
        body: { adminNote: 'Analisando.' },
    });
    assert.equal(reviewing.res.statusCode, 200);
    assert.equal(reviewing.json.application.status, 'under_review');

    const selected = await invoke(db, 'POST', `/admin/dream-worlds/applications/${submitted.json.application.key}/select`, {
        token: 'admin-token',
        body: {},
    });
    assert.equal(selected.res.statusCode, 200);
    assert.equal(selected.json.application.status, 'selected');
    assert.ok(selected.json.application.slotId);
    const slot = await db.get('SELECT category, status, player_id FROM clover_dream_slots WHERE id = ?', [selected.json.application.slotId]);
    assert.deepEqual(slot, { category: 'public', status: 'invited', player_id: CANDIDATE });

    const withdrawSelected = await invoke(db, 'POST', `/dream-worlds/applications/${submitted.json.application.id}/withdraw`, {
        token: 'candidate-token',
        body: { reason: 'Tarde demais.' },
    });
    assert.equal(withdrawSelected.res.statusCode, 409);
    assert.equal(withdrawSelected.json.error, 'application_not_withdrawable');
});

test('Rotas de candidaturas permitem retirada e rejeicao sem ocupar vaga', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world, run } = await seedFormingRun(db);

    const submitted = await invoke(db, 'POST', `/dream-worlds/${world.slug}/applications`, {
        token: 'candidate-token',
        body: { idempotencyKey: 'http:dream-application:withdraw' },
    });
    const withdrawn = await invoke(db, 'POST', `/dream-worlds/applications/${submitted.json.application.key}/withdraw`, {
        token: 'candidate-token',
        body: { reason: 'Retirada pelo jogador.' },
    });
    assert.equal(withdrawn.res.statusCode, 200);
    assert.equal(withdrawn.json.application.status, 'withdrawn');

    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES ('reject-http@lid', 'Recusado HTTP', 1000, '-')`
    );
    const rejectApp = await invoke(db, 'POST', `/dream-worlds/${world.slug}/applications`, {
        token: 'player-token',
        body: { idempotencyKey: 'http:dream-application:reject' },
    });
    assert.equal(rejectApp.res.statusCode, 409);

    const beforeOpen = Number((await db.get("SELECT COUNT(*) AS total FROM clover_dream_slots WHERE run_id = ? AND category = 'public' AND status = 'open'", [run.id])).total);
    assert.equal(beforeOpen, 2);
});

test('Central ADM atualiza aquisicao por rota protegida', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await seedWorld(db);

    const denied = await invoke(db, 'POST', `/admin/dream-worlds/${world.slug}/acquisition`, {
        token: 'viewer-token',
        body: {
            yullsPrice: 1000000,
            manualPaymentEnabled: true,
            manualPriceLabel: 'R$ 80,00 — apoio ao projeto',
        },
    });
    assert.equal(denied.res.statusCode, 403);

    const updated = await invoke(db, 'POST', `/admin/dream-worlds/${world.slug}/acquisition`, {
        token: 'admin-token',
        body: {
            yullsPrice: 1000000,
            manualPaymentEnabled: true,
            manualPriceLabel: 'R$ 80,00 — apoio ao projeto',
            reason: 'Ajuste operacional.',
        },
    });
    assert.equal(updated.res.statusCode, 200);
    assert.equal(updated.json.world.price.yulls, 1000000);

    const invalid = await invoke(db, 'POST', `/admin/dream-worlds/${world.id}/acquisition`, {
        token: 'admin-token',
        body: {
            yullsPrice: 0,
            manualPaymentEnabled: true,
            manualPriceLabel: 'R$ 80,00',
        },
    });
    assert.equal(invalid.res.statusCode, 400);
    assert.equal(invalid.json.error, 'missing_yulls_price');
});
