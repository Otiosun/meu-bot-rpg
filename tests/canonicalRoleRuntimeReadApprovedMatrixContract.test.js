'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');
const {
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

function decisions(report, surface, permission) {
    return report.decisions[surface].filter((entry) => entry.permission === permission);
}

test('Administrador vindo da Central pode assumir a matriz operacional canônica sem crítico', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAdminRole(db, 'admin@lid', 'admin');
    await insertCanonicalRole(db, 'admin@lid', 'admin');

    const permissions = [
        'character.read.profile',
        'squad.manage.members',
        'evaluation.apply',
        'raid.manage',
        'raid.reward.review',
    ];
    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'admin@lid', {
        ownerCheck: () => false,
        permissions,
    });

    assert.equal(report.summary.safeForAdminReader, true);
    assert.equal(report.summary.safeForScopedAccessReader, true);
    assert.equal(report.summary.safeForGenericAccessReader, true);
    assert.equal(report.summary.accessScopedCriticalCount, 0);
    assert.equal(report.summary.accessGenericCriticalCount, 0);

    for (const permission of permissions) {
        for (const entry of decisions(report, 'accessScoped', permission)) {
            assert.equal(entry.legacy, false);
            assert.equal(entry.canonical, true);
            assert.equal(entry.approved, true);
            assert.equal(entry.critical, false);
            assert.match(entry.policyReason, /^approved_admin_access_permission_expansion$/);
        }
        const generic = decisions(report, 'accessGeneric', permission)[0];
        assert.equal(generic.legacy, false);
        assert.equal(generic.canonical, true);
        assert.equal(generic.approved, true);
        assert.equal(generic.critical, false);
    }
});

test('Narrador global mais Capitão mantém leitor escopado seguro e bloqueia apenas achatamento real', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await insertAdminRole(db, 'hybrid@lid', 'narrator');
    await insertAccessRole(db, 'hybrid@lid', 'captain', 'squad', 'alpha');
    await insertCanonicalRole(db, 'hybrid@lid', 'narrator');
    await insertCanonicalRole(db, 'hybrid@lid', 'captain', 'squad', 'alpha');

    const report = await buildCanonicalRoleRuntimeReadShadowReport(db, 'hybrid@lid', {
        ownerCheck: () => false,
        permissions: [
            'character.read.profile',
            'squad.manage.members',
            'raid.manage',
            'raid.view',
            'raid.reward.propose',
        ],
    });

    assert.equal(report.summary.safeForAdminReader, true);
    assert.equal(report.summary.safeForScopedAccessReader, true);
    assert.equal(report.summary.accessScopedCriticalCount, 0);

    assert.equal(report.summary.safeForGenericAccessReader, false);
    assert.equal(report.summary.accessGenericCriticalCount, 1);
    assert.equal(report.summary.genericScopeHardeningCount, 1);
    assert.equal(report.summary.foreignScopeLeakCount, 1);

    const hardening = decisions(report, 'accessGeneric', 'squad.manage.members')[0];
    assert.equal(hardening.classification, 'generic_scope_hardening_required');
    assert.equal(hardening.critical, true);

    for (const permission of [
        'character.read.profile',
        'raid.manage',
        'raid.view',
        'raid.reward.propose',
    ]) {
        const foreign = decisions(report, 'accessScoped', permission)
            .find((entry) => entry.scopeKey === 'beta');
        assert.equal(foreign.canonical, true);
        if (foreign.legacy === false) {
            assert.equal(foreign.approved, true);
            assert.equal(foreign.critical, false);
            if (permission === 'raid.view' || permission === 'raid.reward.propose') {
                assert.match(
                    foreign.policyReason,
                    /^approved_(captain|narrator)_access_permission_expansion$/
                );
            } else {
                assert.match(
                    foreign.policyReason,
                    /^approved_narrator_access_permission_expansion$/
                );
            }
        }
    }
});
