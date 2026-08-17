'use strict';

const {
    inspectCloverMigrationState,
    runCloverSchemaMigrations,
} = require('./schemaMigrationService');
const { CURRENT_SCHEMA_MIGRATIONS } = require('./schemaMigrationCatalog');
const { prebootstrapCloverSchemaBeforeLegacy } = require('./schemaBasePrebootstrapService');

const preparedConnections = new WeakSet();
const preparationPromises = new WeakMap();

function isObjectConnection(db) {
    return db !== null && (typeof db === 'object' || typeof db === 'function');
}

function markLegacySchemaPrepared(db) {
    if (!isObjectConnection(db)) {
        throw new TypeError('Conexão SQLite inválida para marcar schema preparado.');
    }
    preparedConnections.add(db);
    return db;
}

function isLegacySchemaPrepared(db) {
    return isObjectConnection(db) && preparedConnections.has(db);
}

async function prepareLegacySchemaEnsure(db, options = {}) {
    if (!isObjectConnection(db)) {
        throw new TypeError('Conexão SQLite inválida para preparar ensure legacy.');
    }
    if (preparedConnections.has(db)) {
        return { prepared: true, cached: true, mode: 'cached' };
    }

    const pending = preparationPromises.get(db);
    if (pending) return pending;

    const migrations = options.migrations || CURRENT_SCHEMA_MIGRATIONS;
    const task = (async () => {
        const state = await inspectCloverMigrationState(db, { migrations });
        let result;

        if (state.userVersion === 0 && state.applied.length === 0) {
            result = await prebootstrapCloverSchemaBeforeLegacy(db, { migrations });
            result = { ...result, mode: 'transient_prebootstrap' };
        } else {
            const migrated = await runCloverSchemaMigrations(db, { migrations });
            result = { ...migrated, mode: 'formal_migrations' };
        }

        preparedConnections.add(db);
        return { prepared: true, cached: false, ...result };
    })();

    preparationPromises.set(db, task);
    try {
        return await task;
    } finally {
        preparationPromises.delete(db);
    }
}

function createGuardedLegacyEnsure(name, legacyEnsure) {
    if (typeof legacyEnsure !== 'function') {
        throw new TypeError(`Legacy ensure ${name} precisa ser função.`);
    }
    return async function guardedLegacyEnsure(db, ...args) {
        await prepareLegacySchemaEnsure(db);
        return legacyEnsure(db, ...args);
    };
}

function buildGuardedLegacyExports(legacyExports) {
    const result = {};
    for (const [name, value] of Object.entries(legacyExports || {})) {
        result[name] = typeof value === 'function' && /^ensure[A-Z]/.test(name)
            ? createGuardedLegacyEnsure(name, value)
            : value;
    }
    return result;
}

module.exports = {
    buildGuardedLegacyExports,
    createGuardedLegacyEnsure,
    isLegacySchemaPrepared,
    markLegacySchemaPrepared,
    prepareLegacySchemaEnsure,
};
