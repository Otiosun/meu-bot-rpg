'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditSquadMembershipDivergence } = require('../helpers/clover/squadMembershipDivergenceAudit');
const { parseDatabasePath } = require('../scripts/auditSquadMembershipDivergence');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, esquadrao TEXT);
        CREATE TABLE clover_squads (squad_key TEXT PRIMARY KEY);
        CREATE TABLE clover_squad_memberships (id INTEGER PRIMARY KEY, player_id TEXT, squad_key TEXT, status TEXT);
        INSERT INTO clover_squads VALUES ('alpha'), ('beta');
        INSERT INTO jogadores VALUES
            ('match@s.whatsapp.net', 'Alpha'),
            ('canonical@s.whatsapp.net', '-'),
            ('legacy@s.whatsapp.net', 'Beta'),
            ('mismatch@s.whatsapp.net', 'Beta'),
            ('duplicate@s.whatsapp.net', 'Alpha'),
            ('invalid-canonical@s.whatsapp.net', '-'),
            ('invalid-legacy@s.whatsapp.net', 'unknown');
        INSERT INTO clover_squad_memberships VALUES
            (1, 'match@s.whatsapp.net', 'alpha', 'active'),
            (2, 'canonical@s.whatsapp.net', 'alpha', 'active'),
            (3, 'mismatch@s.whatsapp.net', 'alpha', 'active'),
            (4, 'duplicate@s.whatsapp.net', 'alpha', 'active'),
            (5, 'duplicate@s.whatsapp.net', 'beta', 'active'),
            (6, 'invalid-canonical@s.whatsapp.net', 'unknown', 'active');
    `);
    return db;
}

test('squad divergence auditor reports every persisted dual-write state deterministically', async () => {
    const db = await fixture();
    try {
        const audit = await auditSquadMembershipDivergence(db, { exampleLimit: 50 });
        assert.deepEqual(Object.fromEntries(audit.examples.map((row) => [row.player_id, row.classification])), {
            'canonical@s.whatsapp.net': 'CANONICAL_ONLY',
            'duplicate@s.whatsapp.net': 'INVALID_CANONICAL',
            'invalid-canonical@s.whatsapp.net': 'INVALID_CANONICAL',
            'invalid-legacy@s.whatsapp.net': 'INVALID_LEGACY',
            'legacy@s.whatsapp.net': 'LEGACY_ONLY',
            'match@s.whatsapp.net': 'MATCH',
            'mismatch@s.whatsapp.net': 'MISMATCH',
        });
        assert.equal(audit.players_checked, 7);
        assert.equal(audit.duplicate_active_memberships, 1);
        assert.equal(audit.unknown_squad_keys, 2);
        assert.equal(audit.safe_to_cutover, false);
    } finally {
        await db.close();
    }
});

test('squad divergence CLI requires an explicit database snapshot path', () => {
    assert.throws(() => parseDatabasePath([]), /--db/);
    assert.throws(() => parseDatabasePath(['--db']), /--db/);
});
