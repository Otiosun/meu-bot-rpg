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
const {
    assignDreamSlot,
    ensureDreamOperationsSchema,
    removeDreamSlot,
    replaceDreamSlot,
} = require('../helpers/clover/dreamWorldsOperationsService');
const { auditDreamWorldsV1 } = require('../helpers/clover/dreamWorldsAuditService');
const { ensureSquadMembershipSchema } = require('../helpers/clover/squadMembershipService');

const ADMIN = 'admin@lid';
const PLAYER = 'player@lid';
const GUEST = 'guest@lid';
const REPLACEMENT = 'replacement@lid';

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
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Convidado', 1000, 'veu_negro')`, [GUEST]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Substituto', 1000, 'veu_negro')`, [REPLACEMENT]);
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
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 10,00',
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

test('Auditoria ignora historico de slots substituidos e removidos ao contar vagas efetivas', async (t) => {
    const db = await baseDb();
    t.after(() => db.close());
    await ensureDreamWorldsSchema(db);
    await ensureDreamOperationsSchema(db);
    // Production squad-slot policy checks canonical ACTIVE membership, not the
    // player's legacy esquadrao text. Give this fixture the same valid state.
    await ensureSquadMembershipSchema(db);
    for (const playerId of [PLAYER, GUEST, REPLACEMENT]) {
        await db.run(
            `INSERT INTO clover_squad_memberships
             (squad_key, player_id, status, changed_by, reason)
             VALUES ('veu_negro', ?, 'active', ?, 'fixture de auditoria')`,
            [playerId, ADMIN]
        );
    }
    const world = await createDreamWorld(db, {
        name: 'Fenda com Historico de Vagas',
        universe: 'Arquivo de Teste',
        synopsis: 'Valida que vagas historicas nao quebram a auditoria.',
        dreamType: 'self',
        rank: 'A',
        status: 'available',
        yullsPrice: 1000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 10,00',
        minPlayers: 2,
        maxPlayers: 3,
        slots: { squad: 1, invited: 1, public: 1 },
        knownChapters: 1,
    }, ADMIN);
    const request = await submitDreamRequest(db, PLAYER, world.id, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: 'audit:historical-slots',
    });
    const approved = await approveDreamRequest(db, request.request.id, ADMIN);
    const openSlots = await db.all(
        `SELECT id FROM clover_dream_slots WHERE run_id = ? AND status = 'open' ORDER BY id LIMIT 2`,
        [approved.run.id]
    );
    assert.equal(openSlots.length, 2);
    const invited = openSlots[0];
    const publicSlot = openSlots[1];

    await assignDreamSlot(db, approved.run.id, invited.id, GUEST, ADMIN, { mode: 'invited' });
    await replaceDreamSlot(db, approved.run.id, invited.id, REPLACEMENT, ADMIN, { reason: 'troca de teste' });
    await assignDreamSlot(db, approved.run.id, publicSlot.id, GUEST, ADMIN, { mode: 'confirmed' });
    await removeDreamSlot(db, approved.run.id, publicSlot.id, ADMIN, { reason: 'remocao de teste' });

    const savedSlots = await db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status IN ('open', 'invited', 'confirmed') THEN 1 ELSE 0 END) AS effective
         FROM clover_dream_slots
         WHERE run_id = ?`,
        [approved.run.id]
    );
    assert.equal(Number(savedSlots.total), 5);
    assert.equal(Number(savedSlots.effective), 3);

    const report = await auditDreamWorldsV1(db);
    assert.equal(report.summary.healthy, true, JSON.stringify(report.issues, null, 2));
    assert.equal(report.issues.some((item) => item.code === 'run_slot_count_mismatch'), false);
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
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 10,00',
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
