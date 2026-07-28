'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

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
} = require('../helpers/clover/dreamWorldsOperationsService');
const { getYullsSummary } = require('../helpers/clover/yullsService');

const BUYER = 'buyer@lid';
const PLAYER_A = 'player-a@lid';
const PLAYER_B = 'player-b@lid';
const ADMIN = 'admin@lid';

async function openConnection(filename) {
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    return db;
}

async function fixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'clover-dream-concurrency-'));
    const filename = path.join(directory, 'dreams.sqlite');
    const dbA = await openConnection(filename);
    const dbB = await openConnection(filename);

    t.after(async () => {
        await Promise.allSettled([dbA.close(), dbB.close()]);
        await rm(directory, { recursive: true, force: true });
    });

    await dbA.exec(`
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

    for (const [id, name, money, squad] of [
        [BUYER, 'Mago Comprador', 5000, 'veu_negro'],
        [PLAYER_A, 'Mago A', 0, 'veu_negro'],
        [PLAYER_B, 'Mago B', 0, 'asas'],
        [ADMIN, 'Administrador', 0, '-'],
    ]) {
        await dbA.run(
            `INSERT INTO jogadores (id, personagem_nome, dinheiro, esquadrao)
             VALUES (?, ?, ?, ?)`,
            [id, name, money, squad]
        );
    }
    await dbA.run(
        `INSERT INTO clover_squads (squad_key, name, captain_player_id)
         VALUES ('veu_negro', 'Véu Negro', ?)`,
        [BUYER]
    );

    await ensureCloverYullsLedgerSchema(dbA);
    await ensureDreamWorldsSchema(dbA);

    const world = await createDreamWorld(dbA, {
        name: 'A Fenda Concorrente',
        universe: 'Arquivo de Teste',
        arc: 'Primeiro Capítulo',
        synopsis: 'Uma manifestação criada para validar disputas simultâneas.',
        dreamType: 'self',
        rank: 'A',
        status: 'available',
        riskLevel: 'alto',
        yullsPrice: 2000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 20,00',
        minPlayers: 2,
        maxPlayers: 4,
        slots: { squad: 1, invited: 1, public: 2 },
        knownChapters: 2,
        publicRisks: ['Morte real'],
        rules: ['Sem entrada solo'],
        fragmentCategories: ['trait'],
    }, ADMIN);

    const submitted = await submitDreamRequest(dbA, BUYER, world.slug, {
        buyerType: 'squad',
        buyerId: 'veu_negro',
        paymentMethod: 'yulls',
        idempotencyKey: 'dream-concurrency:request',
    });

    return { dbA, dbB, world, request: submitted.request };
}

function fulfilled(results) {
    return results.filter((result) => result.status === 'fulfilled');
}

function rejected(results) {
    return results.filter((result) => result.status === 'rejected');
}

test('duas aprovações concorrentes debitam Yuls e criam incursão apenas uma vez', async (t) => {
    const { dbA, dbB, request } = await fixture(t);

    const results = await Promise.allSettled([
        approveDreamRequest(dbA, request.id, ADMIN, { adminNote: 'Aprovação A' }),
        approveDreamRequest(dbB, request.id, ADMIN, { adminNote: 'Aprovação B' }),
    ]);

    assert.equal(rejected(results).length, 0);
    assert.equal(fulfilled(results).length, 2);
    assert.deepEqual(
        fulfilled(results).map((result) => result.value.duplicate).sort(),
        [false, true]
    );

    assert.equal(Number((await dbA.get('SELECT COUNT(*) AS total FROM clover_dream_runs')).total), 1);
    assert.equal(Number((await dbA.get('SELECT COUNT(*) AS total FROM clover_dream_slots')).total), 4);
    assert.equal((await getYullsSummary(dbA, BUYER)).balance, 3000);

    const requestRow = await dbA.get(
        'SELECT status, yulls_ledger_id FROM clover_dream_requests WHERE id = ?',
        [request.id]
    );
    assert.equal(requestRow.status, 'approved');
    assert.ok(requestRow.yulls_ledger_id);

    const approvalAudits = await dbA.get(
        `SELECT COUNT(*) AS total FROM clover_dream_audit
         WHERE action = 'request_approved' AND entity_id = ?`,
        [String(request.id)]
    );
    assert.equal(Number(approvalAudits.total), 1);
});

test('duas atribuições concorrentes não ocupam a mesma vaga com dois magos', async (t) => {
    const { dbA, dbB, request } = await fixture(t);
    const approved = await approveDreamRequest(dbA, request.id, ADMIN);
    const slot = await dbA.get(
        `SELECT * FROM clover_dream_slots
         WHERE run_id = ? AND status = 'open' AND category = 'public'
         ORDER BY id LIMIT 1`,
        [approved.run.id]
    );

    const results = await Promise.allSettled([
        assignDreamSlot(dbA, approved.run.id, slot.id, PLAYER_A, ADMIN, { mode: 'confirmed' }),
        assignDreamSlot(dbB, approved.run.id, slot.id, PLAYER_B, ADMIN, { mode: 'confirmed' }),
    ]);

    assert.equal(fulfilled(results).length, 1);
    assert.equal(rejected(results).length, 1);
    assert.equal(rejected(results)[0].reason?.code, 'slot_not_open');

    const saved = await dbA.get('SELECT player_id, status FROM clover_dream_slots WHERE id = ?', [slot.id]);
    assert.equal(saved.status, 'confirmed');
    assert.ok([PLAYER_A, PLAYER_B].includes(saved.player_id));

    const activeOnSlot = await dbA.get(
        `SELECT COUNT(*) AS total FROM clover_dream_slots
         WHERE id = ? AND status IN ('invited', 'confirmed')`,
        [slot.id]
    );
    assert.equal(Number(activeOnSlot.total), 1);
});

test('duas respostas concorrentes ao mesmo convite produzem uma única decisão', async (t) => {
    const { dbA, dbB, request } = await fixture(t);
    const approved = await approveDreamRequest(dbA, request.id, ADMIN);
    const slot = await dbA.get(
        `SELECT * FROM clover_dream_slots
         WHERE run_id = ? AND status = 'open' AND category = 'invited'
         ORDER BY id LIMIT 1`,
        [approved.run.id]
    );
    await assignDreamSlot(dbA, approved.run.id, slot.id, PLAYER_A, ADMIN, { mode: 'invited' });
    const beforeCount = Number((await dbA.get('SELECT COUNT(*) AS total FROM clover_dream_slots')).total);

    const results = await Promise.allSettled([
        respondDreamInvite(dbA, slot.id, PLAYER_A, 'accept'),
        respondDreamInvite(dbB, slot.id, PLAYER_A, 'decline', { reason: 'Resposta concorrente' }),
    ]);

    assert.equal(fulfilled(results).length, 1);
    assert.equal(rejected(results).length, 1);
    assert.equal(rejected(results)[0].reason?.code, 'invite_not_pending');

    const saved = await dbA.get('SELECT status FROM clover_dream_slots WHERE id = ?', [slot.id]);
    assert.ok(['confirmed', 'declined'].includes(saved.status));
    const afterCount = Number((await dbA.get('SELECT COUNT(*) AS total FROM clover_dream_slots')).total);
    assert.equal(afterCount, saved.status === 'declined' ? beforeCount + 1 : beforeCount);

    const decisionAudits = await dbA.get(
        `SELECT COUNT(*) AS total FROM clover_dream_audit
         WHERE entity_type = 'dream_slot' AND entity_id = ?
           AND action IN ('invite_accepted', 'invite_declined')`,
        [String(slot.id)]
    );
    assert.equal(Number(decisionAudits.total), 1);
});
