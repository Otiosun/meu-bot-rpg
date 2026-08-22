'use strict';

const DDL_PATTERN = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/gi;

function countDdl(source) {
    return [...String(source || '').matchAll(DDL_PATTERN)].length;
}

function analyzeSqliteRuntimeStartup({ connectionSource, databaseSource, legacySource }) {
    const connectionDdl = countDdl(connectionSource);
    const databaseDdl = countDdl(databaseSource);
    const legacyDdl = countDdl(legacySource);
    return Object.freeze({
        physicalConnectionMutatesSchema: connectionDdl > 0,
        databaseOrchestratorMutatesSchema: databaseDdl > 0,
        legacyRuntimeDdlInventory: legacyDdl,
        status: connectionDdl === 0 && databaseDdl === 0 ? 'physical_configuration_schema_noop' : 'physical_configuration_schema_mutation',
    });
}

function assertSqlitePhysicalStartupNoSchemaMutation(sources) {
    const audit = analyzeSqliteRuntimeStartup(sources);
    if (audit.physicalConnectionMutatesSchema || audit.databaseOrchestratorMutatesSchema) {
        const error = new Error('Configuracao fisica SQLite nao pode criar ou alterar schema.');
        error.code = 'sqlite_physical_startup_schema_mutation';
        error.audit = audit;
        throw error;
    }
    return audit;
}

module.exports = {
    analyzeSqliteRuntimeStartup,
    assertSqlitePhysicalStartupNoSchemaMutation,
    countDdl,
};
