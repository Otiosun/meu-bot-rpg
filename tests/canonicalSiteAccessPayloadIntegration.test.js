'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureCloverSquadSchema } = require('../database');
const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');
const {
    buildSiteAccessPayload,
} = require('../helpers/clover/siteAccessPayloadService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            patente TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado',
            ficha_status TEXT DEFAULT 'aprovada'
        )
    `);
    await ensureCloverSquadSchema(db);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('alpha', 'Alpha', 10, 4, 0), ('beta', 'Beta', 20, 8, 0)
    `);
    for (const [id, name, squad] of [
        ['captain@lid', 'Capitão', 'Alpha'],
        ['admin@lid', 'Administrador', '-'],
        ['evaluator@lid', 'Avaliador', '-'],
        ['member@lid', 'Membro', 'Alpha'],
    ]) {
        await db.run(
            `INSERT INTO jogadores
             (id, nome, display_name, personagem_nome, esquadrao, patente)
             VALUES (?, ?, ?, ?, ?, 'Cavaleiro Mágico')`,
            [id, name, name, name, squad]
        );
    }
    return db;
}

async function insertCanonicalRole(db, subjectId, roleKey, scopeType = 'global', scopeKey = '*') {
    await ensureCanonicalRoleGrantSchema(db);
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status,
          valid_from, granted_by, origin_type, origin_ref)
         VALUES (?, ?, ?, ?, 'active',
                 '2000-01-01 00:00:00', 'owner@lid', 'fixture', ?)`,
        [subjectId, roleKey, scopeType, scopeKey, `${subjectId}:${roleKey}:${scopeKey}`]
    );
}

test('Capitão canônico recebe capacidade escopada sem permission global achatada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const payload = await buildSiteAccessPayload(db, 'captain@lid');
    assert.equal(payload.accessSource, 'canonical_role_grants');
    assert.deepEqual(payload.roleKeys, ['captain']);
    assert.deepEqual(payload.squadScopes, ['alpha']);
    assert.equal(payload.permissions.includes('squad.manage.members'), false);
    assert.equal(payload.permissions.includes('raid.create'), false);
    assert.equal(payload.capabilities.manageSquadMembers, true);
    assert.equal(payload.capabilities.manageSquadUpgrades, true);
    assert.equal(payload.capabilities.createRaids, true);
    assert.equal(payload.accessibleSquads.length, 1);
    assert.equal(payload.accessibleSquads[0].key, 'alpha');
    assert.equal(payload.accessibleSquads[0].canManageUpgrades, true);
});

test('Admin canônico administra todos os esquadrões sem wildcard no payload', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'admin@lid', 'admin');

    const payload = await buildSiteAccessPayload(db, 'admin@lid');
    assert.equal(payload.accessSource, 'canonical_role_grants');
    assert.equal(payload.capabilities.globalAdministration, true);
    assert.equal(payload.permissions.includes('*'), false);
    assert.equal(payload.permissions.includes('squad.manage.members'), true);
    assert.equal(payload.accessibleSquads.length, 2);
    assert.equal(payload.accessibleSquads.every((squad) => squad.canManageUpgrades), true);
});

test('Avaliador canônico mantém técnica sem acesso a QG', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'evaluator@lid', 'evaluator');

    const payload = await buildSiteAccessPayload(db, 'evaluator@lid');
    assert.equal(payload.accessSource, 'canonical_role_grants');
    assert.equal(payload.capabilities.readTechnicalCapabilities, true);
    assert.equal(payload.capabilities.readTechnicalGrimoires, true);
    assert.equal(payload.capabilities.manageSquadUpgrades, false);
    assert.equal(payload.accessibleSquads.length, 0);
});

test('membro sem grant canônico preserva contexto comum por fallback', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const payload = await buildSiteAccessPayload(db, 'member@lid');
    assert.equal(payload.accessSource, 'legacy_access_fallback');
    assert.deepEqual(payload.roleKeys, []);
    assert.equal(payload.accessibleSquads.length, 1);
    assert.equal(payload.accessibleSquads[0].key, 'alpha');
    assert.equal(payload.accessibleSquads[0].canManageUpgrades, false);
});
