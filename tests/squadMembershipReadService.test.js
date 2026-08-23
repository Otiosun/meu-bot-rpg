'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    SquadMembershipReadError,
    listEffectiveSquadMembers,
    resolvePlayerSquadMembership,
} = require('../helpers/clover/squadMembershipReadService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            personagem_nome TEXT,
            display_name TEXT,
            esquadrao TEXT,
            estrelas INTEGER DEFAULT 0,
            ficha_status TEXT,
            jogo_status TEXT,
            patente TEXT
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT
        );

        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO clover_squads (squad_key, name) VALUES
            ('novos', 'Novos'),
            ('antigos', 'Antigos'),
            ('terceiros', 'Terceiros');
    `);
    return db;
}

async function addPlayer(db, id, squad = null, name = null) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status, patente)
         VALUES (?, ?, ?, ?, ?, 0, 'validada', 'liberado', NULL)`,
        [id, name || id, name || id, name || id, squad]
    );
}

async function addMembership(db, playerId, squadKey, status = 'active') {
    return db.run(
        `INSERT INTO clover_squad_memberships (player_id, squad_key, status)
         VALUES (?, ?, ?)`,
        [playerId, squadKey, status]
    );
}

test('canonical active membership overrides conflicting legacy projection', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addPlayer(db, 'p1@lid', 'Antigos', 'P1');
    await addMembership(db, 'p1@lid', 'novos');

    const result = await resolvePlayerSquadMembership(db, 'p1@lid');

    assert.equal(result.ok, true);
    assert.equal(result.code, 'canonical');
    assert.equal(result.source, 'canonical');
    assert.equal(result.squadKey, 'novos');
    assert.equal(result.legacySquadKey, 'antigos');
    assert.equal(result.canonicalSquadKey, 'novos');
    assert.equal(result.mismatch, true);
});

test('legacy projection never becomes an effective membership when canonical membership is absent', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addPlayer(db, 'legacy@lid', 'Antigos', 'Legacy');

    const result = await resolvePlayerSquadMembership(db, 'legacy@lid');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no_squad');
    assert.equal(result.squadKey, null);
});

test('multiple active canonical memberships fail closed for resolve and list', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addPlayer(db, 'conflict@lid', 'Antigos', 'Conflict');
    await addMembership(db, 'conflict@lid', 'novos');
    await addMembership(db, 'conflict@lid', 'antigos');

    const resolved = await resolvePlayerSquadMembership(db, 'conflict@lid');
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'multiple_active_memberships');
    assert.equal(resolved.source, 'canonical_conflict');
    assert.equal(resolved.membershipIds.length, 2);

    await assert.rejects(
        () => listEffectiveSquadMembers(db, 'novos'),
        (error) => (
            error instanceof SquadMembershipReadError
            && error.code === 'multiple_active_memberships'
        )
    );
});

test('inactive canonical membership does not reactivate a legacy projection', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addPlayer(db, 'inactive@lid', 'Antigos', 'Inactive');
    await addMembership(db, 'inactive@lid', 'novos', 'inactive');

    const result = await resolvePlayerSquadMembership(db, 'inactive@lid');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no_squad');
    assert.equal(result.squadKey, null);
});

test('phone and WhatsApp JID forms resolve the same canonical membership', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const jid = '5511999999999@s.whatsapp.net';
    const phone = '5511999999999';

    await addPlayer(db, jid, 'Antigos', 'Equivalent');
    await addMembership(db, phone, 'novos');

    const result = await resolvePlayerSquadMembership(db, jid);
    assert.equal(result.ok, true);
    assert.equal(result.code, 'canonical');
    assert.equal(result.squadKey, 'novos');
    assert.equal(result.identityEquivalent, true);
    assert.equal(result.membershipPlayerId, phone);
});

test('effective squad listing honors canonical membership and never leaks stale legacy squad', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addPlayer(db, 'p1@lid', 'Antigos', 'Canonical New');
    await addMembership(db, 'p1@lid', 'novos');

    await addPlayer(db, 'p2@lid', 'Novos', 'Legacy New');
    await addMembership(db, 'p2@lid', 'novos');

    await addPlayer(db, 'p3@lid', 'Novos', 'Canonical Old');
    await addMembership(db, 'p3@lid', 'antigos');

    const novos = await listEffectiveSquadMembers(db, 'novos');
    assert.equal(novos.ok, true);

    const novosIds = novos.members.map((row) => row.id).sort();
    assert.deepEqual(novosIds, ['p1@lid', 'p2@lid']);
    assert.equal(
        novos.members.find((row) => row.id === 'p1@lid').membership_source,
        'canonical'
    );
    assert.equal(
        novos.members.find((row) => row.id === 'p1@lid').membership_mismatch,
        true
    );
    assert.equal(
        novos.members.find((row) => row.id === 'p2@lid').membership_source,
        'canonical'
    );

    const antigos = await listEffectiveSquadMembers(db, 'antigos');
    const antigosIds = antigos.members.map((row) => row.id).sort();
    assert.deepEqual(antigosIds, ['p3@lid']);
    assert.equal(
        antigos.members.find((row) => row.id === 'p3@lid').membership_source,
        'canonical'
    );
});

test('all six production consumers use the canonical membership reader', () => {
    const root = path.resolve(__dirname, '..');
    const contracts = new Map([
        ['helpers/clover/accessIntegrationService.js', ['squadMembershipReadService', 'resolvePlayerSquadMembership']],
        ['helpers/clover/cavalierService.js', ['squadMembershipReadService', 'resolvePlayerSquadMembership']],
        ['helpers/clover/siteSquadMemberService.js', ['squadMembershipReadService', 'listEffectiveSquadMembers']],
        ['helpers/clover/siteSquadOperationsService.js', ['squadMembershipReadService', 'listEffectiveSquadMembers']],
        ['helpers/clover/squadService.js', ['squadMembershipReadService', 'listEffectiveSquadMembers']],
        ['helpers/clover/squadStateService.js', ['squadMembershipReadService', 'listEffectiveSquadMembers', 'resolvePlayerSquadMembership']],
    ]);

    for (const [rel, needles] of contracts) {
        const source = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
        for (const needle of needles) {
            assert.equal(
                source.includes(needle),
                true,
                `${rel} must contain ${needle}`
            );
        }
    }
});
