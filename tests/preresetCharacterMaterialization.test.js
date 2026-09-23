'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    buildFutureTraitPatch,
    retireLegacySquadMemberships,
    traitPatchMatches,
} = require('../helpers/clover/preresetCharacterMaterialization');

test('materializa aptidao e marca na coluna da raridade correta e preserva anomalia', () => {
    const patch = buildFutureTraitPatch({ traits: {
        aptitude: { key: 'prodigio', name: 'Prodigio', rarity: 'rara' },
        mark: { key: 'passo_quieto', name: 'Passo Quieto', rarity: 'common' },
        anomaly: { key: 'grimorio_amaldicoado', name: 'Grimorio Amaldicoado' },
    } });
    assert.deepEqual(patch, {
        aptidao_comum: '-', aptidao_comum_key: null,
        aptidao_rara: 'Prodigio', aptidao_rara_key: 'prodigio',
        marca_comum: 'Passo Quieto', marca_comum_key: 'passo_quieto',
        marca_rara: '-', marca_rara_key: null,
        anomalia: 'Grimorio Amaldicoado', anomalia_key: 'grimorio_amaldicoado',
    });
    assert.equal(traitPatchMatches(patch, patch), true);
});

test('encerra membership ativo antigo e registra evento', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-membership-'));
    const db = await open({ filename: path.join(dir, 'fixture.sqlite'), driver: sqlite3.Database });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await db.exec(`
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY, squad_key TEXT, player_id TEXT, status TEXT,
            ended_at TEXT, changed_by TEXT, reason TEXT, metadata_json TEXT
        );
        CREATE TABLE clover_squad_membership_events (
            id INTEGER PRIMARY KEY, membership_id INTEGER, squad_key TEXT,
            player_id TEXT, action TEXT, changed_by TEXT, reason TEXT, metadata_json TEXT
        );
        INSERT INTO clover_squad_memberships
        (id,squad_key,player_id,status) VALUES (7,'veu_negro','player@lid','active');
    `);

    const result = await retireLegacySquadMemberships(db, 'player@lid', { actorId: 'admin@test' });
    assert.deepEqual(result, { retired: 1, events: 1 });
    const membership = await db.get('SELECT * FROM clover_squad_memberships WHERE id=7');
    assert.equal(membership.status, 'removed');
    assert.ok(membership.ended_at);
    assert.equal(membership.changed_by, 'admin@test');
    const event = await db.get('SELECT * FROM clover_squad_membership_events');
    assert.equal(event.action, 'removed');
    assert.equal(event.membership_id, 7);
});
