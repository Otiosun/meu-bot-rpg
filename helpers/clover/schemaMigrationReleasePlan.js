'use strict';

const {
    SCENE_EVALUATION_INTEGRITY_MIGRATION,
} = require('./schemaMigrationExtensions');
const {
    SCENE_EVALUATION_ACCOUNTING_MIGRATION,
} = require('./schemaMigrationGate2Accounting');
const {
    UNIVERSAL_EVALUATION_MIGRATION,
} = require('./schemaMigrationGate3Evaluation');
const {
    HUMAN_PROTOTYPE_MIGRATION,
} = require('./schemaMigrationGate4RacialEvaluation');

function publishMigration(source, version, key) {
    if (!source || typeof source.up !== 'function') {
        throw new TypeError(`Migration source invalida para ${key}.`);
    }
    return Object.freeze({
        ...source,
        version,
        key,
    });
}

const SCENE_EVALUATION_INTEGRITY_RELEASE = publishMigration(
    SCENE_EVALUATION_INTEGRITY_MIGRATION,
    55,
    '0055_scene_evaluation_integrity'
);
const SCENE_EVALUATION_ACCOUNTING_RELEASE = publishMigration(
    SCENE_EVALUATION_ACCOUNTING_MIGRATION,
    56,
    '0056_scene_evaluation_void_accounting'
);
const UNIVERSAL_EVALUATION_RELEASE = publishMigration(
    UNIVERSAL_EVALUATION_MIGRATION,
    57,
    '0057_universal_evaluation_queue'
);
const HUMAN_PROTOTYPE_RELEASE = publishMigration(
    HUMAN_PROTOTYPE_MIGRATION,
    58,
    '0058_human_prototype_evaluation'
);

const CLOVER_MULTICOLOR_RELEASE_MIGRATIONS = Object.freeze([
    SCENE_EVALUATION_INTEGRITY_RELEASE,
    SCENE_EVALUATION_ACCOUNTING_RELEASE,
    UNIVERSAL_EVALUATION_RELEASE,
    HUMAN_PROTOTYPE_RELEASE,
]);

module.exports = {
    CLOVER_MULTICOLOR_RELEASE_MIGRATIONS,
    HUMAN_PROTOTYPE_RELEASE,
    SCENE_EVALUATION_ACCOUNTING_RELEASE,
    SCENE_EVALUATION_INTEGRITY_RELEASE,
    UNIVERSAL_EVALUATION_RELEASE,
    publishMigration,
};