'use strict';

const assert = require('node:assert/strict');
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

const { ensureCloverYullsLedgerSchema } = require('../database');
const { getYullsSummary } = require('../helpers/clover/yullsService');
const {
    DreamWorldsServiceError,
    approveDreamRequest,
    createDreamWorld,
    ensureDreamWorldsSchema,
    getPlayerDreamDashboard,
    listAdminDreamApplications,
    listPlayerDreamApplications,
    listPublicDreamWorlds,
    rejectDreamApplication,
    rejectDreamRequest,
    reviewDreamApplication,
    selectDreamApplication,
    submitDreamApplication,
    submitDreamRequest,
    transitionDreamWorldStatus,
    updateDreamWorldAcquisition,
    withdrawDreamApplication,
} = require('../helpers/clover/dreamWorldsService');

const PLAYER = 'player@lid';
const OTHER = 'other@lid';
const ADMIN = 'admin@lid';

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
         VALUES (?, 'Mago de Teste', 5000, 'veu_negro')`,
        [PLAYER]
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES (?, 'Outro Mago', 500, 'asas')`,
        [OTHER]
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES (?, 'Administrador', 0, '-')`,
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

async function createAvailableWorld(db, overrides = {}) {
    return createDreamWorld(db, {
        name: 'A Cidade que Esqueceu o Sol',
        universe: 'Arquivo de Teste',
        arc: 'Primeiro Capítulo',
        synopsis: 'Uma cidade vive sob uma noite que não termina.',
        dreamType: 'assumed_identity',
        rank: 'A',
        status: 'available',
        riskLevel: 'alto',
        yullsPrice: 2000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'Confirmação manual',
        minPlayers: 3,
        maxPlayers: 5,
        slots: { squad: 2, invited: 1, public: 2 },
        knownChapters: 3,
        publicRisks: ['Morte real', 'Confusão de memórias'],
        rules: ['Sem entrada solo'],
        fragmentCategories: ['style', 'trait'],
        ...overrides,
    }, ADMIN);
}

async function addPlayer(db, id, yulls = 1000, squad = '-') {
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
         VALUES (?, ?, ?, ?)`,
        [id, `Mago ${id}`, yulls, squad]
    );
    return id;
}

async function createFormingRun(db, overrides = {}) {
    const world = await createAvailableWorld(db, {
        slug: `fenda-forming-${Math.random().toString(16).slice(2)}`,
        yullsPrice: 1000,
        ...overrides.world,
    });
    const submitted = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: `dream-request:forming:${Math.random()}`,
    });
    const approved = await approveDreamRequest(db, submitted.request.id, ADMIN);
    const reserved = await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [world.id]);
    return { world: reserved, request: approved.request, run: approved.run };
}

test('Fenda pública preserva distribuição inteira de vagas', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const world = await createAvailableWorld(db);
    assert.equal(world.status, 'available');
    assert.deepEqual(world.players.distribution, { squad: 2, invited: 1, public: 2 });

    const catalog = await listPublicDreamWorlds(db);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].slug, 'a-cidade-que-esqueceu-o-sol');
});

test('Solicitação por Yuls não desconta antes da aprovação e é idempotente', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db);

    const first = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        playerNote: 'Solicitação de teste.',
        idempotencyKey: 'dream-request:test:1',
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.request.status, 'submitted');
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 5000);

    const duplicate = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: 'dream-request:test:1',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.request.id, first.request.id);
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 5000);
});

test('Aprovação desconta uma vez, reserva a Fenda e cria todas as vagas', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db);
    const submitted = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'squad',
        buyerId: 'veu_negro',
        paymentMethod: 'yulls',
        idempotencyKey: 'dream-request:test:approve',
    });

    const approved = await approveDreamRequest(db, submitted.request.id, ADMIN, {
        adminNote: 'Pagamento e termos confirmados.',
        narratorIds: [ADMIN],
    });
    assert.equal(approved.duplicate, false);
    assert.equal(approved.request.status, 'approved');
    assert.equal(approved.yulls.balanceBefore, 5000);
    assert.equal(approved.yulls.balanceAfter, 3000);

    const savedWorld = await db.get('SELECT status FROM clover_dream_worlds WHERE id = ?', [world.id]);
    assert.equal(savedWorld.status, 'reserved');

    const slots = await db.all(
        `SELECT category, player_id, status FROM clover_dream_slots
         WHERE run_id = ? ORDER BY id`,
        [approved.run.id]
    );
    assert.equal(slots.length, 5);
    assert.equal(slots.filter((slot) => slot.status === 'confirmed').length, 1);
    assert.equal(slots.find((slot) => slot.status === 'confirmed').player_id, PLAYER);
    assert.equal(slots.filter((slot) => slot.category === 'squad').length, 2);
    assert.equal(slots.filter((slot) => slot.category === 'invited').length, 1);
    assert.equal(slots.filter((slot) => slot.category === 'public').length, 2);

    const repeated = await approveDreamRequest(db, submitted.request.id, ADMIN);
    assert.equal(repeated.duplicate, true);
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 3000);

    const dashboard = await getPlayerDreamDashboard(db, PLAYER);
    assert.equal(dashboard.requests[0].status, 'approved');
    assert.equal(dashboard.runs.length, 1);
});

test('Recusa mantém Yuls e encerra a solicitação sem criar incursão', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        name: 'O Segundo Sonho',
        slug: 'segundo-sonho',
    });
    const submitted = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'manual',
        idempotencyKey: 'dream-request:test:reject',
    });

    const rejected = await rejectDreamRequest(db, submitted.request.id, ADMIN, {
        adminNote: 'Solicitação recusada no teste.',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 5000);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_runs')).total), 0);
});

test('Saldo insuficiente bloqueia solicitação antes de criar registro', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        name: 'Fenda Cara',
        slug: 'fenda-cara',
        yullsPrice: 10000,
    });

    await assert.rejects(
        () => submitDreamRequest(db, OTHER, world.slug, {
            buyerType: 'player',
            paymentMethod: 'yulls',
            idempotencyKey: 'dream-request:test:insufficient',
        }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'insufficient_yulls'
    );
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_requests')).total), 0);
});

test('createDreamWorld exige aquisicao por Yuls e dinheiro real juntos', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const world = await createAvailableWorld(db, {
        name: 'Fenda de Dupla Aquisicao',
        slug: 'fenda-dupla',
        yullsPrice: '3000',
        manualPaymentEnabled: 1,
        manualPriceLabel: '  R$ 30,00  ',
    });

    assert.equal(world.price.yulls, 3000);
    assert.equal(world.price.manualEnabled, true);
    assert.equal(world.price.manualLabel, 'R$ 30,00');
});

test('createDreamWorld preserva codigos da politica dual', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await assert.rejects(
        () => createAvailableWorld(db, { yullsPrice: 0 }),
        (error) => error instanceof DreamWorldsServiceError
            && error.code === 'missing_yulls_price'
            && error.details.yullsPrice === 0
    );
    await assert.rejects(
        () => createAvailableWorld(db, { manualPaymentEnabled: false }),
        (error) => error instanceof DreamWorldsServiceError
            && error.code === 'missing_real_money_option'
    );
    await assert.rejects(
        () => createAvailableWorld(db, { manualPriceLabel: '   ' }),
        (error) => error instanceof DreamWorldsServiceError
            && error.code === 'missing_real_money_value'
    );
});

test('triggers bloqueiam insert e update SQL diretos sem aquisicao dual', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await assert.rejects(
        () => db.run(
            `INSERT INTO clover_dream_worlds (
                world_key, slug, name, universe, synopsis, dream_type,
                yulls_price, manual_payment_enabled, manual_price_label,
                created_by
             ) VALUES ('MSW-BROKEN', 'broken', 'Broken', 'Teste', 'Invalida',
                'self', 0, 1, 'R$ 10,00', ?)`,
            [ADMIN]
        ),
        /requires positive Yuls/
    );

    const world = await createAvailableWorld(db, { slug: 'trigger-update' });
    await assert.rejects(
        () => db.run('UPDATE clover_dream_worlds SET manual_payment_enabled = 0 WHERE id = ?', [world.id]),
        /requires positive Yuls/
    );
    await assert.rejects(
        () => db.run('UPDATE clover_dream_worlds SET manual_price_label = ? WHERE id = ?', ['   ', world.id]),
        /requires positive Yuls/
    );
    await assert.rejects(
        () => db.run('UPDATE clover_dream_worlds SET yulls_price = 0 WHERE id = ?', [world.id]),
        /requires positive Yuls/
    );
});

test('banco legado com CHECK antigo recebe triggers idempotentes', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.exec(`
        CREATE TABLE clover_dream_worlds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            world_key TEXT NOT NULL UNIQUE,
            slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
            name TEXT NOT NULL,
            universe TEXT NOT NULL,
            synopsis TEXT NOT NULL,
            dream_type TEXT NOT NULL CHECK (dream_type IN ('self', 'assumed_identity', 'mixed')),
            status TEXT NOT NULL DEFAULT 'draft',
            yulls_price INTEGER NOT NULL DEFAULT 0 CHECK (yulls_price >= 0),
            manual_payment_enabled INTEGER NOT NULL DEFAULT 0 CHECK (manual_payment_enabled IN (0, 1)),
            manual_price_label TEXT DEFAULT NULL,
            created_by TEXT NOT NULL,
            purchase_opens_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            CHECK (yulls_price > 0 OR manual_payment_enabled = 1)
        );
    `);

    await ensureDreamWorldsSchema(db);
    await ensureDreamWorldsSchema(db);

    const triggers = await db.all(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = 'clover_dream_worlds'
         ORDER BY name`
    );
    assert.deepEqual(triggers.map((row) => row.name), [
        'trg_clover_dream_worlds_dual_acquisition_insert',
        'trg_clover_dream_worlds_dual_acquisition_update',
    ]);

    await assert.rejects(
        () => db.run(
            `INSERT INTO clover_dream_worlds (
                world_key, slug, name, universe, synopsis, dream_type,
                yulls_price, manual_payment_enabled, created_by
             ) VALUES ('MSW-LEGACY', 'legacy', 'Legacy', 'Teste',
                'Legado invalido', 'self', 1, 1, ?)`,
            [ADMIN]
        ),
        /requires positive Yuls/
    );
});

test('transicao draft para announced publica sem abrir solicitacoes', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        name: 'Fenda Anunciada',
        slug: 'fenda-anunciada',
        status: 'draft',
        purchaseOpensAt: '2026-07-28 10:00:00',
    });

    const announced = await transitionDreamWorldStatus(db, world.id, ADMIN, { status: 'announced' });
    assert.equal(announced.status, 'announced');
    assert.ok(announced.announcedAt);
    assert.equal(announced.purchaseOpensAt, null);

    const catalog = await listPublicDreamWorlds(db);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].slug, 'fenda-anunciada');

    await assert.rejects(
        () => submitDreamRequest(db, PLAYER, announced.slug, {
            buyerType: 'player',
            paymentMethod: 'yulls',
            idempotencyKey: 'dream-request:announced:block',
        }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'world_not_available'
    );
});

test('transicao announced para available abre e aceita solicitacao', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        name: 'Fenda Abrindo',
        slug: 'fenda-abrindo',
        status: 'draft',
    });

    await transitionDreamWorldStatus(db, world.slug, ADMIN, { status: 'announced' });
    const available = await transitionDreamWorldStatus(db, world.slug, ADMIN, { status: 'available' });
    assert.equal(available.status, 'available');
    assert.ok(available.purchaseOpensAt);

    const submitted = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: 'dream-request:available:ok',
    });
    assert.equal(submitted.request.status, 'submitted');
});

test('transicao available para announced bloqueia novas solicitacoes sem cancelar existentes', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        name: 'Fenda Pausada',
        slug: 'fenda-pausada',
    });
    const submitted = await submitDreamRequest(db, PLAYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'manual',
        idempotencyKey: 'dream-request:pause:existing',
    });

    const announced = await transitionDreamWorldStatus(db, world.worldKey || world.key, ADMIN, { status: 'announced' });
    assert.equal(announced.status, 'announced');
    const existing = await db.get('SELECT status FROM clover_dream_requests WHERE id = ?', [submitted.request.id]);
    assert.equal(existing.status, 'submitted');

    await assert.rejects(
        () => submitDreamRequest(db, OTHER, world.slug, {
            buyerType: 'player',
            paymentMethod: 'manual',
            idempotencyKey: 'dream-request:pause:block',
        }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'world_not_available'
    );
});

test('transicao announced para draft exige ausencia de atividade', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const empty = await createAvailableWorld(db, {
        name: 'Fenda Sem Atividade',
        slug: 'fenda-sem-atividade',
        status: 'draft',
    });

    await transitionDreamWorldStatus(db, empty.id, ADMIN, { status: 'announced' });
    const draft = await transitionDreamWorldStatus(db, empty.slug, ADMIN, { status: 'draft' });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.announcedAt, null);
    assert.equal(draft.purchaseOpensAt, null);

    const active = await createAvailableWorld(db, {
        name: 'Fenda Com Atividade',
        slug: 'fenda-com-atividade',
        status: 'draft',
    });
    await transitionDreamWorldStatus(db, active.id, ADMIN, { status: 'announced' });
    await transitionDreamWorldStatus(db, active.id, ADMIN, { status: 'available' });
    await submitDreamRequest(db, PLAYER, active.id, {
        buyerType: 'player',
        paymentMethod: 'manual',
        idempotencyKey: 'dream-request:draft:block',
    });
    await transitionDreamWorldStatus(db, active.id, ADMIN, { status: 'announced' });

    await assert.rejects(
        () => transitionDreamWorldStatus(db, active.id, ADMIN, { status: 'draft' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'active_requests_block_draft'
    );
});

test('transicoes invalidas e cancelamento sem motivo sao recusados', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        name: 'Fenda de Guarda',
        slug: 'fenda-de-guarda',
        status: 'draft',
    });

    await assert.rejects(
        () => transitionDreamWorldStatus(db, world.id, ADMIN, { status: 'running' }),
        (error) => error instanceof DreamWorldsServiceError
            && error.code === 'invalid_world_status_transition'
            && error.details.from === 'draft'
            && error.details.to === 'running'
    );

    await assert.rejects(
        () => transitionDreamWorldStatus(db, world.id, ADMIN, { status: 'cancelled' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'missing_transition_reason'
    );
});

test('transicao audita before e after e aceita id slug ou world_key', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, {
        key: 'MSW-STATUS-LOOKUP',
        name: 'Fenda de Auditoria',
        slug: 'fenda-de-auditoria',
        status: 'draft',
    });

    await transitionDreamWorldStatus(db, world.id, ADMIN, { status: 'announced' });
    await transitionDreamWorldStatus(db, world.slug, ADMIN, { status: 'available' });
    const paused = await transitionDreamWorldStatus(db, 'MSW-STATUS-LOOKUP', ADMIN, { status: 'announced' });
    assert.equal(paused.status, 'announced');

    const rows = await db.all(
        `SELECT * FROM clover_dream_audit
         WHERE action = 'world_status_transition'
         ORDER BY id`
    );
    assert.equal(rows.length, 3);
    const firstBefore = JSON.parse(rows[0].before_json);
    const firstAfter = JSON.parse(rows[0].after_json);
    assert.equal(firstBefore.status, 'draft');
    assert.equal(firstAfter.status, 'announced');

    const counts = await Promise.all([
        db.get('SELECT COUNT(*) AS total FROM clover_dream_runs'),
        db.get('SELECT COUNT(*) AS total FROM clover_dream_slots'),
        db.get('SELECT COUNT(*) AS total FROM clover_resonance_fragments'),
        db.get('SELECT COUNT(*) AS total FROM clover_dream_requests'),
    ]);
    assert.deepEqual(counts.map((row) => Number(row.total)), [0, 0, 0, 0]);
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 5000);
});

test('cancelamento administrativo exige motivo e bloqueia incursao ativa', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const idle = await createAvailableWorld(db, {
        name: 'Fenda Cancelavel',
        slug: 'fenda-cancelavel',
        status: 'announced',
    });

    const cancelled = await transitionDreamWorldStatus(db, idle.id, ADMIN, {
        status: 'cancelled',
        reason: 'Janela operacional encerrada.',
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.purchaseClosesAt);

    const active = await createAvailableWorld(db, {
        name: 'Fenda Com Run Ativa',
        slug: 'fenda-com-run-ativa',
    });
    await db.run(
        `INSERT INTO clover_dream_runs (
            run_key, world_id, request_id, buyer_type, buyer_id, status
         ) VALUES ('MS-ACTIVE-RUN', ?, 991, 'player', ?, 'forming_group')`,
        [active.id, PLAYER]
    );

    await assert.rejects(
        () => transitionDreamWorldStatus(db, active.id, ADMIN, {
            status: 'cancelled',
            reason: 'Tentativa com run ativa.',
        }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'active_run_blocks_transition'
    );
});

test('candidatura publica valida preenche data e nao desconta Yuls nem altera slots', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world, run } = await createFormingRun(db);
    await addPlayer(db, 'candidate@lid', 777);
    const beforeBalance = (await getYullsSummary(db, 'candidate@lid')).balance;
    const beforeSlots = Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_slots WHERE run_id = ?', [run.id])).total);

    const result = await submitDreamApplication(db, 'candidate@lid', world.slug, {
        playerNote: 'Posso entrar pela vaga publica.',
        idempotencyKey: 'dream-application:test:valid',
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.application.status, 'submitted');
    assert.ok(result.application.submittedAt);
    assert.equal(result.application.playerNote, 'Posso entrar pela vaga publica.');
    assert.equal((await getYullsSummary(db, 'candidate@lid')).balance, beforeBalance);
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_slots WHERE run_id = ?', [run.id])).total), beforeSlots);

    const duplicate = await submitDreamApplication(db, 'candidate@lid', world.slug, {
        idempotencyKey: 'dream-application:test:valid',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.application.id, result.application.id);
});

test('candidatura rejeita ausencia de incursao, vaga publica, duplicata, jogador presente e personagem inexistente', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const noRun = await createAvailableWorld(db, { status: 'reserved', slug: 'sem-run' });
    await assert.rejects(
        () => submitDreamApplication(db, OTHER, noRun.slug, { idempotencyKey: 'dream-application:no-run' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'run_not_found'
    );

    const { world, run } = await createFormingRun(db, { world: { maxPlayers: 3, slots: { squad: 1, invited: 1, public: 1 } } });
    await assert.rejects(
        () => submitDreamApplication(db, 'missing@lid', world.slug, { idempotencyKey: 'dream-application:missing-player' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'player_not_found'
    );

    await addPlayer(db, 'already@lid');
    const publicSlot = await db.get("SELECT id FROM clover_dream_slots WHERE run_id = ? AND category = 'public' AND status = 'open'", [run.id]);
    await db.run(
        "UPDATE clover_dream_slots SET player_id = ?, status = 'invited' WHERE id = ?",
        ['already@lid', publicSlot.id]
    );
    await assert.rejects(
        () => submitDreamApplication(db, OTHER, world.slug, { idempotencyKey: 'dream-application:no-public' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'public_slots_unavailable'
    );
    await assert.rejects(
        () => submitDreamApplication(db, 'already@lid', world.slug, { idempotencyKey: 'dream-application:already-in' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'public_slots_unavailable'
    );

    const larger = await createFormingRun(db);
    await submitDreamApplication(db, OTHER, larger.world.slug, { idempotencyKey: 'dream-application:dup-a' });
    await assert.rejects(
        () => submitDreamApplication(db, OTHER, larger.world.slug, { idempotencyKey: 'dream-application:dup-b' }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'active_application_exists'
    );
});

test('jogador retira candidatura propria enquanto ativa', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world } = await createFormingRun(db);
    const submitted = await submitDreamApplication(db, OTHER, world.slug, {
        idempotencyKey: 'dream-application:withdraw',
    });

    const mine = await listPlayerDreamApplications(db, OTHER);
    assert.equal(mine.length, 1);
    assert.ok(mine[0].submittedAt);

    const withdrawn = await withdrawDreamApplication(db, submitted.application.id, OTHER, { reason: 'Mudanca de planos.' });
    assert.equal(withdrawn.status, 'withdrawn');
    assert.ok(withdrawn.withdrawnAt);
    await assert.rejects(
        () => withdrawDreamApplication(db, submitted.application.id, PLAYER),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'application_forbidden'
    );
});

test('ADM lista, coloca em analise, rejeita e ve datas das candidaturas', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world } = await createFormingRun(db);
    const submitted = await submitDreamApplication(db, OTHER, world.slug, {
        playerNote: 'Tenho disponibilidade.',
        idempotencyKey: 'dream-application:review',
    });

    const list = await listAdminDreamApplications(db, { world: world.slug });
    assert.equal(list.length, 1);
    assert.equal(list[0].world.slug, world.slug);
    assert.ok(list[0].submittedAt);
    assert.equal(list[0].publicSlots.open, 2);

    const reviewing = await reviewDreamApplication(db, submitted.application.key, ADMIN, { adminNote: 'Em analise.' });
    assert.equal(reviewing.status, 'under_review');
    assert.ok(reviewing.reviewedAt);
    const rejected = await rejectDreamApplication(db, submitted.application.id, ADMIN, { adminNote: 'Sem encaixe.' });
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.rejectedAt);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS total FROM clover_dream_slots WHERE status IN ('invited', 'confirmed')")).total), 1);
});

test('selecao ocupa vaga publica como convite, confirmacao explicita funciona e aceite usa fluxo atual', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world, run } = await createFormingRun(db);
    await addPlayer(db, 'selected@lid');
    await addPlayer(db, 'confirmed@lid');
    const selectedApp = await submitDreamApplication(db, 'selected@lid', world.slug, {
        idempotencyKey: 'dream-application:select-invite',
    });
    const confirmedApp = await submitDreamApplication(db, 'confirmed@lid', world.slug, {
        idempotencyKey: 'dream-application:select-confirm',
    });

    const selected = await selectDreamApplication(db, selectedApp.application.id, ADMIN);
    assert.equal(selected.status, 'selected');
    assert.ok(selected.selectedAt);
    assert.ok(selected.slotId);
    let slot = await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [selected.slotId]);
    assert.equal(slot.category, 'public');
    assert.equal(slot.status, 'invited');
    assert.equal(slot.player_id, 'selected@lid');

    const confirmed = await selectDreamApplication(db, confirmedApp.application.id, ADMIN, { mode: 'confirmed' });
    slot = await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [confirmed.slotId]);
    assert.equal(slot.status, 'confirmed');

    const { respondDreamInvite } = require('../helpers/clover/dreamWorldsOperationsService');
    const afterAccept = await respondDreamInvite(db, selected.slotId, 'selected@lid', 'accept');
    assert.equal(afterAccept.slots.find((item) => item.id === selected.slotId).status, 'confirmed');

    const publicSlots = await db.all("SELECT status FROM clover_dream_slots WHERE run_id = ? AND category = 'public'", [run.id]);
    assert.equal(publicSlots.length, 2);
    assert.equal(publicSlots.filter((item) => ['invited', 'confirmed'].includes(item.status)).length, 2);
});

test('sexta selecao ocupa ultima vaga publica e setima e recusada sem duplicar slot', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world, run } = await createFormingRun(db, {
        world: { maxPlayers: 8, slots: { squad: 1, invited: 1, public: 6 } },
    });
    const applications = [];
    for (let index = 0; index < 7; index += 1) {
        const player = `public-${index}@lid`;
        await addPlayer(db, player);
        applications.push(await submitDreamApplication(db, player, world.slug, {
            idempotencyKey: `dream-application:capacity:${index}`,
        }));
    }
    for (let index = 0; index < 6; index += 1) {
        await selectDreamApplication(db, applications[index].application.id, ADMIN);
    }
    await assert.rejects(
        () => selectDreamApplication(db, applications[6].application.id, ADMIN),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'public_slots_unavailable'
    );
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM clover_dream_slots WHERE run_id = ?', [run.id])).total), 8);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS total FROM clover_dream_slots WHERE run_id = ? AND category = 'public' AND status IN ('invited', 'confirmed')", [run.id])).total), 6);
});

test('edicao segura de preco valida aquisicao dupla e audita before after', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const world = await createAvailableWorld(db, { slug: 'preco-editavel', yullsPrice: 2000000 });

    const updated = await updateDreamWorldAcquisition(db, world.slug, ADMIN, {
        yullsPrice: 1000000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 80,00 — apoio ao projeto',
        reason: 'Ajuste de valor antes da abertura das solicitações',
    });
    assert.equal(updated.price.yulls, 1000000);
    assert.equal(updated.price.manualEnabled, true);
    assert.equal(updated.price.manualLabel, 'R$ 80,00 — apoio ao projeto');

    await assert.rejects(
        () => updateDreamWorldAcquisition(db, world.id, ADMIN, {
            yullsPrice: 0,
            manualPaymentEnabled: true,
            manualPriceLabel: 'R$ 80,00',
        }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'missing_yulls_price'
    );
    await assert.rejects(
        () => updateDreamWorldAcquisition(db, world.id, ADMIN, {
            yullsPrice: 1,
            manualPaymentEnabled: false,
            manualPriceLabel: 'R$ 80,00',
        }),
        (error) => error instanceof DreamWorldsServiceError && error.code === 'missing_real_money_option'
    );

    const auditRows = await db.all("SELECT * FROM clover_dream_audit WHERE action = 'world_acquisition_updated'");
    assert.equal(auditRows.length, 1);
    assert.equal(JSON.parse(auditRows[0].before_json).price.yulls, 2000000);
    assert.equal(JSON.parse(auditRows[0].after_json).price.yulls, 1000000);
});
