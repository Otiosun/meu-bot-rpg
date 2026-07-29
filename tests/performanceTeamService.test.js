'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensurePerformanceTeamSchema,
    isPerformanceTeamAdmin,
    joinPerformanceTeams,
    renderCommands,
} = require('../helpers/clover/performanceTeamService');

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
        INSERT INTO jogadores (id, personagem_nome, ficha_status, jogo_status, esquadrao) VALUES
            ('novato@lid', 'Novato Livre', 'aprovada', 'liberado', '-'),
            ('membro@lid', 'Membro de Squad', 'aprovada', 'liberado', 'Touros Negros'),
            ('travado@lid', 'Travado', 'aprovada', 'bloqueado', '-');
    `);
    await ensurePerformanceTeamSchema(db);
    return db;
}

test('times comandos e publico e mostra comandos de player', () => {
    const output = renderCommands('.#', false);
    assert.match(output, /\.#times participar/);
    assert.match(output, /\.#meutime/);
    assert.doesNotMatch(output, /Times Admin/);
});

test('owner e Edmund podem acessar controles administrativos dos times', () => {
    assert.equal(isPerformanceTeamAdmin('557998868223@s.whatsapp.net'), true);
    assert.equal(isPerformanceTeamAdmin('5591984726680@s.whatsapp.net'), true);
    assert.equal(isPerformanceTeamAdmin('5511999999999@s.whatsapp.net'), false);
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
