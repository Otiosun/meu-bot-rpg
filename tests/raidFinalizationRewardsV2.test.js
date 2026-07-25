'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    ensureCloverInventorySchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const { getBoxDashboard } = require('../helpers/clover/boxService');
const { getPaSummary } = require('../helpers/clover/paService');
const { getPhSummary } = require('../helpers/clover/phService');
const {
    addRaidReward,
    beginRaidFinalization,
    cancelRaidReward,
    completeRaid,
    createRaid,
    getRaidCategoryCatalog,
    getRaidFinalizationSummary,
    joinRaid,
    resolveRaidCategory,
    setRaidParticipantFinalization,
    startRaid,
} = require('../helpers/clover/raidService');
const { getYullsSummary } = require('../helpers/clover/yullsService');

const NARRATOR = 'narrator-finalization@lid';
const PLAYER = 'player-finalization@lid';
const ABSENT = 'absent-finalization@lid';

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
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
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', historias_extras TEXT DEFAULT '[]',
            jogo_status TEXT DEFAULT 'liberado', dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores (id, personagem_nome, esquadrao) VALUES
            ('${NARRATOR}', 'Narrador', '-'),
            ('${PLAYER}', 'Personagem Presente', 'Coringas Magenta'),
            ('${ABSENT}', 'Personagem Ausente', 'Coringas Magenta');
    `);
    await ensureCloverInventorySchema(db);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('coringas_magenta', 'Coringas Magenta')`
    );
    await assignAccessRole(db, {
        subjectId: NARRATOR,
        role: 'narrator',
        assignedBy: NARRATOR,
        reason: 'fixture de finalização',
    });
    return db;
}

async function prepareRaid(db, name = 'Saga de Finalização') {
    const created = await createRaid(db, NARRATOR, {
        name,
        category: 'missao_desenvolvimento',
        scopePlayerId: PLAYER,
    });
    await joinRaid(db, created.raid.key, PLAYER);
    await joinRaid(db, created.raid.key, ABSENT);
    await startRaid(db, created.raid.key, NARRATOR);
    await db.run(
        `UPDATE clover_character_stats
         SET poder_magico = 10
         WHERE player_id IN (?, ?)`,
        [PLAYER, ABSENT]
    );
    return created;
}

test('catálogo apresenta Saga individual e Missão de desenvolvimento como a mesma categoria', () => {
    const saga = getRaidCategoryCatalog().find((category) => category.key === 'saga_pessoal');
    assert.ok(saga);
    assert.equal(saga.label, 'Saga individual / Missão de desenvolvimento');
    assert.deepEqual(saga.equivalentLabels, ['Saga individual', 'Missão de desenvolvimento']);
    assert.equal(resolveRaidCategory('Saga individual').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('Missão de desenvolvimento').key, 'saga_pessoal');
    assert.equal(resolveRaidCategory('missao_desenvolvimento').key, 'saga_pessoal');
});

test('finalização exige revisão e entrega recompensas nativas sem teto arbitrário apenas aos elegíveis', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const created = await prepareRaid(db);

    for (const reward of [
        { rewardType: 'yulls', amount: 250000, label: 'Pagamento livre do narrador' },
        { rewardType: 'ph', amount: 120, label: 'PH livre do narrador' },
        { rewardType: 'stars', amount: 12, label: 'Estrelas livres do narrador' },
        { rewardType: 'pa', amount: 80, label: 'Pontos de Avaliação' },
        { rewardType: 'pm', amount: -3, label: 'Penalidade de Poder Mágico' },
        { rewardType: 'box', boxKey: 'simples', amount: 2, label: 'Duas Caixas Simples' },
    ]) {
        await addRaidReward(db, created.raid.key, NARRATOR, {
            targetType: 'general',
            ...reward,
        });
    }

    await beginRaidFinalization(db, created.raid.key, NARRATOR);
    await assert.rejects(
        () => completeRaid(db, created.raid.key, NARRATOR, { idempotencyKey: 'pending-review' }),
        (error) => error?.code === 'raid_eligibility_pending'
    );

    await setRaidParticipantFinalization(db, created.raid.key, NARRATOR, PLAYER, {
        status: 'eligible',
    });
    await setRaidParticipantFinalization(db, created.raid.key, NARRATOR, ABSENT, {
        status: 'absent',
        note: 'Não participou da cena final.',
    });

    const preview = await getRaidFinalizationSummary(db, created.raid.key, NARRATOR);
    assert.equal(preview.counts.eligible, 1);
    assert.equal(preview.counts.absent, 1);
    assert.equal(preview.counts.pending, 0);
    assert.equal(preview.counts.plannedDeliveries, 6);
    assert.equal(preview.canComplete, true);
    assert.deepEqual(preview.totals, {
        yulls: 250000,
        ph: 120,
        stars: 12,
        pa: 80,
        pm: -3,
        box: 2,
    });

    const completed = await completeRaid(db, created.raid.key, NARRATOR, {
        idempotencyKey: 'reviewed-completion',
    });
    assert.equal(completed.raid.status, 'completed');
    assert.equal(completed.deliveries, 6);
    assert.equal(completed.eligibleParticipants, 1);
    assert.equal(completed.excludedParticipants, 1);
    assert.equal(completed.monthlyProgress.completed, 1);

    assert.equal((await getYullsSummary(db, PLAYER)).balance, 250000);
    assert.equal((await getPhSummary(db, PLAYER)).phAvailable, 135);
    assert.equal((await getPaSummary(db, PLAYER)).balance, 80);
    assert.equal(
        Number((await db.get(
            'SELECT poder_magico FROM clover_character_stats WHERE player_id = ?',
            [PLAYER]
        )).poder_magico),
        7
    );
    assert.equal(
        Number((await db.get('SELECT estrelas FROM jogadores WHERE id = ?', [PLAYER])).estrelas),
        12
    );
    const boxes = await getBoxDashboard(db, PLAYER);
    assert.equal(boxes.boxes.find((box) => box.key === 'simples').owned, 2);

    assert.equal((await getYullsSummary(db, ABSENT)).balance, 0);
    assert.equal((await getPaSummary(db, ABSENT)).balance, 0);
    assert.equal(
        Number((await db.get(
            'SELECT poder_magico FROM clover_character_stats WHERE player_id = ?',
            [ABSENT]
        )).poder_magico),
        10
    );

    const reservationPresent = await db.get(
        `SELECT status FROM clover_raid_monthly_reservations
         WHERE raid_id = ? AND scope_key = ?`,
        [created.raid.id, PLAYER]
    );
    const reservationAbsent = await db.get(
        `SELECT status FROM clover_raid_monthly_reservations
         WHERE raid_id = ? AND scope_key = ?`,
        [created.raid.id, ABSENT]
    );
    assert.equal(reservationPresent.status, 'consumed');
    assert.equal(reservationAbsent.status, 'released');

    const absentDeliveries = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raid_reward_deliveries
         WHERE raid_id = ? AND player_id = ?`,
        [created.raid.id, ABSENT]
    );
    assert.equal(Number(absentDeliveries.total), 0);
});

test('recompensa individual para ausente bloqueia conclusão até ser cancelada', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const created = await prepareRaid(db, 'Saga com recompensa inválida');

    const drafted = await addRaidReward(db, created.raid.key, NARRATOR, {
        targetType: 'player',
        targetPlayerId: ABSENT,
        rewardType: 'yulls',
        amount: 5000,
        label: 'Recompensa individual',
    });
    await beginRaidFinalization(db, created.raid.key, NARRATOR);
    await setRaidParticipantFinalization(db, created.raid.key, NARRATOR, PLAYER, {
        status: 'eligible',
    });
    await setRaidParticipantFinalization(db, created.raid.key, NARRATOR, ABSENT, {
        status: 'ineligible',
        note: 'Não cumpriu as condições narrativas.',
    });

    const blocked = await getRaidFinalizationSummary(db, created.raid.key, NARRATOR);
    assert.equal(blocked.canComplete, false);
    assert.equal(blocked.warnings.some((warning) => warning.code === 'reward_target_not_eligible'), true);
    await assert.rejects(
        () => completeRaid(db, created.raid.key, NARRATOR, { idempotencyKey: 'invalid-target' }),
        (error) => error?.code === 'reward_without_eligible_target'
    );

    await cancelRaidReward(db, created.raid.key, NARRATOR, drafted.reward.id);
    const ready = await getRaidFinalizationSummary(db, created.raid.key, NARRATOR);
    assert.equal(ready.canComplete, true);
    const completed = await completeRaid(db, created.raid.key, NARRATOR, {
        idempotencyKey: 'cancelled-invalid-target',
    });
    assert.equal(completed.deliveries, 0);
});
