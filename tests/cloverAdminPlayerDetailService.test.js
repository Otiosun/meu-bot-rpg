'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getAdminPlayerDetail,
    maskIdentity,
    sanitizeAlias,
} = require('../helpers/clover/adminPlayerDetailService');

test('mascara identidades sensíveis sem perder o tipo', () => {
    assert.equal(maskIdentity('5511999999999@s.whatsapp.net'), '5511••••9999');
    assert.equal(maskIdentity('231426393948202@lid'), '231•••202@lid');
    assert.equal(sanitizeAlias({ alias_type: 'character', alias_value: 'Gohhan' }).label, 'Gohhan');
    assert.equal(sanitizeAlias({ alias_type: 'phone', alias_value: '5511999999999' }).label, '5511••••9999');
});

test('retorna ficha administrativa do cadastro canônico', async () => {
    const result = await getAdminPlayerDetail({}, 'old@lid', {
        resolveCanonical: async () => ({
            original: { id: 'old@lid', personagem_nome: '-' },
            canonical: {
                id: '231426393948202@lid',
                personagem_nome: 'Gohhan',
                display_name: 'Jogador',
                esquadrao: 'Touros Negros',
                jogo_status: 'liberado',
                lifecycle_status: 'active',
                identity_status: 'active',
                magia: 'Fogo',
                reino: 'Clover',
                classe: 'Nobreza',
                raca: 'Humano',
                grimorio: 'Grimório de 3 Folhas',
                canonical_player_id: '231426393948202@lid',
                is_shadow: 0,
            },
            redirectedFrom: 'old@lid',
            redirectReason: 'merged_shadow',
            chain: [
                {
                    id: 'old@lid',
                    personagem_nome: '-',
                    merged_into: '231426393948202@lid',
                    canonical_player_id: '231426393948202@lid',
                    is_shadow: 1,
                },
                {
                    id: '231426393948202@lid',
                    personagem_nome: 'Gohhan',
                    merged_into: null,
                    canonical_player_id: '231426393948202@lid',
                    is_shadow: 0,
                },
            ],
        }),
        listAliases: async () => [
            {
                alias_type: 'phone',
                alias_value: '5511999999999',
                source: 'merge',
                confidence: 100,
                updated_at: '2026-07-22T00:00:00Z',
            },
            {
                alias_type: 'character',
                alias_value: 'Gohhan',
                source: 'manual',
                confidence: 100,
            },
        ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.player.playerId, '231426393948202@lid');
    assert.equal(result.player.characterName, 'Gohhan');
    assert.equal(result.player.magic, 'Fogo');
    assert.equal(result.player.kingdomKey, 'clover');
    assert.equal(result.player.raceKey, 'humano');
    assert.equal(result.player.grimoireKey, 'clover_3f');
    assert.equal(result.player.classKey, 'nobreza');
    assert.ok(result.profileOptions.magics.length > 0);
    assert.ok(result.profileOptions.races.some((entry) => entry.key === 'bruxa'));
    assert.ok(result.profileOptions.grimoires.some((entry) => entry.key === 'clover_4f'));
    assert.ok(result.profileOptions.socialClasses.some((entry) => entry.key === 'realeza'));
    assert.equal(result.identity.requestedPlayerId, 'old@lid');
    assert.equal(result.identity.canonicalPlayerId, '231426393948202@lid');
    assert.equal(result.identity.redirectedFromPlayerId, 'old@lid');
    assert.equal(result.identity.redirectedFromMasked, 'old@lid');
    assert.equal(result.identity.aliases[0].label, '5511••••9999');
    assert.equal(result.identity.aliases[1].label, 'Gohhan');
    assert.equal(result.identity.chain.length, 2);
});

test('recusa jogador inexistente', async () => {
    await assert.rejects(
        () => getAdminPlayerDetail({}, 'missing@lid', {
            resolveCanonical: async () => ({ canonical: null, chain: [] }),
            listAliases: async () => [],
        }),
        { code: 'player_not_found', status: 404 }
    );
});
