const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getMigrationFeatureFlags,
    isMigrationFeatureEnabled,
} = require('../helpers/clover/migrationFeatureFlags');

test('todas as features de migração ficam desligadas por padrão', () => {
    assert.deepEqual(getMigrationFeatureFlags({}), {
        strictCommandOwnership: false,
        sceneEvaluationSafety: false,
        universalEvaluation: false,
        supportQueue: false,
        racialRework: false,
    });
});

test('somente valor literal 1 liga feature', () => {
    const env = {
        CLOVER_UNIVERSAL_EVALUATION: '1',
        CLOVER_SUPPORT_QUEUE: 'true',
    };
    assert.equal(isMigrationFeatureEnabled('universalEvaluation', env), true);
    assert.equal(isMigrationFeatureEnabled('supportQueue', env), false);
});

test('feature desconhecida falha fechado', () => {
    assert.throws(
        () => isMigrationFeatureEnabled('inventada', {}),
        /desconhecida/i
    );
});
