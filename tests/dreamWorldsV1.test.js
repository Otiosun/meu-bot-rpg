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
    listPublicDreamWorlds,
    rejectDreamRequest,
    submitDreamRequest,
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
