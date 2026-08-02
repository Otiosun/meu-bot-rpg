'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');
const {
    accessPermissionCatalog,
    adminPermissionCatalog,
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

test('catálogos não misturam capacidades da Central com permissões operacionais', () => {
    const admin = adminPermissionCatalog();
    const access = accessPermissionCatalog();

    assert.ok(admin.includes('operation.view'));
    assert.ok(admin.includes('raid.view'));
    assert.equal(admin.includes('character.read.profile'), false);
    assert.equal(admin.includes('squad.manage.members'), false);

    assert.ok(access.includes('character.read.profile'));
    assert.ok(access.includes('squad.manage.members'));
    assert.ok(access.includes('raid.reward.propose'));
    assert.equal(access.includes('operation.view'), false);
    assert.equal(access.includes('catalog.view'), false);
});

test('capitão revela achatamento genérico, mas preserva decisões escopadas', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAccessRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'captain@lid', {
        ownerCheck: () => false,
        permissions: ['squad.manage.members'],
    });

    assert.equal(report.version, 'clover.canonical-role-runtime-read-shadow.v2');
    assert.deepEqual(report.catalogs.admin, []);
    assert.deepEqual(report.catalogs.access, ['squad.manage.members']);

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

    assert.equal(report.summary.safeForAdminReader, true);
    assert.equal(report.summary.safeForScopedAccessReader, true);
    assert.equal(report.summary.safeForGenericAccessReader, false);
    assert.equal(report.summary.genericScopeHardeningCount, 1);
    assert.equal(report.summary.foreignScopeLeakCount, 1);
    assert.equal(report.summary.safeToSwitchAllRuntimeReaders, false);
});

test('Auxiliar permanece restrito à superfície da Central', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAdminRole(db, 'assistant@lid', 'assistant');
    await insertCanonicalRole(db, 'assistant@lid', 'assistant');

    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'assistant@lid', {
        ownerCheck: () => false,
        permissions: ['operation.view', 'raid.view', 'character.read.profile'],
    });

    assert.equal(decision(report.decisions.admin, 'operation.view').classification, 'equivalent');
    assert.equal(decision(report.decisions.admin, 'raid.view').classification, 'equivalent');
    assert.equal(report.summary.safeForAdminReader, true);

    assert.equal(decision(report.decisions.accessGeneric, 'operation.view'), undefined);
    const accessRaid = decision(report.decisions.accessGeneric, 'raid.view');
    const accessCharacter = decision(report.decisions.accessGeneric, 'character.read.profile');
    assert.equal(accessRaid.legacy, false);
    assert.equal(accessRaid.canonical, false);
    assert.equal(accessRaid.classification, 'equivalent');
    assert.equal(accessCharacter.legacy, false);
    assert.equal(accessCharacter.canonical, false);
    assert.equal(report.summary.safeForGenericAccessReader, true);
    assert.equal(report.summary.safeForScopedAccessReader, true);
});

test('Avaliador coincide no acesso, mas mudança da Central continua bloqueada', async (t) => {
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
    assert.equal(decision(report.decisions.admin, 'character.read.profile'), undefined);
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
    assert.equal(decision(report.decisions.accessGeneric, 'operation.view'), undefined);
    assert.equal(report.summary.safeForGenericAccessReader, true);
    assert.equal(report.summary.safeForScopedAccessReader, true);
});

test('expansões aprovadas de Narrador e Capitão não viram falso crítico', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAccessRole(db, 'narrator@lid', 'narrator');
    await insertCanonicalRole(db, 'narrator@lid', 'narrator');
    await insertAccessRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const narrator = await buildCanonicalRoleRuntimeReadShadowReport(db, 'narrator@lid', {
        ownerCheck: () => false,
        permissions: ['raid.view', 'raid.reward.propose'],
    });
    for (const permission of ['raid.view', 'raid.reward.propose']) {
        const entry = decision(narrator.decisions.accessGeneric, permission);
        assert.equal(entry.legacy, false);
        assert.equal(entry.canonical, true);
        assert.equal(entry.approved, true);
        assert.equal(entry.critical, false);
    }

    const captain = await buildCanonicalRoleRuntimeReadShadowReport(db, 'captain@lid', {
        ownerCheck: () => false,
        permissions: ['raid.view', 'raid.reward.propose'],
    });
    for (const permission of ['raid.view', 'raid.reward.propose']) {
        const own = decision(captain.decisions.accessScoped, permission, 'alpha');
        assert.equal(own.legacy, false);
        assert.equal(own.canonical, true);
        assert.equal(own.approved, true);
        assert.equal(own.critical, false);
    }
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

test('batch agrega apenas riscos reais de cada superfície', async (t) => {
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

    assert.equal(batch.version, 'clover.canonical-role-runtime-read-shadow-batch.v2');
    assert.equal(batch.write, false);
    assert.equal(batch.queryOnlySafe, true);
    assert.equal(batch.enforcementChanged, false);
    assert.equal(batch.subjectCount, 2);
    assert.equal(batch.safeForAdminReaderCount, 2);
    assert.equal(batch.safeForScopedAccessReaderCount, 2);
    assert.equal(batch.safeForGenericAccessReaderCount, 1);
    assert.equal(batch.safeToSwitchAllRuntimeReadersCount, 1);
    assert.equal(batch.adminCriticalCount, 0);
    assert.equal(batch.accessScopedCriticalCount, 0);
    assert.ok(batch.genericScopeHardeningCount >= 1);
    assert.ok(batch.foreignScopeLeakCount >= 1);
    assert.ok(batch.accessGenericCriticalCount >= 1);
});
