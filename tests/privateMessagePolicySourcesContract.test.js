'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    evaluatePrivateMessagePolicy,
    resolveSourcePolicy,
} = require('../helpers/clover/privateMessagePolicy');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const TRANSACTIONAL_SOURCES = [
    'appearance_result',
    'history_adjustment',
    'game_release',
    'game_block',
    'post_ficha',
    'linkoff_player',
    'spell_review_invite',
    'spell_review_invite_fallback',
    'community_exit_confirmation',
];

test('fontes críticas são transacionais e aceitam evento deduplicável', () => {
    for (const source of TRANSACTIONAL_SOURCES) {
        const resolved = resolveSourcePolicy(source);
        assert.equal(resolved.category, 'transactional', source);
        assert.equal(resolved.disposition, 'preserve', source);

        const decision = evaluatePrivateMessagePolicy({
            source,
            dedupeKey: `${source}:player:event`,
        }, {});
        assert.equal(decision.allowed, true, source);
        assert.equal(decision.dailyBudgetExempt, true, source);
    }
});

test('resposta do fluxo de saída é reativa e não exige dedupe', () => {
    const decision = evaluatePrivateMessagePolicy({
        source: 'community_exit_reply',
    }, {});
    assert.equal(decision.allowed, true);
    assert.equal(decision.policy.category, 'reactive');
    assert.equal(decision.dedupeRequired, false);
});

test('pós-ficha envia source e dedupeKey explícitos', () => {
    const source = read('helpers/clover/registrationManager.js');
    assert.match(source, /source: 'post_ficha'/);
    assert.match(source, /dedupeKey: `post_ficha:\$\{playerId\}`/);
});

test('resultado de aparência usa o id da avaliação como evento', () => {
    const source = read('helpers/clover/appearanceManager.js');
    assert.match(source, /source: 'appearance_result'/);
    assert.match(source, /appearance_result:\$\{review\.id \|\| review\.message_id \|\| review\.player_id\}:\$\{action\}/);
});

test('história, liberação e bloqueio possuem eventos independentes', () => {
    const source = read('comandos/historiaJogo.js');
    assert.match(source, /source: 'history_adjustment'/);
    assert.match(source, /source: 'game_release'/);
    assert.match(source, /source: 'game_block'/);
    assert.match(source, /m\?\.key\?\.id \|\| 'manual'/);
});

test('convite de avaliação classifica mensagem oficial, texto e fallback', () => {
    const source = read('helpers/clover/groupManager.js');
    assert.match(source, /source: 'spell_review_invite'/);
    assert.match(source, /policy: privatePolicy/);
    assert.match(source, /source: 'spell_review_invite_fallback'/);
});

test('saída e retorno distinguem transação de resposta reativa', () => {
    const source = read('helpers/clover/communityExitManager.js');
    assert.match(source, /source: 'community_exit_confirmation'/);
    assert.match(source, /source: 'community_exit_reply'/);
    assert.match(source, /community_exit_cancel:\$\{player\.id\}:\$\{pending\.id\}/);
});

test('reenvio do link OFF já carrega fonte transacional na fila', () => {
    const source = read('comandos/gruposClover.js');
    assert.match(source, /source: 'linkoff_player'/);
    assert.match(source, /reason: 'reenvio_jogo_liberado'/);
});
