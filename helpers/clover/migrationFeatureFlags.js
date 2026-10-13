'use strict';

const FLAG_ENV = Object.freeze({
    strictCommandOwnership: 'CLOVER_STRICT_COMMAND_OWNERSHIP',
    sceneEvaluationSafety: 'CLOVER_SCENE_EVALUATION_SAFETY_V2',
    universalEvaluation: 'CLOVER_UNIVERSAL_EVALUATION',
    supportQueue: 'CLOVER_SUPPORT_QUEUE',
    racialRework: 'CLOVER_RACIAL_REWORK',
});

function envFlagEnabled(value) {
    return String(value ?? '').trim() === '1';
}

function isMigrationFeatureEnabled(name, env = process.env) {
    const envName = FLAG_ENV[name];
    if (!envName) {
        throw new Error(`Feature flag de migração desconhecida: ${name}`);
    }
    return envFlagEnabled(env?.[envName]);
}

function getMigrationFeatureFlags(env = process.env) {
    return Object.fromEntries(
        Object.keys(FLAG_ENV).map((name) => [name, isMigrationFeatureEnabled(name, env)])
    );
}

module.exports = {
    FLAG_ENV,
    envFlagEnabled,
    getMigrationFeatureFlags,
    isMigrationFeatureEnabled,
};
