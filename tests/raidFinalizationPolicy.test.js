'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverInventorySchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const {
    beginRaidFinalization,
    completeRaid,
    createRaid,
    getRaidFinalizationSummary,
    joinRaid,
    setRaidParticipantFinalization,
    startRaid,
} = require('../helpers/clover/raidService');

const NARRATOR = 'narrator-zero-eligible@lid';
const PLAYER = 'player-zero-eligible@lid';
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');

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
            ('${PLAYER}', 'Participante', 'Coringas Magenta');
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
        reason: 'teste de elegibilidade',
    });
    return db;
}

test('raid não conclui sem ao menos um participante elegível', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const created = await createRaid(db, NARRATOR, {
        name: 'Saga sem presença',
        category: 'saga_pessoal',
        scopePlayerId: PLAYER,
    });
    await joinRaid(db, created.raid.key, PLAYER);
    await startRaid(db, created.raid.key, NARRATOR);
    await beginRaidFinalization(db, created.raid.key, NARRATOR);
    await setRaidParticipantFinalization(db, created.raid.key, NARRATOR, PLAYER, {
        status: 'absent',
        note: 'Não participou da execução.',
    });

    const summary = await getRaidFinalizationSummary(db, created.raid.key, NARRATOR);
    assert.equal(summary.counts.eligible, 0);
    assert.equal(summary.counts.absent, 1);
    assert.equal(summary.canComplete, false);
    assert.equal(
        summary.warnings.some((warning) => warning.code === 'raid_without_eligible_participants'),
        true
    );

    await assert.rejects(
        () => completeRaid(db, created.raid.key, NARRATOR, {
            idempotencyKey: 'zero-eligible',
        }),
        (error) => error?.code === 'raid_without_eligible_participants'
    );

    const raid = await db.get('SELECT status FROM clover_raids WHERE id = ?', [created.raid.id]);
    const reservation = await db.get(
        `SELECT status FROM clover_raid_monthly_reservations
         WHERE raid_id = ? AND scope_key = ?`,
        [created.raid.id, PLAYER]
    );
    assert.equal(raid.status, 'finalization');
    assert.equal(reservation.status, 'active');
});
