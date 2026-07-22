'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    maskPhoneFromPlayerId,
    searchAdminPlayers,
    similarity,
} = require('../helpers/clover/adminPlayerSearchService');

const players = [
    {
        id: '5511999999999@s.whatsapp.net',
        personagem_nome: 'Ragnar',
        display_name: 'Rafa',
        jogo_status: 'liberado',
        lifecycle_status: 'active',
        is_shadow: 0,
    },
    {
        id: '222@lid',
        personagem_nome: 'Feramena',
        display_name: 'Jogadora A',
        jogo_status: 'liberado',
        lifecycle_status: 'active',
        is_shadow: 0,
    },
    {
        id: '333@lid',
        personagem_nome: 'Feramena',
        display_name: 'Jogadora B',
        jogo_status: 'bloqueado',
        lifecycle_status: 'archived',
        is_shadow: 0,
    },
];

const deps = {
    listPlayers: async () => players,
    getCanonical: async (_db, player) => player,
};

test('mascara telefone sem expor o número completo', () => {
    assert.equal(maskPhoneFromPlayerId('5511999999999@s.whatsapp.net'), '5511••••9999');
    assert.equal(maskPhoneFromPlayerId('231426393948202@lid'), null);
});

test('sugere Ragnar para erro Rangar', async () => {
    const result = await searchAdminPlayers({}, 'Rangar', {
        ...deps,
        findMatches: async () => [],
    });

    assert.equal(result.exact.length, 0);
    assert.equal(result.suggestions[0].characterName, 'Ragnar');
    assert.equal(result.suggestions[0].source, 'fuzzy');
    assert.equal(result.ambiguous, false);
});

test('marca nome duplicado como ambíguo antes da operação', async () => {
    const result = await searchAdminPlayers({}, 'Feramena', {
        ...deps,
        findMatches: async () => [
            { player: players[1], score: 90, source: 'character' },
            { player: players[2], score: 90, source: 'character' },
        ],
    });

    assert.equal(result.exact.length, 2);
    assert.equal(result.ambiguous, true);
    assert.equal(result.exact[0].playerId, '222@lid');
    assert.equal(result.exact[1].playerId, '333@lid');
});

test('mantém resolução canônica e informa redirecionamento', async () => {
    const canonical = players[0];
    const result = await searchAdminPlayers({}, '5511999999999', {
        ...deps,
        findMatches: async () => [{
            player: canonical,
            score: 140,
            source: 'phone',
            redirectedFrom: 'old@lid',
        }],
    });

    assert.equal(result.exact.length, 1);
    assert.equal(result.exact[0].canonical, true);
    assert.equal(result.exact[0].redirectedFrom, 'old@lid');
    assert.equal(result.exact[0].phoneMasked, '5511••••9999');
});

test('recusa busca curta demais', async () => {
    await assert.rejects(() => searchAdminPlayers({}, 'R', {
        ...deps,
        findMatches: async () => [],
    }), { code: 'search_query_too_short' });
});

test('similaridade distingue erro pequeno de nome distante', () => {
    assert.ok(similarity('Rangar', 'Ragnar') > 0.7);
    assert.ok(similarity('Rangar', 'Gohhan') < similarity('Rangar', 'Ragnar'));
});
