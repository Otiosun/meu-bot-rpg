'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { ensureCanonicalRoleGrantSchema } = require('../helpers/clover/canonicalRoleGrantSchema');
const {
    readCanonicalGrantsReadOnly,
} = require('../helpers/clover/canonicalRoleShadowReadOnly');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureCanonicalRoleGrantSchema(db);
    await db.exec(`
        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        )
    `);
    return db;
}

async function grant(db, subjectId, roleKey, scopeType, scopeKey) {
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status, granted_by,
          origin_type, valid_from)
         VALUES (?, ?, ?, ?, 'active', 'owner@test', 'test', CURRENT_TIMESTAMP)`,
        [subjectId, roleKey, scopeType, scopeKey]
    );
}

test('canonical login inherits only scoped captain/vice grants from explicit identity alias', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const canonical = '5511999999999@s.whatsapp.net';
    const oldLid = '123456789@lid';
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'lid', ?, 1)`,
        [canonical, oldLid]
    );
    await grant(db, canonical, 'evaluator', 'global', '*');
    await grant(db, oldLid, 'captain', 'squad', 'asas_da_liberdade');
    await grant(db, oldLid, 'vice_captain', 'squad', 'asas_da_liberdade');
    await grant(db, oldLid, 'admin', 'global', '*');
    await grant(db, oldLid, 'narrator', 'global', '*');

    const grants = await readCanonicalGrantsReadOnly(db, { subjectId: canonical });
    const roles = grants.map((item) => `${item.roleKey}:${item.scopeType}:${item.scopeKey}`).sort();

    assert.deepEqual(roles, [
        'captain:squad:asas_da_liberdade',
        'evaluator:global:*',
        'vice_captain:squad:asas_da_liberdade',
    ]);
    assert.equal(grants.some((item) => item.roleKey === 'admin'), false);
    assert.equal(grants.some((item) => item.roleKey === 'narrator'), false);
});

test('login by explicit alias can see scoped leadership grant stored on canonical destination', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const canonical = '5511888888888@s.whatsapp.net';
    const loginAlias = '987654321@lid';
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'lid', ?, 1)`,
        [canonical, loginAlias]
    );
    await grant(db, canonical, 'captain', 'squad', 'kings_of_sun');
    await grant(db, canonical, 'admin', 'global', '*');

    const grants = await readCanonicalGrantsReadOnly(db, { subjectId: loginAlias });
    assert.equal(grants.some((item) => item.roleKey === 'captain' && item.scopeKey === 'kings_of_sun'), true);
    assert.equal(grants.some((item) => item.roleKey === 'admin'), false);
});

test('inactive and name-only aliases never expand authorization', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const canonical = '5511777777777@s.whatsapp.net';
    const alias = '111111111@lid';
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'lid', ?, 0)`,
        [canonical, alias]
    );
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'character', 'capitao curto', 1)`,
        [canonical]
    );
    await grant(db, alias, 'captain', 'squad', 'lobos_cinzentos');

    const grants = await readCanonicalGrantsReadOnly(db, { subjectId: canonical });
    assert.equal(grants.length, 0);
});
