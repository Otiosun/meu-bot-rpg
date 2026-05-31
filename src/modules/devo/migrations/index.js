const createManagerProfilesAndRecords = require('./001_create_manager_profiles_and_records');
const createDeadlyVoteTables = require('./002_create_deadly_vote_tables');
const createLifeLedgerAndAuditLogs = require('./003_create_life_ledger_and_audit_logs');
const addMissingIndexes = require('./004_add_missing_indexes_and_constraints');

module.exports = [
    createManagerProfilesAndRecords,
    createDeadlyVoteTables,
    createLifeLedgerAndAuditLogs,
    addMissingIndexes,
];
