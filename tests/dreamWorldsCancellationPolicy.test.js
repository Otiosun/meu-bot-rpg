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
    respondDreamInvite,
    transitionDreamRun,
} = require('../helpers/clover/dreamWorldsOperationsService');
const { getYullsSummary } = require('../helpers/clover/yullsService');

const BUYER = 'buyer@lid';
const GUEST = 'guest@lid';
const ADMIN = 'admin@lid';

async function setup(t, suffix) {
    const db = await createDb();
    t.after(() => db.close());
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
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Convidado', 0, 'asas')`, [GUEST]);
    await db.run(`INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao) VALUES (?, 'Administrador', 0, '-')`, [ADMIN]);
    await db.run(`INSERT INTO clover_squads (squad_key, name, captain_player_id) VALUES ('veu_negro', 'Véu Negro', ?)`, [BUYER]);
    await ensureCloverYullsLedgerSchema(db);
    await ensureDreamWorldsSchema(db);

    const world = await createDreamWorld(db, {
        name: `Fenda de Cancelamento ${suffix}`,
        slug: `fenda-cancelamento-${suffix}`,
        universe: 'Arquivo de Política',
        synopsis: 'Manifestação usada para validar cancelamentos e reembolsos.',
        dreamType: 'self',
        rank: 'A',
        status: 'available',
        yullsPrice: 2000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 20,00',
        minPlayers: 2,
        maxPlayers: 2,
        slots: { squad: 0, invited: 1, public: 1 },
        knownChapters: 2,
    }, ADMIN);
    const request = await submitDreamRequest(db, BUYER, world.slug, {
        buyerType: 'player',
        paymentMethod: 'yulls',
        idempotencyKey: `cancel-policy:${suffix}`,
    });
    const approved = await approveDreamRequest(db, request.request.id, ADMIN);
    return { db, world, request: approved.request, run: approved.run };
}

test('cancelamento antes do início não cria reembolso automático', async (t) => {
    const { db, world, request, run } = await setup(t, 'antes');
    assert.equal((await getYullsSummary(db, BUYER)).balance, 8000);

    const cancelled = await transitionDreamRun(db, run.id, 'cancel', ADMIN, {
        reason: 'Manifestação cancelada pela administração antes da convocação.',
    });

    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await getYullsSummary(db, BUYER)).balance, 8000);
    assert.equal((await db.get('SELECT status FROM clover_dream_worlds WHERE id = ?', [world.id])).status, 'cancelled');
    assert.equal((await db.get('SELECT status FROM clover_dream_requests WHERE id = ?', [request.id])).status, 'approved');

    const metadata = JSON.parse((await db.get('SELECT metadata_json FROM clover_dream_runs WHERE id = ?', [run.id])).metadata_json);
    assert.equal(metadata.lastActionReason, 'Manifestação cancelada pela administração antes da convocação.');

    const audit = await db.get(
        `SELECT reason FROM clover_dream_audit
         WHERE action = 'run_cancel' AND entity_type = 'dream_run' AND entity_id = ?`,
        [String(run.id)]
    );
    assert.equal(audit.reason, 'Manifestação cancelada pela administração antes da convocação.');
});

test('cancelamento depois do início também preserva o débito e o histórico aprovado', async (t) => {
    const { db, request, run } = await setup(t, 'depois');
    const open = await db.get(
        `SELECT id FROM clover_dream_slots WHERE run_id = ? AND status = 'open' ORDER BY id LIMIT 1`,
        [run.id]
    );
    await assignDreamSlot(db, run.id, open.id, GUEST, ADMIN, { mode: 'invited' });
    await respondDreamInvite(db, open.id, GUEST, 'accept');
    await transitionDreamRun(db, run.id, 'start', ADMIN);

    const cancelled = await transitionDreamRun(db, run.id, 'cancel', ADMIN, {
        reason: 'Impossibilidade operacional reconhecida após o primeiro capítulo.',
    });

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.currentChapter, 1);
    assert.equal((await getYullsSummary(db, BUYER)).balance, 8000);
    assert.equal((await db.get('SELECT status FROM clover_dream_requests WHERE id = ?', [request.id])).status, 'approved');

    const approvalAudits = Number((await db.get(
        `SELECT COUNT(*) AS total FROM clover_dream_audit
         WHERE action = 'request_approved' AND entity_id = ?`,
        [String(request.id)]
    )).total);
    const cancellationAudits = Number((await db.get(
        `SELECT COUNT(*) AS total FROM clover_dream_audit
         WHERE action = 'run_cancel' AND entity_id = ?`,
        [String(run.id)]
    )).total);
    assert.equal(approvalAudits, 1);
    assert.equal(cancellationAudits, 1);
});
