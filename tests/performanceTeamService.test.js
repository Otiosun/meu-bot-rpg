'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    cancelPerformanceTeamApplication,
    confirmPerformanceTeamApplication,
    ensurePerformanceTeamSchema,
    isPerformanceTeamAdmin,
    joinPerformanceTeams,
    listPerformanceTeamApplications,
    renderApplicationList,
    renderCommands,
    renderPhaseTwo,
} = require('../helpers/clover/performanceTeamService');
const { assignAccessRole } = require('../helpers/clover/accessRoleAssignmentService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            esquadrao TEXT DEFAULT '-'
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
        );
        INSERT INTO jogadores (id, personagem_nome, ficha_status, jogo_status, esquadrao) VALUES
            ('novato@lid', 'Novato Livre', 'aprovada', 'liberado', '-'),
            ('membro@lid', 'Membro de Squad', 'aprovada', 'liberado', 'Touros Negros'),
            ('travado@lid', 'Travado', 'aprovada', 'bloqueado', '-');
    `);
    await db.run(
        `INSERT INTO clover_squad_memberships (player_id, squad_key, status)
         VALUES ('membro@lid', 'touros_negros', 'active')`
    );
    await ensurePerformanceTeamSchema(db);
    return db;
}

test('times comandos e publico e mostra comandos de player', () => {
    const output = renderCommands('.#', false);
    assert.match(output, /\.#times participar/);
    assert.match(output, /\.#time confirmar/);
    assert.match(output, /\.#time sair/);
    assert.match(output, /\.#meutime/);
    assert.match(output, /Fase 2/);
    assert.doesNotMatch(output, /Administracao ativa/);
});

test('times comandos admin separa acoes ativas da fase 2', () => {
    const output = renderCommands('.#', true);
    assert.match(output, /Administracao ativa/);
    assert.match(output, /\.#times lista/);
    assert.match(output, /\.#time confirmar @player/);
    assert.match(output, /\.#time cancelar @player/);
    assert.doesNotMatch(output, /ciclo criar/);

    const phaseTwo = renderPhaseTwo('.#', '.#time votar 1');
    assert.match(phaseTwo, /fase atual cobre fila/i);
    assert.match(phaseTwo, /fase 2/i);
});

test('administrador global pode acessar controles administrativos dos times', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await assignAccessRole(db, {
        subjectId: 'admin@lid',
        role: 'admin',
        assignedBy: 'owner@lid',
        reason: 'Teste de permissao dos Times.',
    });

    assert.equal(await isPerformanceTeamAdmin(db, 'admin@lid'), true);
    assert.equal(await isPerformanceTeamAdmin(db, 'player@lid'), false);
});

test('inscricao aceita apenas novato liberado sem esquadrao', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const joined = await joinPerformanceTeams(db, 'novato@lid');
    assert.equal(joined.ok, true);
    assert.equal(joined.duplicate, false);

    const duplicate = await joinPerformanceTeams(db, 'novato@lid');
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);

    const squadMember = await joinPerformanceTeams(db, 'membro@lid');
    assert.equal(squadMember.ok, false);
    assert.equal(squadMember.code, 'already_in_squad');

    const blocked = await joinPerformanceTeams(db, 'travado@lid');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'game_not_released');
});

test('player confirma e cancela inscricao sem criar duplicata confusa', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const missing = await confirmPerformanceTeamApplication(db, 'novato@lid');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'application_not_found');

    await joinPerformanceTeams(db, 'novato@lid');

    const confirmed = await confirmPerformanceTeamApplication(db, 'novato@lid', { actorId: 'novato@lid' });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.duplicate, false);
    assert.equal(confirmed.application.status, 'confirmed');

    const duplicate = await confirmPerformanceTeamApplication(db, 'novato@lid', { actorId: 'novato@lid' });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);

    const cancelled = await cancelPerformanceTeamApplication(db, 'novato@lid', {
        actorId: 'novato@lid',
        reason: 'Mudei de ideia.',
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.application.status, 'cancelled');

    const joinedAgain = await joinPerformanceTeams(db, 'novato@lid');
    assert.equal(joinedAgain.ok, true);
    assert.equal(joinedAgain.duplicate, false);
});

test('admin lista inscricoes abertas com estado legivel', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await joinPerformanceTeams(db, 'novato@lid');
    await confirmPerformanceTeamApplication(db, 'novato@lid', { actorId: 'admin@lid' });

    const list = await listPerformanceTeamApplications(db);
    assert.equal(list.rows.length, 1);
    assert.equal(list.rows[0].status, 'confirmed');

    const output = renderApplicationList(list);
    assert.match(output, /Novato Livre/);
    assert.match(output, /confirmado/);
});
