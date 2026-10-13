'use strict';

// Populated only from the read-only ledger of the canonical local runtime.
// Each entry must pin version + migration_key + checksum. Never infer or
// synthesize historical checksums from branch names or approximate code.
const LIVE_SCHEMA_HISTORY_ATTESTATIONS = Object.freeze([]);

module.exports = {
    LIVE_SCHEMA_HISTORY_ATTESTATIONS,
};
