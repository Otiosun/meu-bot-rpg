'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createAsyncAdapter;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createAsyncAdapter = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    Module._load = function loadSqliteFallback(request, parent, isMain) {
        if (request === 'sqlite3') return { verbose: () => ({ Database: class TestDriver {} }) };
        if (request === 'sqlite') return { open: async () => { throw new Error('open() não deve ser usado'); } };
        return originalLoad.call(this, request, parent, isMain);
    };
    createAsyncAdapter = async () => {
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

const {
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const { assignAccessRole, ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');
const { getYullsSummary } = require('../helpers/clover/yullsService');
const {
    addRaidReward,
    beginRaidFinalization,
    cancelRaid,
    completeRaid,
    createRaid,
    joinRaid,
    setRaidParticipantFinalization,
    startRaid,
} = require('../helpers/clover/raidService');

Module._load = originalLoad;

const NARRATOR = 'narrator-test';
const PLAYER = 'player-test';
const OTHER = 'other-player-test';

async function fixture() {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-', personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL, personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-', personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover', classe TEXT DEFAULT '-', familia TEXT DEFAULT '-', raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-', magia TEXT DEFAULT '-', formas TEXT DEFAULT '-', esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0, patente TEXT DEFAULT '-', aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-', marca_comum TEXT DEFAULT '-', marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', historias_extras TEXT DEFAULT '[]', jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores (id, personagem_nome, esquadrao) VALUES
            ('${NARRATOR}', 'Narrador', '-'),
            ('${PLAYER}', 'Player Teste', 'Coringas Magenta'),
            ('${OTHER}', 'Outro Player', 'Coringas Magenta');
    `);
    await prepareCanonicalRaidSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('coringas_magenta', 'Coringas Magenta')`
    );
    await assignAccessRole(db, {
        subjectId: NARRATOR,
        role: 'narrator',
        assignedBy: NARRATOR,
        reason: 'teste de atomicidade',
    });
    return db;
}

async function raidState(db, raidId) {
    const [raid, participant, reward, deliveries, ledger, reservation] = await Promise.all([
        db.get('SELECT status FROM clover_raids WHERE id = ?', [raidId]),
        db.get('SELECT status FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?', [raidId, PLAYER]),
        db.get('SELECT status FROM clover_raid_rewards WHERE raid_id = ?', [raidId]),
        db.get('SELECT COUNT(*) AS total FROM clover_raid_reward_deliveries WHERE raid_id = ?', [raidId]),
        db.get('SELECT COUNT(*) AS total FROM clover_raid_monthly_ledger WHERE raid_id = ?', [raidId]),
        db.get('SELECT status FROM clover_raid_monthly_reservations WHERE raid_id = ? AND scope_key = ?', [raidId, PLAYER]),
    ]);
    return {
        raid: raid?.status || null,
        participant: participant?.status || null,
        reward: reward?.status || null,
        deliveries: Number(deliveries?.total || 0),
        ledger: Number(ledger?.total || 0),
        reservation: reservation?.status || null,
        yulls: (await getYullsSummary(db, PLAYER)).balance,
    };
}

test('falha no crédito mensal desfaz recompensa e conclusão na mesma transação', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const created = await createRaid(db, NARRATOR, {
        name: 'Saga Atômica',
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    await joinRaid(db, created.raid.key, PLAYER);
    await startRaid(db, created.raid.key, NARRATOR);
    await addRaidReward(db, created.raid.key, NARRATOR, {
        targetType: 'general',
        rewardType: 'yulls',
        amount: 2000,
        label: 'Pagamento da Saga',
    });
    await beginRaidFinalization(db, created.raid.key, NARRATOR);
    await setRaidParticipantFinalization(db, created.raid.key, NARRATOR, PLAYER, {
        status: 'eligible',
    });

    await db.exec(`
        CREATE TRIGGER block_monthly_credit
        BEFORE INSERT ON clover_raid_monthly_ledger
        BEGIN
            SELECT RAISE(ABORT, 'monthly credit blocked');
        END
    `);

    await assert.rejects(
        () => completeRaid(db, created.raid.key, NARRATOR, {
            idempotencyKey: 'atomic-completion',
        }),
        /monthly credit blocked/
    );

    assert.deepEqual(await raidState(db, created.raid.id), {
        raid: 'finalization',
        participant: 'active',
        reward: 'draft',
        deliveries: 0,
        ledger: 0,
        reservation: 'active',
        yulls: 0,
    });

    await db.exec('DROP TRIGGER block_monthly_credit');
    const completed = await completeRaid(db, created.raid.key, NARRATOR, {
        idempotencyKey: 'atomic-completion',
    });
    assert.equal(completed.raid.status, 'completed');
    assert.equal(completed.deliveries, 1);
    assert.equal(completed.monthlyProgress.completed, 1);

    assert.deepEqual(await raidState(db, created.raid.id), {
        raid: 'completed',
        participant: 'completed',
        reward: 'applied',
        deliveries: 1,
        ledger: 1,
        reservation: 'consumed',
        yulls: 2000,
    });

    const duplicate = await completeRaid(db, created.raid.key, NARRATOR, {
        idempotencyKey: 'atomic-completion',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal((await raidState(db, created.raid.id)).ledger, 1);
    assert.equal((await raidState(db, created.raid.id)).yulls, 2000);
});

test('entrada bloqueada por outra Saga não deixa participante fantasma', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await createRaid(db, NARRATOR, {
        name: 'Saga que reserva o jogador',
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    const otherSaga = await createRaid(db, NARRATOR, {
        name: 'Saga do outro jogador',
        category: 'saga_pessoal',
        scopePlayerId: OTHER,
    });

    await assert.rejects(
        () => joinRaid(db, otherSaga.raid.key, PLAYER),
        (error) => error?.code === 'raid_monthly_limit_reached'
    );

    const participant = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ?`,
        [otherSaga.raid.id, PLAYER]
    );
    assert.equal(Number(participant.total), 0);
    const reservation = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raid_monthly_reservations
         WHERE raid_id = ? AND scope_key = ?`,
        [otherSaga.raid.id, PLAYER]
    );
    assert.equal(Number(reservation.total), 0);
});

test('falha ao liberar reserva desfaz o cancelamento da Raid', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const created = await createRaid(db, NARRATOR, {
        name: 'Saga de Cancelamento Atômico',
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });

    await db.exec(`
        CREATE TRIGGER block_reservation_release
        BEFORE UPDATE ON clover_raid_monthly_reservations
        WHEN NEW.status = 'released'
        BEGIN
            SELECT RAISE(ABORT, 'reservation release blocked');
        END
    `);

    await assert.rejects(
        () => cancelRaid(db, created.raid.key, NARRATOR, 'Teste de rollback'),
        /reservation release blocked/
    );

    let state = await raidState(db, created.raid.id);
    assert.equal(state.raid, 'lobby');
    assert.equal(state.reservation, 'active');

    await db.exec('DROP TRIGGER block_reservation_release');
    const cancelled = await cancelRaid(db, created.raid.key, NARRATOR, 'Cancelamento confirmado');
    assert.equal(cancelled.raid.status, 'cancelled');
    state = await raidState(db, created.raid.id);
    assert.equal(state.raid, 'cancelled');
    assert.equal(state.reservation, 'released');
});
