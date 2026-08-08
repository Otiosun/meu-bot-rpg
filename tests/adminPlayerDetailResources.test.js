'use strict';

const assert = require('assert');
const { getAdminPlayerDetail } = require('../helpers/clover/adminPlayerDetailService');

async function run() {
    const resources = {
        available: true,
        status: 'ready',
        yulls: { balance: 1200, reserved: 200, available: 1000 },
        ph: { phAccumulated: 42, phAvailable: 17, stageKey: '8', pbTotal: 3 },
        pa: { balance: 11 },
        pm: { value: 900 },
    };
    const titles = {
        active: { id: 2, key: 'titulo:lobo', name: 'Lobo', active: true },
        owned: [{ id: 2, key: 'titulo:lobo', name: 'Lobo', active: true }],
        history: [],
        allowsNone: true,
        activePolicy: 'zero_or_one',
    };
    const progression = {
        available: true,
        status: 'ready',
        ok: true,
        progression: {
            playerId: 'player-1',
            stageKey: '8',
            pbTotal: 20,
            pbSpent: 10,
            pbFree: 10,
            distributionStatus: 'confirmed',
            allocatedAttributes: { forca: 2, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 2 },
            effectiveAttributes: { forca: 2, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 7 },
            pmExternalDelta: 5,
            pendingDistribution: null,
        },
        trees: [{ id: 'mana', name: 'Mana', ownedIds: ['mana_base'], ownedCount: 1, totalNodes: 10 }],
        pendingPurchase: null,
        approvalQueue: { available: false, status: 'live_hotfix_required' },
    };

    const detail = await getAdminPlayerDetail({}, 'player-1', {
        resolveCanonical: async () => ({
            canonical: {
                id: 'player-1',
                personagem_nome: 'Teste',
                is_shadow: 0,
            },
            chain: [{ id: 'player-1', personagem_nome: 'Teste', is_shadow: 0 }],
        }),
        listAliases: async () => [],
        getTraitOverview: async () => ({ available: true, status: 'ready', slots: [] }),
        getPossessions: async () => ({
            available: true,
            status: 'ready',
            titles,
            boxes: { recentOpenings: [] },
            redemptions: { pending: [], history: [] },
        }),
        getResources: async () => resources,
        getProgression: async () => progression,
    });

    assert.deepStrictEqual(detail.resources, resources);
    assert.deepStrictEqual(detail.progression, progression);
    assert.deepStrictEqual(detail.modules.progression, progression);
    assert.deepStrictEqual(detail.modules.rewards.titles, titles);
    assert.strictEqual(detail.player.playerId, 'player-1');
    assert.strictEqual(detail.player.characterName, 'Teste');
    console.log('adminPlayerDetailResources.test.js ok');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
