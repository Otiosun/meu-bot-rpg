'use strict';

const assert = require('assert');
const {
    assertRewardEffectSnapshotsFresh,
    materializeRewardPackageEffects,
    normalizeRewardPackageEffects,
} = require('../helpers/clover/adminOperationService');

async function run() {
    const normalized = normalizeRewardPackageEffects([
        { type: 'title', referenceKey: 'titulo:lobo', label: 'Lobo' },
        { type: 'trait', traitId: 'TR-ABC123', slotKey: 'traco_extra' },
        { type: 'hook', hookId: 'HK-ABC123', priority: 7 },
    ]);
    assert.deepStrictEqual(
        normalized.map((effect) => effect.action.type),
        ['player.title.grant', 'player.trait.assign', 'player.hook.assign']
    );
    assert.strictEqual(normalized[0].action.payload.titleKey, 'titulo:lobo');
    assert.strictEqual(normalized[1].action.payload.traitId, 'TR-ABC123');
    assert.strictEqual(normalized[1].action.payload.slotKey, 'traco_extra');
    assert.strictEqual(normalized[2].action.payload.hookId, 'HK-ABC123');
    assert.strictEqual(normalized[2].action.payload.priority, 7);

    assert.throws(
        () => normalizeRewardPackageEffects([{ type: 'access', referenceKey: 'vip' }]),
        (error) => error?.code === 'reward_access_effect_not_supported'
    );

    let packageSnapshot = {
        id: 'RW-TESTE',
        version: 3,
        metadata: {
            rewardEffects: [
                { type: 'title', titleKey: 'titulo:lobo' },
                { type: 'hook', hookId: 'HK-ABC123' },
            ],
        },
    };
    const getRewardPackage = async (_db, packageId) => {
        assert.strictEqual(packageId, 'RW-TESTE');
        return packageSnapshot;
    };

    const materialized = await materializeRewardPackageEffects(
        {},
        {
            title: 'Conceder pacote',
            targets: [{ kind: 'player', playerId: 'player-1' }],
            actions: [{ type: 'reward.grant', payload: { packageId: 'RW-TESTE' } }],
            metadata: { source: 'test' },
        },
        { getRewardPackage }
    );
    assert.deepStrictEqual(
        materialized.actions.map((action) => action.type),
        ['reward.grant', 'player.title.grant', 'player.hook.assign']
    );
    assert.strictEqual(materialized.actions[1].metadata.rewardPackageEffect, true);
    assert.strictEqual(materialized.actions[2].metadata.effectIndex, 1);
    assert.strictEqual(materialized.metadata.rewardEffectPackageSnapshots.length, 1);
    assert.strictEqual(materialized.metadata.rewardEffectPackageSnapshots[0].packageVersion, 3);

    await assertRewardEffectSnapshotsFresh(
        {},
        { metadata: materialized.metadata },
        { getRewardPackage }
    );

    packageSnapshot = {
        ...packageSnapshot,
        version: 4,
        metadata: {
            rewardEffects: [{ type: 'title', titleKey: 'titulo:outro' }],
        },
    };
    await assert.rejects(
        () => assertRewardEffectSnapshotsFresh(
            {},
            { metadata: materialized.metadata },
            { getRewardPackage }
        ),
        (error) => error?.code === 'reward_effect_package_changed_after_draft'
    );

    const quick = await materializeRewardPackageEffects(
        {},
        {
            actions: [{ type: 'reward.grant', payload: { entries: [{ type: 'ph', amount: 5 }] } }],
        },
        { getRewardPackage: async () => { throw new Error('quick reward must not load package'); } }
    );
    assert.strictEqual(quick.actions.length, 1);
    assert.strictEqual(quick.metadata.rewardEffectPackageSnapshots.length, 0);

    console.log('adminRewardPackageEffects.test.js ok');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
