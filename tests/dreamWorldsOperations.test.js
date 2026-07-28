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
const {
    approveDreamRequest,
    createDreamWorld,
    ensureDreamWorldsSchema,
    submitDreamRequest,
} = require('../helpers/clover/dreamWorldsService');
const {
    assignDreamSlot,
    createResonanceFragment,
    ensureDreamOperationsSchema,
    getPlayerDreamDashboardDetailed,
    grantResonanceFragment,
    listPublicFragments,
    respondDreamInvite,
    transitionDreamRun,
} = require('../helpers/clover/dreamWorldsOperationsService');

const BUYER = 'buyer@lid';
const GUEST = 'guest@lid';
const THIRD = 'third@lid';
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
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Comprador', 10000, 'veu_negro')`, [BUYER]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Convidado', 1000, 'asas')`, [GUEST]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Terceiro', 1000, 'asas')`, [THIRD]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Administrador', 0, '-')`, [ADMIN]);
    await db.run(`INSERT INTO clover_squads (squad_key, name, captain_player_id) VALUES ('veu_negro', 'Véu Negro', ?)`, [BUYER]);
    await ensureCloverYullsLedgerSchema(db);
    await ensureDreamWorldsSchema(db);
    await ensureDreamOperationsSchema(db);
    return db;
}

async function createRun(db, suffix = 'principal') {
    const world = await createDreamWorld(db, {
        name: `A Fenda ${suffix}`,
        slug: `fenda-${suffix}`,
        universe: 'Arquivo de Operações',
        synopsis: 'Uma história usada para validar o ciclo operacional.',
        dreamType: 'self',
        rank: 'A',
        status: 'available',
        yullsPrice: 2000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 20,00',
        minPlayers: 2,
        maxPlayers: 3,
        slots: { squad: 1, invited: 1, public: 1 },
        knownChapters: 3,
    }, ADMIN);
    const request = await submitDreamRequest(db, BUYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: `ops:${suffix}`,
    });
    const approved = await approveDreamRequest(db, request.request.id, ADMIN, {
        narratorIds: [ADMIN],
    });
    return { world, run: approved.run };
}

test('Convite aceito torna a incursão pronta e permite concluir capítulos', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world, run } = await createRun(db, 'ciclo');
    const open = await db.get(`SELECT id FROM clover_dream_slots WHERE run_id = ? AND status = 'open' ORDER BY id LIMIT 1`, [run.id]);

    let detail = await assignDreamSlot(db, run.id, open.id, GUEST, ADMIN, { mode: 'invited' });
    assert.equal(detail.status, 'forming_group');
    assert.equal(detail.slots.some((slot) => slot.playerId === GUEST && slot.status === 'invited'), true);

    detail = await respondDreamInvite(db, open.id, GUEST, 'accept');
    assert.equal(detail.status, 'ready');
    assert.equal(detail.counts.confirmed, 2);

    detail = await transitionDreamRun(db, run.id, 'start', ADMIN);
    assert.equal(detail.status, 'running');
    assert.equal(detail.currentChapter, 1);

    detail = await transitionDreamRun(db, run.id, 'advance', ADMIN);
    assert.equal(detail.currentChapter, 2);
    detail = await transitionDreamRun(db, run.id, 'advance', ADMIN, { chapter: 3 });
    assert.equal(detail.currentChapter, 3);

    detail = await transitionDreamRun(db, run.id, 'complete', ADMIN, { reason: 'Objetivo central concluído.' });
    assert.equal(detail.status, 'completed');
    const savedWorld = await db.get('SELECT status FROM clover_dream_worlds WHERE id = ?', [world.id]);
    assert.equal(savedWorld.status, 'completed');
});

test('Recusa preserva histórico e recria uma vaga aberta', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { run } = await createRun(db, 'recusa');
    const open = await db.get(`SELECT id FROM clover_dream_slots WHERE run_id = ? AND status = 'open' ORDER BY id LIMIT 1`, [run.id]);
    await assignDreamSlot(db, run.id, open.id, GUEST, ADMIN, { mode: 'invited' });

    const detail = await respondDreamInvite(db, open.id, GUEST, 'decline', { reason: 'Não poderá participar.' });
    assert.equal(detail.slots.some((slot) => slot.id === open.id && slot.status === 'declined'), true);
    assert.equal(detail.slots.filter((slot) => slot.status === 'open').length, 2);
    await assert.rejects(
        () => transitionDreamRun(db, run.id, 'start', ADMIN),
        (error) => error.code === 'minimum_players_not_met'
    );
});

test('Fragmento mantém versões, torna-se público e aparece na jornada do portador', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const { world, run } = await createRun(db, 'fragmento');

    const created = await createResonanceFragment(db, {
        name: 'Postura da Lua Partida',
        category: 'style',
        originWorldId: world.id,
        originRunId: run.id,
        rarity: 'fragment',
        publicDescription: 'Um estilo de combate herdado de uma identidade vivida na Fenda.',
        effectText: 'Permite adaptar a postura corporal a ataques em arco.',
        restrictionsText: 'Não copia o poder integral da identidade de origem.',
        status: 'review',
        publicVisible: true,
    }, ADMIN);
    assert.equal(created.version, 1);

    const granted = await grantResonanceFragment(db, created.id, GUEST, ADMIN, {
        status: 'active',
        reason: 'Recompensa validada após a incursão.',
    });
    assert.equal(granted.ownerPlayerId, GUEST);
    assert.equal(granted.status, 'active');
    assert.equal(granted.version, 2);

    const publicFragments = await listPublicFragments(db);
    assert.equal(publicFragments.length, 1);
    assert.equal(publicFragments[0].slug, 'postura-da-lua-partida');

    const dashboard = await getPlayerDreamDashboardDetailed(db, GUEST);
    assert.equal(dashboard.fragments.length, 1);
    assert.equal(dashboard.fragments[0].name, 'Postura da Lua Partida');
    const versions = await db.get(`SELECT COUNT(*) AS total FROM clover_resonance_fragment_versions WHERE fragment_id = ?`, [created.id]);
    assert.equal(Number(versions.total), 2);
});
