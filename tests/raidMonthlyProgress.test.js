'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    getRaidCategoryCatalog,
    resolveRaidCategory,
} = require('../helpers/clover/raidCategoryCatalog');
const {
    RaidMonthlyProgressError,
    completeRaidProgressInTransaction,
    ensureRaidMonthlyProgressSchema,
    readMonthlyProgress,
    readPlayerRaidChecklist,
    releaseRaidProgressInTransaction,
    reserveMonthlyScopeInTransaction,
    reserveParticipantInTransaction,
    reserveRaidScopeInTransaction,
} = require('../helpers/clover/raidMonthlyProgressService');
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');

const IDS = {
    one: 'player-one',
    two: 'player-two',
    three: 'player-three',
};

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            esquadrao TEXT DEFAULT '-'
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        INSERT INTO clover_squads (squad_key, name)
        VALUES ('coringas_magenta', 'Coringas Magenta');
        INSERT INTO jogadores (id, esquadrao) VALUES
            ('${IDS.one}', 'Coringas Magenta'),
            ('${IDS.two}', 'Coringas Magenta'),
            ('${IDS.three}', '-');
    `);
    await prepareCanonicalRaidSchema(db);
    return db;
}

function sagaRaid(id, playerId = IDS.one) {
    return {
        id,
        raid_key: `RAID-SAGA-${id}`,
        name: `Saga ${id}`,
        category: 'saga_pessoal',
        category_key: 'saga_pessoal',
        scope_type: 'player',
        scope_player_id: playerId,
        scope_squad_key: null,
        month_key: '2026-07',
        created_at: '2026-07-10 12:00:00',
    };
}

function squadRaid(id, categoryKey = 'missao_esquadrao') {
    return {
        id,
        raid_key: `RAID-SQUAD-${id}`,
        name: `Operação ${id}`,
        category: categoryKey,
        category_key: categoryKey,
        scope_type: 'squad',
        scope_player_id: null,
        scope_squad_key: 'coringas_magenta',
        month_key: '2026-07',
        created_at: '2026-07-10 12:00:00',
    };
}

test('catálogo público unifica Saga individual e Missão de desenvolvimento', () => {
    const catalog = getRaidCategoryCatalog();
    assert.deepEqual(catalog.map((item) => item.key), [
        'saga_pessoal',
        'missao_esquadrao',
        'treino_esquadrao',
        'evento_especial',
    ]);
    assert.equal(catalog[0].label, 'Saga individual / Missão de desenvolvimento');
    assert.deepEqual(catalog[0].equivalentLabels, ['Saga individual', 'Missão de desenvolvimento']);
    assert.equal(catalog[0].monthlyLimit, 1);
    assert.equal(catalog[1].monthlyLimit, 2);
    assert.equal(catalog[2].monthlyLimit, 2);
    assert.equal(catalog[3].monthlyLimit, null);
    assert.equal(resolveRaidCategory('missao_desenvolvimento').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('Missão de desenvolvimento').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('Saga individual').key, 'saga_pessoal');
});

test('Saga separa reserva de lobby e conclusão real', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const raid = sagaRaid(1);

    await db.exec('BEGIN IMMEDIATE');
    await reserveRaidScopeInTransaction(db, raid, 'narrator');
    await db.exec('COMMIT');

    let usage = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    assert.equal(usage.completed, 0);
    assert.equal(usage.reserved, 1);
    assert.equal(usage.used, 1);
    assert.equal(usage.exhausted, true);

    await db.exec('BEGIN IMMEDIATE');
    const completion = await completeRaidProgressInTransaction(db, raid, [
        { id: 10, player_id: IDS.one, status: 'active' },
    ], 'narrator');
    await db.exec('COMMIT');
    assert.equal(completion.completed, 1);

    usage = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    assert.equal(usage.completed, 1);
    assert.equal(usage.reserved, 0);
    assert.equal(usage.used, 1);

    await db.exec('BEGIN IMMEDIATE');
    const duplicate = await completeRaidProgressInTransaction(db, raid, [
        { id: 10, player_id: IDS.one, status: 'active' },
    ], 'narrator');
    await db.exec('COMMIT');
    assert.equal(duplicate.completed, 0);
    const ledger = await db.get('SELECT COUNT(*) AS total FROM clover_raid_monthly_ledger');
    assert.equal(Number(ledger.total), 1);
});

test('cancelar lobby libera a reserva sem criar conclusão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const raid = sagaRaid(2);

    await db.exec('BEGIN IMMEDIATE');
    await reserveRaidScopeInTransaction(db, raid, 'narrator');
    await releaseRaidProgressInTransaction(db, raid, 'narrator', 'raid_cancelled');
    await db.exec('COMMIT');

    const usage = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    assert.equal(usage.completed, 0);
    assert.equal(usage.reserved, 0);
    assert.equal(usage.remaining, 1);
});

test('participante com Saga já concluída pode entrar sem novo crédito', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (entry_key, raid_id, category_key, month_key, scope_type, scope_key,
          participant_id, amount, kind, created_by)
         VALUES ('seed-completion', 90, 'saga_pessoal', '2026-07',
                 'player', ?, 90, 1, 'completion', 'seed')`,
        [IDS.two]
    );
    const raid = sagaRaid(3, IDS.one);

    await db.exec('BEGIN IMMEDIATE');
    const result = await reserveParticipantInTransaction(db, raid, {
        id: 30,
        player_id: IDS.two,
    }, IDS.two);
    await db.exec('COMMIT');

    assert.equal(result.reserved, false);
    assert.equal(result.creditEligible, false);
    assert.equal(result.reason, 'already_completed');
    const reservations = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raid_monthly_reservations
         WHERE scope_key = ?`,
        [IDS.two]
    );
    assert.equal(Number(reservations.total), 0);
});

test('reserva ativa em outra Saga bloqueia participação concorrente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const first = sagaRaid(4, IDS.two);
    const second = sagaRaid(5, IDS.one);

    await db.exec('BEGIN IMMEDIATE');
    await reserveParticipantInTransaction(db, first, { id: 40, player_id: IDS.two }, IDS.two);
    await db.exec('COMMIT');

    await db.exec('BEGIN IMMEDIATE');
    await assert.rejects(
        () => reserveParticipantInTransaction(db, second, { id: 50, player_id: IDS.two }, IDS.two),
        (error) => error instanceof RaidMonthlyProgressError
            && error.code === 'raid_monthly_limit_reached'
    );
    await db.exec('ROLLBACK');
});

test('Missão e Treino usam dois espaços compartilhados do esquadrão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await db.exec('BEGIN IMMEDIATE');
    await reserveRaidScopeInTransaction(db, squadRaid(10, 'missao_esquadrao'), 'narrator');
    await reserveRaidScopeInTransaction(db, squadRaid(11, 'missao_esquadrao'), 'narrator');
    await db.exec('COMMIT');

    const mission = await readMonthlyProgress(db, {
        categoryKey: 'missao_esquadrao',
        monthKey: '2026-07',
        scopeType: 'squad',
        scopeKey: 'coringas_magenta',
    });
    assert.equal(mission.completed, 0);
    assert.equal(mission.reserved, 2);
    assert.equal(mission.limit, 2);
    assert.equal(mission.exhausted, true);

    await db.exec('BEGIN IMMEDIATE');
    await assert.rejects(
        () => reserveRaidScopeInTransaction(db, squadRaid(12, 'missao_esquadrao'), 'narrator'),
        (error) => error instanceof RaidMonthlyProgressError
            && error.code === 'raid_monthly_limit_reached'
    );
    await db.exec('ROLLBACK');

    await db.exec('BEGIN IMMEDIATE');
    await reserveRaidScopeInTransaction(db, squadRaid(20, 'treino_esquadrao'), 'narrator');
    await reserveRaidScopeInTransaction(db, squadRaid(21, 'treino_esquadrao'), 'narrator');
    await db.exec('COMMIT');
    const training = await readMonthlyProgress(db, {
        categoryKey: 'treino_esquadrao',
        monthKey: '2026-07',
        scopeType: 'squad',
        scopeKey: 'coringas_magenta',
    });
    assert.equal(training.limit, 2);
    assert.equal(training.reserved, 2);
});

test('todos os membros atuais leem o mesmo contador do esquadrão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const raid = squadRaid(30, 'missao_esquadrao');

    await db.exec('BEGIN IMMEDIATE');
    await reserveRaidScopeInTransaction(db, raid, 'narrator');
    await completeRaidProgressInTransaction(db, raid, [
        { id: 301, player_id: IDS.one, status: 'active' },
    ], 'narrator');
    await db.exec('COMMIT');

    const first = await readPlayerRaidChecklist(db, IDS.one, { monthKey: '2026-07' });
    const second = await readPlayerRaidChecklist(db, IDS.two, { monthKey: '2026-07' });
    assert.equal(first.squadMission.completed, 1);
    assert.equal(second.squadMission.completed, 1);
    assert.equal(first.squadMission.limit, 2);
    assert.equal(second.squadMission.limit, 2);
});

test('Evento especial permanece ilimitado e sem reserva', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const usage = await readMonthlyProgress(db, {
        categoryKey: 'evento_especial',
        monthKey: '2026-07',
    });
    assert.equal(usage.countsMonthly, false);
    assert.equal(usage.limit, null);
    assert.equal(usage.exhausted, false);

    await db.exec('BEGIN IMMEDIATE');
    const reservation = await reserveMonthlyScopeInTransaction(db, {
        raidId: 99,
        categoryKey: 'evento_especial',
        monthKey: '2026-07',
        scopeType: 'player',
        scopeKey: IDS.one,
    });
    await db.exec('COMMIT');
    assert.equal(reservation.reserved, false);
});
