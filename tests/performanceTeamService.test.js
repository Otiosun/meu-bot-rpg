'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    PerformanceTeamServiceError,
    approveProtectedAbsence,
    closePerformanceCycle,
    closeWeekPreview,
    confirmMembership,
    createCycle,
    generateTeamsFromSignups,
    getMyTeam,
    getRecruitmentProgress,
    getTeamHistory,
    joinCycle,
    recordRecruitAction,
    removeMember,
    requestProtectedAbsence,
} = require('../helpers/clover/performanceTeamService');

async function openTestDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            jogo_liberado_at TEXT DEFAULT '2026-07-01 00:00:00',
            esquadrao TEXT DEFAULT '-'
        );
    `);
    return db;
}

async function insertPlayer(db, id, patch = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, jogo_liberado_at, esquadrao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            patch.nome || id,
            patch.display_name || patch.nome || id,
            patch.personagem_nome || patch.nome || id,
            patch.ficha_status || 'aprovada',
            patch.jogo_status || 'liberado',
            patch.jogo_liberado_at || '2026-07-01 00:00:00',
            patch.esquadrao ?? '-',
        ]
    );
}

async function insertAndJoinPlayers(db, ids) {
    for (const id of ids) {
        await insertPlayer(db, id, { personagem_nome: id.replace('@lid', '') });
        await joinCycle(db, id);
    }
}

test('Times de Performance recusam player que ja tem esquadrao oficial', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await insertPlayer(db, 'player@lid', { personagem_nome: 'Veterano', esquadrao: 'Touros Negros' });
    await createCycle(db, { name: 'Ciclo Alfa', actorId: 'owner@lid' });

    await assert.rejects(
        () => joinCycle(db, 'player@lid'),
        (error) => {
            assert.ok(error instanceof PerformanceTeamServiceError);
            assert.equal(error.code, 'player_not_novice');
            return true;
        }
    );
});

test('novato liberado consegue se inscrever e confirmar vaga sorteada', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Beta', actorId: 'owner@lid' });
    for (let index = 1; index <= 4; index += 1) {
        await insertPlayer(db, `player${index}@lid`, { personagem_nome: `Novato ${index}` });
        await joinCycle(db, `player${index}@lid`);
    }

    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });
    assert.equal(draw.teams.length, 1);

    const confirmed = await confirmMembership(db, 'player1@lid');
    assert.equal(confirmed.membership.status, 'confirmed');
    assert.equal(confirmed.members.length, 4);
    assert.equal(confirmed.members[0].role, 'representative');
});

test('registro de acolhimento conta progresso semanal do time sem duplicar', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Gama', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['mentor@lid', 'ally@lid', 'third@lid', 'fourth@lid']);
    await insertPlayer(db, 'recruit@lid', { personagem_nome: 'Recruta' });
    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });

    await recordRecruitAction(db, {
        actorId: 'mentor@lid',
        recruitPlayerId: 'recruit@lid',
        actionType: 'welcomed',
    });
    const progress = await recordRecruitAction(db, {
        actorId: 'mentor@lid',
        recruitPlayerId: 'recruit@lid',
        actionType: 'welcomed',
    });

    assert.equal(progress.welcomed, 1);
    assert.equal(progress.target, 2);
    const persisted = await getRecruitmentProgress(db, draw.teams[0].id);
    assert.equal(persisted.welcomed, 1);
});

test('validacao manual de recruta conta para meta e invalidacao remove da meta', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Manual', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['mentor@lid', 'ally@lid', 'third@lid', 'fourth@lid']);
    await insertPlayer(db, 'recruit@lid', { personagem_nome: 'Recruta' });
    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });

    const validated = await recordRecruitAction(db, {
        actorId: 'owner@lid',
        teamId: draw.teams[0].id,
        recruitPlayerId: 'recruit@lid',
        actionType: 'validated',
    });
    assert.equal(validated.validatedRecruits, 1);
    assert.equal(validated.manualValidatedRecruits, 1);

    const invalidated = await recordRecruitAction(db, {
        actorId: 'owner@lid',
        teamId: draw.teams[0].id,
        recruitPlayerId: 'recruit@lid',
        actionType: 'invalidated',
    });
    assert.equal(invalidated.validatedRecruits, 0);
    assert.equal(invalidated.invalidatedRecruits, 1);
});

test('ausencia precisa de aprovacao para reduzir denominador do time', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Ausencia', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['player1@lid', 'player2@lid', 'player3@lid', 'player4@lid']);
    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });

    await requestProtectedAbsence(db, { playerId: 'player1@lid', reason: 'prova' });
    const requestedProgress = await getRecruitmentProgress(db, draw.teams[0].id);
    assert.equal(requestedProgress.activeMembers, 4);

    const approved = await approveProtectedAbsence(db, { playerId: 'player1@lid', actorId: 'owner@lid' });
    assert.equal(approved.membership.status, 'protected_absence');
    const approvedProgress = await getRecruitmentProgress(db, draw.teams[0].id);
    assert.equal(approvedProgress.activeMembers, 3);
});

test('remover representante limpa referencia do time', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Representante', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['rep@lid', 'member2@lid', 'member3@lid', 'member4@lid']);
    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });
    const before = await db.get('SELECT representative_player_id FROM clover_performance_teams WHERE id = ?', [draw.teams[0].id]);

    await removeMember(db, { playerId: before.representative_player_id, reason: 'saiu' });
    const team = await db.get('SELECT representative_player_id FROM clover_performance_teams WHERE id = ?', [draw.teams[0].id]);
    assert.equal(team.representative_player_id, null);
});

test('fechamento semanal registra historico em modo previa sem aplicar economia', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Historico', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['player@lid', 'member2@lid', 'member3@lid', 'member4@lid']);
    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });

    const result = await closeWeekPreview(db, {
        teamId: draw.teams[0].id,
        actorId: 'owner@lid',
        weekKey: '2026-07-27',
    });
    assert.equal(result.rewards.mode, 'preview_only');

    const history = await getTeamHistory(db, draw.teams[0].id);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'preview');
    assert.equal(history[0].week_key, '2026-07-27');
});

test('fechar ciclo encerra times e libera membros para ciclo futuro', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Fechamento', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['player@lid', 'member2@lid', 'member3@lid', 'member4@lid']);
    await generateTeamsFromSignups(db, { actorId: 'owner@lid' });

    const summary = await closePerformanceCycle(db, { actorId: 'owner@lid' });
    assert.equal(summary.cycle.status, 'ended');
    assert.equal(summary.teams[0].status, 'ended');

    const myTeam = await getMyTeam(db, 'player@lid');
    assert.equal(myTeam.membership, null);
});

test('sorteio automatico deixa sobras como reservas em vez de criar time incompleto', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Reserva', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['p1@lid', 'p2@lid', 'p3@lid', 'p4@lid', 'p5@lid']);

    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });
    assert.equal(draw.teams.length, 1);
    assert.equal(draw.reserves.length, 1);
    const reserve = await db.get("SELECT COUNT(*) AS total FROM clover_performance_signups WHERE status = 'reserve'");
    assert.equal(reserve.total, 1);
});

test('recrutamentos validados pelo sistema de convite contam para o time', async (t) => {
    const db = await openTestDb();
    t.after(() => db.close());
    await createCycle(db, { name: 'Ciclo Delta', actorId: 'owner@lid' });
    await insertAndJoinPlayers(db, ['recruiter@lid', 'member2@lid', 'member3@lid', 'member4@lid']);
    await insertPlayer(db, 'newbie@lid', { personagem_nome: 'Novo' });
    const draw = await generateTeamsFromSignups(db, { actorId: 'owner@lid' });
    await db.run(
        `INSERT INTO clover_recruitment_referrals
         (event_id, recruit_player_id, recruiter_player_id, recruitment_code, status, submitted_at, deadline_at, validated_at)
         VALUES (1, 'recruited@lid', 'recruiter@lid', 'CV-TESTE1', 'validated',
                 datetime('now'), datetime('now', '+7 days'), datetime('now'))`
    );

    const myTeam = await getMyTeam(db, 'recruiter@lid');
    assert.equal(myTeam.progress.validatedRecruits, 1);
    assert.equal(myTeam.progress.target, 2);
});
