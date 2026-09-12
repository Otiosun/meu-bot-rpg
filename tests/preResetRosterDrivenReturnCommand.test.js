'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMAND_PREFIX } = require('../config/bot');
const { resolveCommand } = require('../helpers/commandRegistry');
const incentivo = require('../comandos/incentivo');
const retorno = require('../comandos/retorno');

function dbFixture({ rosterStatus = 'finalized', outcome = null, approved = true } = {}) {
    return {
        async get(sql) {
            if (sql.includes('FROM clover_prereset_launch_rosters')) {
                return { campaign_key: 'mythic_launch_v1', status: rosterStatus, revision: 1, finalized_at: '2026-08-28T00:00:00Z' };
            }
            if (sql.includes('FROM clover_prereset_launch_players')) {
                return outcome
                    ? { campaign_key: 'mythic_launch_v1', player_id: 'player-1', roster_revision: 1, outcome, status: 'pending' }
                    : null;
            }
            if (sql.includes('FROM jogadores')) {
                return approved
                    ? { id: 'player-1', ficha_status: 'aprovada', personagem_nome: 'Legacy' }
                    : null;
            }
            throw new Error(`SQL inesperado: ${sql}`);
        },
    };
}

test('retorno nao colide mais com incentivo', () => {
    assert.ok(!incentivo.aliases.includes(`${COMMAND_PREFIX}retorno`));
    const commands = new Map([
        [incentivo.nome, incentivo],
        [retorno.nome, retorno],
    ]);
    const resolved = resolveCommand(`${COMMAND_PREFIX}retorno`, commands);
    assert.equal(resolved?.command, retorno);
    assert.equal(resolved?.matchedName, `${COMMAND_PREFIX}retorno`);
});

test('roster KEEP e autoridade unica: jogador nao escolhe', async () => {
    const state = await retorno.getAssignedReturnState(dbFixture({ outcome: 'keep' }), 'player-1');
    assert.equal(state.kind, 'keep');
    const text = retorno.renderAssignedReturnState(state);
    assert.match(text, /Situação: MANTER/);
    assert.match(text, /não precisa escolher nem confirmar nada/i);
    assert.doesNotMatch(text, /confirmar manter/i);
    assert.doesNotMatch(text, /resetar\*/i);
});

test('fora da whitelist vira RESET automatico sem confirmacao do jogador', async () => {
    const state = await retorno.getAssignedReturnState(dbFixture({ outcome: 'reset' }), 'player-1');
    assert.equal(state.kind, 'reset');
    const text = retorno.renderAssignedReturnState(state);
    assert.match(text, /RESET AUTOMÁTICO/);
    assert.match(text, /não precisa escolher nem confirmar nada/i);
    assert.match(text, /reset destrutivo ainda não foi executado/i);
});

test('legacy aprovado ausente do roster finalizado falha fechado', async () => {
    const state = await retorno.getAssignedReturnState(dbFixture({ outcome: null, approved: true }), 'player-1');
    assert.equal(state.kind, 'unassigned');
    assert.equal(state.reason, 'approved_player_missing_from_finalized_roster');
});

test('novo player nao recebe falsa escolha de manter ou resetar', async () => {
    const state = await retorno.getAssignedReturnState(dbFixture({ outcome: null, approved: false }), 'player-1');
    assert.equal(state.kind, 'new_player');
    const text = retorno.renderAssignedReturnState(state);
    assert.doesNotMatch(text, /confirmar manter/i);
    assert.doesNotMatch(text, /confirmar reset/i);
});
test('retorno nao consulta coluna applied_at inexistente no schema de launch players', async () => {
    const queries = [];
    const db = {
        async get(sql) {
            queries.push(sql);
            if (sql.includes('FROM clover_prereset_launch_rosters')) {
                return { campaign_key: 'mythic_launch_v1', status: 'finalized', revision: 1, finalized_at: null };
            }
            if (sql.includes('FROM clover_prereset_launch_players')) {
                return { campaign_key: 'mythic_launch_v1', player_id: 'player-1', roster_revision: 1, outcome: 'reset', status: 'pending' };
            }
            throw new Error(`SQL inesperado: ${sql}`);
        },
    };

    const state = await retorno.getAssignedReturnState(db, 'player-1');
    assert.equal(state.kind, 'reset');

    const assignmentSql = queries.find((sql) => sql.includes('FROM clover_prereset_launch_players'));
    assert.ok(assignmentSql);
    assert.doesNotMatch(assignmentSql, /\bapplied_at\b/);
});