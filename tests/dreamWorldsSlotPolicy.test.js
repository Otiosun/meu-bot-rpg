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
                return { changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) };
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
const { ensureDreamOperationsSchema } = require('../helpers/clover/dreamWorldsOperationsService');
const { assignDreamSlotWithPolicy } = require('../helpers/clover/dreamWorldsSlotPolicyService');

const BUYER = 'buyer@lid';
const ALLY = 'ally@lid';
const OUTSIDER = 'outsider@lid';
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
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Aliado', 1000, 'Véu Negro')`, [ALLY]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Forasteiro', 1000, 'asas')`, [OUTSIDER]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Administrador', 0, '-')`, [ADMIN]);
    await db.run(`INSERT INTO clover_squads (squad_key, name, captain_player_id) VALUES ('veu_negro', 'Véu Negro', ?)`, [BUYER]);
    await db.run(`INSERT INTO clover_squads (squad_key, name) VALUES ('asas', 'Asas da Liberdade')`);
    await ensureCloverYullsLedgerSchema(db);
    await ensureDreamWorldsSchema(db);
    await ensureDreamOperationsSchema(db);
    return db;
}

async function createRun(db) {
    const world = await createDreamWorld(db, {
        name: 'Fenda de Política',
        universe: 'Arquivo de Teste',
        synopsis: 'Teste de vagas reservadas ao esquadrão.',
        dreamType: 'self',
        rank: 'A',
        status: 'available',
        yullsPrice: 1000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 10,00',
        minPlayers: 2,
        maxPlayers: 4,
        slots: { squad: 2, invited: 1, public: 1 },
        knownChapters: 1,
    }, ADMIN);
    const request = await submitDreamRequest(db, BUYER, world.id, {
        buyerType: 'squad',
        buyerId: 'veu_negro',
        paymentMethod: 'yulls',
        idempotencyKey: 'slot-policy:test',
    });
    return (await approveDreamRequest(db, request.request.id, ADMIN)).run;
}

test('Vaga de esquadrão aceita membro equivalente por nome ou chave', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const run = await createRun(db);
    const slot = await db.get(`SELECT id FROM clover_dream_slots WHERE run_id = ? AND category = 'squad' AND status = 'open' LIMIT 1`, [run.id]);
    const result = await assignDreamSlotWithPolicy(db, run.id, slot.id, ALLY, ADMIN, { mode: 'confirmed' });
    assert.equal(result.slots.some((entry) => entry.playerId === ALLY && entry.status === 'confirmed'), true);
});

test('Vaga de esquadrão bloqueia personagem de outra organização', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    const run = await createRun(db);
    const slot = await db.get(`SELECT id FROM clover_dream_slots WHERE run_id = ? AND category = 'squad' AND status = 'open' LIMIT 1`, [run.id]);
    await assert.rejects(
        () => assignDreamSlotWithPolicy(db, run.id, slot.id, OUTSIDER, ADMIN, { mode: 'confirmed' }),
        (error) => error.code === 'squad_slot_forbidden'
    );
    const saved = await db.get('SELECT status, player_id FROM clover_dream_slots WHERE id = ?', [slot.id]);
    assert.equal(saved.status, 'open');
    assert.equal(saved.player_id, null);
});
