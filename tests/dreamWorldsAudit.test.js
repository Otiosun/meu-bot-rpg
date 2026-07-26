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
const { createDreamWorld, ensureDreamWorldsSchema } = require('../helpers/clover/dreamWorldsService');
const { ensureDreamOperationsSchema } = require('../helpers/clover/dreamWorldsOperationsService');
const { auditDreamWorldsV1 } = require('../helpers/clover/dreamWorldsAuditService');

const ADMIN = 'admin@lid';
const PLAYER = 'player@lid';

async function baseDb() {
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
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Administrador', 0, '-')`, [ADMIN]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Jogador', 5000, 'veu_negro')`, [PLAYER]);
    await db.run(`INSERT INTO clover_squads (squad_key, name) VALUES ('veu_negro', 'Véu Negro')`);
    await ensureCloverYullsLedgerSchema(db);
    return db;
}

test('Auditoria reconhece módulo ainda não instalado sem alterar o banco', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());
    const report = await auditDreamWorldsV1(db);
    assert.equal(report.installed, false);
    assert.equal(report.summary.healthy, false);
    assert.equal(report.summary.bySeverity.critical > 0, true);
    assert.equal(await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clover_dream_worlds'`), undefined);
});

test('Estrutura vazia e Fenda válida passam sem crítico', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());
    await ensureDreamWorldsSchema(db);
    await ensureDreamOperationsSchema(db);
    await createDreamWorld(db, {
        name: 'Fenda Auditada',
        universe: 'Arquivo de Teste',
        synopsis: 'Uma Fenda estruturalmente válida.',
        dreamType: 'self',
        rank: 'B',
        status: 'available',
        yullsPrice: 1000,
        minPlayers: 2,
        maxPlayers: 4,
        slots: { squad: 1, invited: 1, public: 2 },
        knownChapters: 1,
    }, ADMIN);
    const report = await auditDreamWorldsV1(db);
    assert.equal(report.installed, true);
    assert.equal(report.summary.healthy, true);
    assert.equal(report.counts.worlds, 1);
});

test('Auditoria encontra solicitação aprovada sem incursão e sem extrato', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());
    await ensureDreamWorldsSchema(db);
    await ensureDreamOperationsSchema(db);
    const world = await createDreamWorld(db, {
        name: 'Fenda Corrompida',
        universe: 'Arquivo de Teste',
        synopsis: 'Registro criado para simular inconsistência.',
        dreamType: 'self',
        rank: 'A',
        status: 'reserved',
        yullsPrice: 1000,
        minPlayers: 2,
        maxPlayers: 3,
        slots: { squad: 1, invited: 1, public: 1 },
        knownChapters: 1,
    }, ADMIN);
    await db.run(
        `INSERT INTO clover_dream_requests (
            request_key, world_id, requester_player_id, buyer_type, buyer_id,
            payment_method, status, idempotency_key, approved_at
         ) VALUES ('MSR-BROKEN', ?, ?, 'player', ?, 'yulls', 'approved', 'audit:broken', CURRENT_TIMESTAMP)`,
        [world.id, PLAYER, PLAYER]
    );
    const report = await auditDreamWorldsV1(db);
    const codes = new Set(report.issues.map((item) => item.code));
    assert.equal(report.summary.healthy, false);
    assert.equal(codes.has('approved_request_without_run'), true);
    assert.equal(codes.has('approved_yulls_without_ledger'), true);
    assert.equal(codes.has('world_run_status_mismatch'), true);
});