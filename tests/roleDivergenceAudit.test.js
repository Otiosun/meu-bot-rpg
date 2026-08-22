'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditRoleDivergence } = require('../helpers/clover/roleDivergenceAudit');
const { parseDatabasePath } = require('../scripts/auditRoleDivergence');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_role_grants (
            id INTEGER PRIMARY KEY, subject_id TEXT, role_key TEXT, scope_type TEXT, scope_key TEXT,
            status TEXT, valid_from TEXT, valid_until TEXT, granted_by TEXT, grant_reason TEXT,
            origin_type TEXT, origin_ref TEXT, metadata_json TEXT
        );
        CREATE TABLE clover_access_roles (
            id INTEGER PRIMARY KEY, subject_id TEXT, role_key TEXT, scope_type TEXT, scope_key TEXT,
            status TEXT, created_at TEXT, assigned_by TEXT, reason TEXT, metadata_json TEXT
        );
        CREATE TABLE clover_admin_roles (
            player_id TEXT, role TEXT, active INTEGER, granted_by TEXT, granted_at TEXT, updated_at TEXT
        );
        INSERT INTO clover_role_grants VALUES
            (1, 'agree@s.whatsapp.net', 'admin', 'global', '*', 'active', NULL, NULL, 'system', NULL, 'manual', NULL, NULL),
            (2, 'canonical@s.whatsapp.net', 'narrator', 'global', '*', 'active', NULL, NULL, 'system', NULL, 'manual', NULL, NULL),
            (3, 'conflict@s.whatsapp.net', 'captain', 'squad', 'alpha', 'active', NULL, NULL, 'system', NULL, 'manual', NULL, NULL);
        INSERT INTO clover_access_roles VALUES
            (1, 'agree@s.whatsapp.net', 'admin', 'global', '*', 'active', NULL, 'system', NULL, NULL),
            (2, 'legacy@s.whatsapp.net', 'assistant', 'global', '*', 'active', NULL, 'system', NULL, NULL),
            (3, 'conflict@s.whatsapp.net', 'captain', 'squad', 'beta', 'active', NULL, 'system', NULL, NULL);
    `);
    return db;
}

test('role divergence auditor separates persisted grants from external owner configuration', async () => {
    const db = await fixture();
    try {
        const audit = await auditRoleDivergence(db, {
            exampleLimit: 50,
            externalSubjects: ['external@s.whatsapp.net', 'unknown@s.whatsapp.net'],
            ownerCheck(subjectId) {
                if (subjectId === 'external@s.whatsapp.net') return true;
                if (subjectId === 'unknown@s.whatsapp.net') return undefined;
                return false;
            },
        });
        assert.deepEqual(Object.fromEntries(audit.examples.map((row) => [`${row.principal_id}|${row.role_key}`, row.classification])), {
            'agree@s.whatsapp.net|admin': 'AGREE',
            'canonical@s.whatsapp.net|narrator': 'CANONICAL_ONLY',
            'conflict@s.whatsapp.net|captain': 'CONFLICT',
            'external@s.whatsapp.net|owner': 'EXTERNAL_ONLY',
            'legacy@s.whatsapp.net|assistant': 'LEGACY_ONLY',
            'unknown@s.whatsapp.net|owner': 'UNRESOLVED_EXTERNAL',
        });
        assert.equal(audit.principals_checked, 6);
        assert.equal(audit.agreements, 1);
        assert.equal(audit.conflicts, 1);
        assert.equal(audit.safe_to_cutover, false);
    } finally {
        await db.close();
    }
});

test('role divergence CLI requires an explicit database snapshot path', () => {
    assert.throws(() => parseDatabasePath([]), /--db/);
    assert.throws(() => parseDatabasePath(['--db']), /--db/);
});
