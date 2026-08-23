'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    simulateAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    ensureRaidMonthlyProgressSchema,
    readMonthlyProgress,
    readPlayerRaidChecklist,
    reserveMonthlyScopeInTransaction,
} = require('../helpers/clover/raidMonthlyProgressService');
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');

const IDS = {
    one: '101@lid',
    two: '102@lid',
    outsider: '103@lid',
    owner: '900@lid',
    admin: '901@lid',
    narrator: '902@lid',
};

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );
        CREATE TABLE clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
        );
        INSERT INTO clover_squads (squad_key, name) VALUES
            ('coringas_magenta', 'Coringas Magenta'),
            ('asas_verdes', 'Asas Verdes');
        INSERT INTO jogadores
            (id, personagem_nome, nome, esquadrao, jogo_status, canonical_player_id)
        VALUES
            ('${IDS.one}', 'Player Um', 'Jogador Um', 'Coringas Magenta', 'liberado', '${IDS.one}'),
            ('${IDS.two}', 'Player Dois', 'Jogador Dois', 'Coringas Magenta', 'liberado', '${IDS.two}'),
            ('${IDS.outsider}', 'Player Três', 'Jogador Três', 'Asas Verdes', 'liberado', '${IDS.outsider}');
    `);
    await prepareCanonicalRaidSchema(db);
    await db.exec(`
        INSERT INTO clover_squad_memberships (player_id, squad_key, status)
        VALUES ('${IDS.one}', 'coringas_magenta', 'active'),
               ('${IDS.two}', 'coringas_magenta', 'active'),
               ('${IDS.outsider}', 'asas_verdes', 'active');
    `);
    return db;
}

const actors = {
    owner: { id: IDS.owner, role: 'owner' },
    admin: { id: IDS.admin, role: 'admin' },
    narrator: { id: IDS.narrator, role: 'narrator' },
};

function adjustmentDraft(overrides = {}) {
    return {
        title: 'Corrigir Saga mensal',
        reason: 'Correção administrativa validada',
        targets: [{ kind: 'player', playerId: IDS.one }],
        actions: [{
            type: 'raid.progress.adjust',
            payload: {
                categoryKey: 'saga_pessoal',
                monthKey: '2026-07',
                scopeType: 'player',
                scopeKey: IDS.one,
                amount: 1,
            },
        }],
        idempotencyKey: 'test:raid-progress:adjust',
        ...overrides,
    };
}

async function runToApplied(db, draft, actor, randomHex) {
    const executors = getAdminOperationExecutors();
    const created = await createAdminOperation(db, draft, actor, {
        randomBytes: () => Buffer.from(randomHex, 'hex'),
        now: new Date('2026-07-24T12:00:00.000Z'),
    });
    const simulated = await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await approveAdminOperation(db, created.operation.code, actor);
    const applied = await applyAdminOperation(db, created.operation.code, actor, { executors });
    return { executors, created, simulated, applied };
}

test('Narrador não pode criar ajuste mensal por OP-', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assert.rejects(
        () => createAdminOperation(db, adjustmentDraft(), actors.narrator),
        (error) => error?.code === 'forbidden_actions'
    );
});

test('Admin aplica e desfaz ajuste individual por ledger append-only', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const flow = await runToApplied(db, adjustmentDraft(), actors.admin, 'a1b2c3');
    assert.equal(flow.created.operation.code, 'OP-A1B2C3');
    assert.equal(flow.simulated.operation.units[0].before.completed, 0);
    assert.equal(flow.simulated.operation.units[0].after.completed, 1);
    assert.equal(flow.applied.operation.status, 'applied');

    let usage = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    assert.equal(usage.completed, 1);

    const rowsBeforeUndo = await db.all(
        `SELECT kind, amount, operation_code FROM clover_raid_monthly_ledger
         ORDER BY id ASC`
    );
    assert.deepEqual(rowsBeforeUndo, [{
        kind: 'adjustment',
        amount: 1,
        operation_code: 'OP-A1B2C3',
    }]);

    const undone = await undoAdminOperation(
        db,
        flow.created.operation.code,
        actors.admin,
        { executors: flow.executors }
    );
    assert.equal(undone.operation.status, 'undone');

    usage = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    assert.equal(usage.completed, 0);

    const rowsAfterUndo = await db.all(
        `SELECT kind, amount, operation_code, reversed_entry_id
         FROM clover_raid_monthly_ledger ORDER BY id ASC`
    );
    assert.equal(rowsAfterUndo.length, 2);
    assert.equal(rowsAfterUndo[0].kind, 'adjustment');
    assert.equal(rowsAfterUndo[1].kind, 'reversal');
    assert.equal(rowsAfterUndo[1].amount, -1);
    assert.equal(rowsAfterUndo[1].operation_code, 'OP-A1B2C3');
    assert.equal(rowsAfterUndo[1].reversed_entry_id, 1);
});

test('Admin não ultrapassa limite ocupado; Owner pode usar override explícito', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.exec('BEGIN IMMEDIATE');
    await reserveMonthlyScopeInTransaction(db, {
        raidId: 77,
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
        actorId: IDS.narrator,
    });
    await db.exec('COMMIT');

    const adminCreated = await createAdminOperation(
        db,
        adjustmentDraft({ idempotencyKey: 'test:raid-progress:limit-admin' }),
        actors.admin,
        { randomBytes: () => Buffer.from('010203', 'hex') }
    );
    await assert.rejects(
        () => simulateAdminOperation(db, adminCreated.operation.code, actors.admin, {
            executors: getAdminOperationExecutors(),
        }),
        (error) => error?.code === 'raid_progress_limit_exceeded'
    );

    const ownerDraft = adjustmentDraft({
        idempotencyKey: 'test:raid-progress:limit-owner',
        actions: [{
            type: 'raid.progress.adjust',
            payload: {
                categoryKey: 'saga_pessoal',
                monthKey: '2026-07',
                scopeType: 'player',
                scopeKey: IDS.one,
                amount: 1,
                overrideLimit: true,
            },
        }],
    });
    const ownerFlow = await runToApplied(db, ownerDraft, actors.owner, '040506');
    assert.equal(ownerFlow.applied.operation.status, 'applied');
    const usage = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    assert.equal(usage.completed, 1);
    assert.equal(usage.reserved, 1);
    assert.equal(usage.used, 2);
});

test('ajuste de esquadrão usa membro atual como âncora e aparece para todos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const draft = adjustmentDraft({
        title: 'Corrigir Missão de esquadrão',
        idempotencyKey: 'test:raid-progress:squad',
        actions: [{
            type: 'raid.progress.adjust',
            payload: {
                categoryKey: 'missao_esquadrao',
                monthKey: '2026-07',
                scopeType: 'squad',
                scopeKey: 'coringas_magenta',
                amount: 1,
            },
        }],
    });
    const flow = await runToApplied(db, draft, actors.admin, '0a0b0c');
    assert.equal(flow.applied.operation.status, 'applied');

    const first = await readPlayerRaidChecklist(db, IDS.one, { monthKey: '2026-07' });
    const second = await readPlayerRaidChecklist(db, IDS.two, { monthKey: '2026-07' });
    assert.equal(first.squadMission.completed, 1);
    assert.equal(second.squadMission.completed, 1);

    const wrongAnchor = adjustmentDraft({
        title: 'Âncora incorreta',
        targets: [{ kind: 'player', playerId: IDS.outsider }],
        idempotencyKey: 'test:raid-progress:wrong-anchor',
        actions: [{
            type: 'raid.progress.adjust',
            payload: {
                categoryKey: 'treino_esquadrao',
                monthKey: '2026-07',
                scopeType: 'squad',
                scopeKey: 'coringas_magenta',
                amount: 1,
            },
        }],
    });
    const created = await createAdminOperation(db, wrongAnchor, actors.admin, {
        randomBytes: () => Buffer.from('0d0e0f', 'hex'),
    });
    await assert.rejects(
        () => simulateAdminOperation(db, created.operation.code, actors.admin, {
            executors: getAdminOperationExecutors(),
        }),
        (error) => error?.code === 'raid_progress_squad_anchor_mismatch'
    );
});

test('liberação de reserva por OP- é reversível enquanto a vaga continuar livre', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.exec('BEGIN IMMEDIATE');
    const reserved = await reserveMonthlyScopeInTransaction(db, {
        raidId: 88,
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
        actorId: IDS.narrator,
    });
    await db.exec('COMMIT');

    const draft = {
        title: 'Liberar reserva presa',
        reason: 'Raid antiga foi encerrada sem liberar o slot',
        targets: [{ kind: 'player', playerId: IDS.one }],
        actions: [{
            type: 'raid.reservation.release',
            payload: { reservationId: reserved.reservationId },
        }],
        idempotencyKey: 'test:raid-reservation:release',
    };
    const flow = await runToApplied(db, draft, actors.admin, '102030');
    let reservation = await db.get(
        'SELECT status, release_reason, metadata_json FROM clover_raid_monthly_reservations WHERE id = ?',
        [reserved.reservationId]
    );
    assert.equal(reservation.status, 'released');
    assert.equal(reservation.release_reason, draft.reason);
    assert.equal(JSON.parse(reservation.metadata_json).admin_release.operation_code, 'OP-102030');

    await undoAdminOperation(db, flow.created.operation.code, actors.admin, {
        executors: flow.executors,
    });
    reservation = await db.get(
        'SELECT status, release_reason, metadata_json FROM clover_raid_monthly_reservations WHERE id = ?',
        [reserved.reservationId]
    );
    assert.equal(reservation.status, 'active');
    assert.equal(reservation.release_reason, null);
    assert.equal(JSON.parse(reservation.metadata_json).admin_release, undefined);
});
