'use strict';

const { CURRENT_SCHEMA_MIGRATIONS } = require('../../helpers/clover/schemaMigrationCatalog');
const { prebootstrapCloverSchemaBeforeLegacy } = require('../../helpers/clover/schemaBasePrebootstrapService');

// Runtime ensure helpers are deliberately DDL-free after Phase 2. Test fixtures
// must establish the formal canonical schema before exercising domain services.
async function prepareCanonicalSchema(db) {
    return prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
}

module.exports = {
    prepareCanonicalSchema,
    prepareCanonicalRaidSchema: prepareCanonicalSchema,
};
