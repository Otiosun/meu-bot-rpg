'use strict';

const {
    CORE_MIGRATIONS,
    addColumnIfMissing,
} = require('./schemaMigrationService');

const MARKET_REQUEST_VERSION = 4;
const MARKET_REQUEST_KEY = '0004_market_request_columns';
const MARKET_REQUEST_TARGETS = Object.freeze([
    Object.freeze({ table: 'clover_market_listings', column: 'idempotency_key', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_weekly_npc_requests', column: 'required_quality', definition: "TEXT NOT NULL DEFAULT 'qualquer'" }),
    Object.freeze({ table: 'clover_weekly_npc_requests', column: 'required_condition', definition: "TEXT NOT NULL DEFAULT 'qualquer'" }),
]);

const MARKET_REQUEST_MIGRATION = Object.freeze(
    {
        version: MARKET_REQUEST_VERSION,
        key: MARKET_REQUEST_KEY,
        description: 'Versiona idempotência de mercado e requisitos semanais de NPC antes da retirada gradual de ensureColumn.',
        checksumMaterial: MARKET_REQUEST_TARGETS,
        async up(db) {
            for (const target of MARKET_REQUEST_TARGETS) {
                await addColumnIfMissing(db, target);
            }
        },
    }
);

const CURRENT_SCHEMA_MIGRATIONS = Object.freeze([
    ...CORE_MIGRATIONS,
    MARKET_REQUEST_MIGRATION,
]);

module.exports = {
    CURRENT_SCHEMA_MIGRATIONS,
    MARKET_REQUEST_KEY,
    MARKET_REQUEST_MIGRATION,
    MARKET_REQUEST_TARGETS,
    MARKET_REQUEST_VERSION,
};
