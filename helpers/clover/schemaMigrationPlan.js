'use strict';

const { SCHEMA_MIGRATIONS } = require('./schemaMigrationCatalog');
const { PRE_RESET_TRANSITION_MIGRATION } = require('./preResetTransitionMigration');
const { PRE_RESET_CAMPAIGN_MIGRATION } = require('./preResetCampaignMigration');

module.exports = {
    ...require('./schemaMigrationCatalog'),
    SCHEMA_MIGRATIONS: Object.freeze([
        ...SCHEMA_MIGRATIONS,
        PRE_RESET_TRANSITION_MIGRATION,
        PRE_RESET_CAMPAIGN_MIGRATION,
    ]),
};
