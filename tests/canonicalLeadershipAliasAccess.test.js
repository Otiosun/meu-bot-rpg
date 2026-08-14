'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { ensureCanonicalRoleGrantSchema } = require('../helpers/clover/canonicalRoleGrantSchema');
const {
    getCanonicalScopedAccessContext,
} = require('../helpers/clover/canonicalScopedAccessService');
const {
    equivalentPlayerIds,
} = require('../helpers/clover/playerIdentityEquivalenceService');

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

test('explicit identity alias makes captain grant visible to canonical login', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const canonical = '5511999999999@s.whatsapp.net';
    const alias = '123456789@lid';
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'lid', ?, 1)`,
        [canonical, alias]
    );
    await grant(db, alias, 'captain', 'squad', 'asas_da_liberdade');

    const ids = await equivalentPlayerIds(db, canonical);
    assert.ok(ids.includes(canonical));
    assert.ok(ids.includes(alias));

    const context = await getCanonicalScopedAccessContext(db, canonical, {
        ownerCheck: () => false,
    });
    assert.equal(
        context.assignments.some((item) => (
            item.role_key === 'captain'
            && item.scope_type === 'squad'
            && item.scope_key === 'asas_da_liberdade'
        )),
        true
    );
});

test('alias expansion does not import unrelated global grants', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const canonical = '5511999999999@s.whatsapp.net';
    const alias = '123456789@lid';
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'lid', ?, 1)`,
        [canonical, alias]
    );
    await grant(db, canonical, 'evaluator', 'global', '*');
    await grant(db, alias, 'captain', 'squad', 'asas_da_liberdade');
    await grant(db, alias, 'vice_captain', 'squad', 'asas_da_liberdade');
    await grant(db, alias, 'admin', 'global', '*');
    await grant(db, alias, 'narrator', 'global', '*');

    const context = await getCanonicalScopedAccessContext(db, canonical, {
        ownerCheck: () => false,
    });
    const roles = context.assignments
        .map((item) => `${item.role_key}:${item.scope_type}:${item.scope_key}`)
        .sort();

    assert.deepEqual(roles, [
        'captain:squad:asas_da_liberdade',
        'evaluator:global:*',
        'vice_captain:squad:asas_da_liberdade',
    ]);
    assert.equal(context.assignments.some((item) => item.role_key === 'admin'), false);
    assert.equal(context.assignments.some((item) => item.role_key === 'narrator'), false);
});

test('login through explicit alias can see scoped leadership stored on canonical destination', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const canonical = '5511888888888@s.whatsapp.net';
    const alias = '987654321@lid';
    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, active)
         VALUES (?, 'lid', ?, 1)`,
        [canonical, alias]
    );
    await grant(db, canonical, 'captain', 'squad', 'kings_of_sun');
    await grant(db, canonical, 'admin', 'global', '*');

    const context = await getCanonicalScopedAccessContext(db, alias, {
        ownerCheck: () => false,
    });
    assert.equal(
        context.assignments.some((item) => (
            item.role_key === 'captain'
            && item.scope_key === 'kings_of_sun'
        )),
        true
    );
    assert.equal(context.assignments.some((item) => item.role_key === 'admin'), false);
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

    const ids = await equivalentPlayerIds(db, canonical);
    assert.deepEqual(ids, [canonical]);
    const context = await getCanonicalScopedAccessContext(db, canonical, {
        ownerCheck: () => false,
    });
    assert.equal(context.assignments.length, 0);
});
