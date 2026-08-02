'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');
const {
    buildCanonicalRoleRuntimeReadShadowBatch,
    buildCanonicalRoleRuntimeReadShadowReport,
} = require('../helpers/clover/canonicalRoleRuntimeReadShadowService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE clover_admin_roles (
            player_id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            granted_by TEXT NOT NULL,
            granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_by TEXT DEFAULT NULL,
            revoked_at TEXT DEFAULT NULL
        );

        CREATE TABLE clover_access_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL DEFAULT '*',
            status TEXT NOT NULL DEFAULT 'active',
            assigned_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_at TEXT DEFAULT NULL,
            revoked_by TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );

        INSERT INTO clover_squads (squad_key, name)
        VALUES ('alpha', 'Alpha'), ('beta', 'Beta');
    `);
    await ensureCanonicalRoleGrantSchema(db);
    return db;
}

async function insertAdminRole(db, subjectId, roleKey) {
    await db.run(
        `INSERT INTO clover_admin_roles
         (player_id, role, active, granted_by)
         VALUES (?, ?, 1, 'owner@lid')`,
        [subjectId, roleKey]
    );
}

async function insertAccessRole(db, subjectId, roleKey, scopeType = 'global', scopeKey = '*') {
    await db.run(
        `INSERT INTO clover_access_roles
         (subject_id, role_key, scope_type, scope_key, status, assigned_by)
         VALUES (?, ?, ?, ?, 'active', 'owner@lid')`,
        [subjectId, roleKey, scopeType, scopeKey]
    );
}

async function insertCanonicalRole(db, subjectId, roleKey, scopeType = 'global', scopeKey = '*') {
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status,
          granted_by, origin_type, origin_ref)
         VALUES (?, ?, ?, ?, 'active', 'owner@lid', 'fixture', ?)`,
        [subjectId, roleKey, scopeType, scopeKey, `${subjectId}:${roleKey}:${scopeKey}`]
    );
}

function decision(list, permission, scopeKey = undefined) {
    return list.find((entry) => (
        entry.permission === permission
        && (scopeKey === undefined || entry.scopeKey === scopeKey)
    ));
}

test('capitão revela achatamento genérico, mas preserva decisões escopadas', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAccessRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'captain@lid', {
        ownerCheck: () => false,
        permissions: ['squad.manage.members'],
    });

    const generic = decision(report.decisions.accessGeneric, 'squad.manage.members');
    assert.equal(generic.legacy, true);
    assert.equal(generic.canonical, false);
    assert.equal(generic.classification, 'generic_scope_hardening_required');
    assert.equal(generic.critical, true);

    const ownScope = decision(report.decisions.accessScoped, 'squad.manage.members', 'alpha');
    assert.equal(ownScope.legacy, true);
    assert.equal(ownScope.canonical, true);
    assert.equal(ownScope.classification, 'equivalent');

    const foreignScope = decision(report.decisions.accessScoped, 'squad.manage.members', 'beta');
    assert.equal(foreignScope.legacy, false);
    assert.equal(foreignScope.canonical, false);
    assert.equal(foreignScope.foreignScopeLeak, true);

    assert.equal(report.summary.safeForScopedAccessReader, true);
    assert.equal(report.summary.safeForGenericAccessReader, false);
    assert.equal(report.summary.genericScopeHardeningCount, 1);
    assert.equal(report.summary.foreignScopeLeakCount, 1);
    assert.equal(report.summary.safeToSwitchAllRuntimeReaders, false);
});

test('Auxiliar é equivalente na Central, mas expansão não aprovada no leitor operacional', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAdminRole(db, 'assistant@lid', 'assistant');
    await insertCanonicalRole(db, 'assistant@lid', 'assistant');

    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'assistant@lid', {
        ownerCheck: () => false,
        permissions: ['operation.view', 'raid.view'],
    });

    assert.equal(decision(report.decisions.admin, 'operation.view').classification, 'equivalent');
    assert.equal(decision(report.decisions.admin, 'raid.view').classification, 'equivalent');
    assert.equal(report.summary.safeForAdminReader, true);

    const accessOperation = decision(report.decisions.accessGeneric, 'operation.view');
    const accessRaid = decision(report.decisions.accessGeneric, 'raid.view');
    assert.equal(accessOperation.legacy, false);
    assert.equal(accessOperation.canonical, true);
    assert.equal(accessOperation.classification, 'unapproved_access_generic_expansion');
    assert.equal(accessOperation.critical, true);
    assert.equal(accessRaid.classification, 'unapproved_access_generic_expansion');
    assert.equal(report.summary.accessGenericCriticalCount, 2);
    assert.equal(report.summary.safeForGenericAccessReader, false);
});

test('Avaliador coincide no acesso escopado, mas não na superfície antiga da Central', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAdminRole(db, 'evaluator@lid', 'evaluator');
    await insertAccessRole(db, 'evaluator@lid', 'evaluator');
    await insertCanonicalRole(db, 'evaluator@lid', 'evaluator');

    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'evaluator@lid', {
        ownerCheck: () => false,
        permissions: [
            'operation.view',
            'character.read.profile',
            'evaluation.apply',
            'raid.reward.review',
        ],
    });

    assert.equal(decision(report.decisions.admin, 'operation.view').legacy, true);
    assert.equal(decision(report.decisions.admin, 'operation.view').canonical, false);
    assert.equal(decision(report.decisions.admin, 'operation.view').critical, true);
    assert.equal(decision(report.decisions.admin, 'character.read.profile').legacy, false);
    assert.equal(decision(report.decisions.admin, 'character.read.profile').canonical, true);
    assert.equal(decision(report.decisions.admin, 'character.read.profile').critical, true);
    assert.equal(report.summary.safeForAdminReader, false);

    for (const permission of [
        'character.read.profile',
        'evaluation.apply',
        'raid.reward.review',
    ]) {
        const generic = decision(report.decisions.accessGeneric, permission);
        assert.equal(generic.legacy, true);
        assert.equal(generic.canonical, true);
        assert.equal(generic.classification, 'equivalent');
    }
    assert.equal(decision(report.decisions.accessGeneric, 'operation.view').classification, 'equivalent');
    assert.equal(report.summary.safeForGenericAccessReader, true);
    assert.equal(report.summary.safeForScopedAccessReader, true);
});

test('shadow completo funciona com run e exec proibidos', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAdminRole(db, 'admin@lid', 'admin');
    await insertAccessRole(db, 'admin@lid', 'admin');
    await insertCanonicalRole(db, 'admin@lid', 'admin');

    const readOnly = {
        get: (...args) => db.get(...args),
        all: (...args) => db.all(...args),
        run: async () => { throw new Error('run forbidden'); },
        exec: async () => { throw new Error('exec forbidden'); },
    };

    const report = await buildCanonicalRoleRuntimeReadShadowReport(readOnly, 'admin@lid', {
        ownerCheck: () => false,
        permissions: ['operation.view', 'raid.reward.review'],
    });

    assert.equal(report.write, false);
    assert.equal(report.queryOnlySafe, true);
    assert.equal(report.enforcementChanged, false);
    assert.equal(report.subjectId, 'admin@lid');
});

test('batch agrega riscos por superfície sem declarar troca de enforcement', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAccessRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await insertAdminRole(db, 'assistant@lid', 'assistant');
    await insertCanonicalRole(db, 'assistant@lid', 'assistant');

    const batch = await buildCanonicalRoleRuntimeReadShadowBatch(db, {
        ownerCheck: () => false,
        permissions: ['squad.manage.members', 'operation.view'],
    });

    assert.equal(batch.write, false);
    assert.equal(batch.queryOnlySafe, true);
    assert.equal(batch.enforcementChanged, false);
    assert.equal(batch.subjectCount, 2);
    assert.equal(batch.safeToSwitchAllRuntimeReadersCount, 0);
    assert.ok(batch.genericScopeHardeningCount >= 1);
    assert.ok(batch.foreignScopeLeakCount >= 1);
    assert.ok(batch.accessGenericCriticalCount >= 1);
});
