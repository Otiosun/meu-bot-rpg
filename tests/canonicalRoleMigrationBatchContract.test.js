'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const service = require('../helpers/clover/canonicalRoleMigrationBatchService');
const migrateRunner = require('../scripts/migrateCanonicalRoles');
const rollbackRunner = require('../scripts/rollbackCanonicalRoleMigration');

const SUBJECTS = ['admin@lid', 'captain@lid', 'dual@lid', 'evaluator@lid'];

function shadowReport(overrides = {}) {
    const reports = SUBJECTS.map((subjectId) => ({
        subjectId,
        summary: {
            critical: false,
            unapprovedCanonicalExpansionCount: 0,
            unapprovedCanonicalRegressionCount: 0,
            scopeLeakCount: 0,
        },
    }));
    return {
        version: 'clover.canonical-role-shadow-audit.v1',
        generatedAt: '2026-08-01T00:15:04.000Z',
        write: false,
        queryOnlySafe: true,
        database: {
            sha256: 'db-hash',
            unchanged: true,
        },
        auditor: {
            expectedSha: 'abc123',
            expectedMatch: true,
        },
        filters: {
            subjectIds: [],
            scopeKeys: [],
            referenceDate: '2026-08-01T00:15:04.000Z',
        },
        result: {
            subjectCount: reports.length,
            divergentCount: reports.length,
            criticalCount: 0,
            approvedPolicyExpansionCount: 12,
            approvedPolicyRestrictionCount: 1,
            unapprovedCanonicalExpansionCount: 0,
            unapprovedCanonicalRegressionCount: 0,
            scopeLeakCount: 0,
            reports,
        },
        ...overrides,
    };
}

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE clover_admin_roles (
            player_id TEXT NOT NULL,
            role TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            granted_by TEXT DEFAULT NULL,
            granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_access_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            assigned_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO clover_admin_roles
            (player_id, role, active, granted_by)
        VALUES
            ('admin@lid', 'admin', 1, 'owner@lid'),
            ('dual@lid', 'admin', 1, 'owner@lid');
        INSERT INTO clover_access_roles
            (subject_id, role_key, scope_type, scope_key, status, assigned_by, reason)
        VALUES
            ('evaluator@lid', 'evaluator', 'global', '*', 'active', 'owner@lid', 'fixture'),
            ('captain@lid', 'captain', 'squad', 'lobos', 'active', 'owner@lid', 'fixture'),
            ('dual@lid', 'admin', 'global', '*', 'active', 'owner@lid', 'fixture');
    `);
    return db;
}

test('evidência aceita apenas shadow integral sem críticos não aprovados', () => {
    const evidence = service.validateShadowEvidence(shadowReport(), 'db-hash');
    assert.equal(evidence.subjectCount, 4);
    assert.deepEqual(evidence.subjectIds, SUBJECTS);
    assert.equal(evidence.approvedPolicyExpansionCount, 12);

    const filtered = shadowReport();
    filtered.filters.subjectIds = ['admin@lid'];
    assert.throws(
        () => service.validateShadowEvidence(filtered, 'db-hash'),
        (error) => error?.code === 'unsafe_role_shadow_evidence'
            && error.details.errors.includes('shadow_subject_filter_not_allowed')
    );

    const critical = shadowReport();
    critical.result.criticalCount = 1;
    assert.throws(
        () => service.validateShadowEvidence(critical, 'db-hash'),
        (error) => error?.code === 'unsafe_role_shadow_evidence'
            && error.details.errors.includes('shadow_contains_critical_subjects')
    );
});

test('planejamento read-only não cria schema e deduplica fontes equivalentes', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const evidence = service.validateShadowEvidence(shadowReport(), 'db-hash');
    const readOnly = {
        get: (...args) => db.get(...args),
        all: (...args) => db.all(...args),
        run: async () => { throw new Error('run forbidden'); },
        exec: async () => { throw new Error('exec forbidden'); },
    };
    const plan = await service.buildCanonicalRoleMigrationPlan(readOnly, evidence);
    assert.equal(plan.write, false);
    assert.equal(plan.safe, true);
    assert.equal(plan.legacyCount, 5);
    assert.equal(plan.plannedCount, 4);
    assert.deepEqual(plan.planned.map((item) => item.identity), [
        'admin@lid|admin|global|*',
        'captain@lid|captain|squad|lobos',
        'dual@lid|admin|global|*',
        'evaluator@lid|evaluator|global|*',
    ]);
    const dual = plan.planned.find((item) => item.subjectId === 'dual@lid');
    assert.equal(dual.origins.length, 2);
    assert.equal(dual.originType, 'legacy_role_union');
    assert.equal(await service.tableExists(db, 'clover_role_grants'), false);
});

test('cargo fora dos sujeitos do shadow bloqueia o plano', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_admin_roles (player_id, role, active)
         VALUES ('unexpected@lid', 'assistant', 1)`
    );
    const evidence = service.validateShadowEvidence(shadowReport(), 'db-hash');
    await assert.rejects(
        () => service.buildCanonicalRoleMigrationPlan(db, evidence),
        (error) => error?.code === 'migration_subject_missing_from_shadow'
            && error.details.subjectId === 'unexpected@lid'
    );
});

test('apply cria lote, grants e eventos em uma transação; rollback revoga o lote', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const evidence = service.validateShadowEvidence(shadowReport(), 'db-hash');
    const plan = await service.buildCanonicalRoleMigrationPlan(db, evidence);
    const applied = await service.applyCanonicalRoleMigrationPlan(db, plan, {
        actor: 'owner@lid',
        reason: 'Migração canônica validada pelo shadow integral',
        shadowReportSha256: 'a'.repeat(64),
        shadowSubjectIds: evidence.subjectIds,
    });
    assert.equal(applied.insertedCount, 4);
    assert.equal(applied.plannedCount, 4);

    const active = await db.all(
        `SELECT subject_id, role_key, scope_type, scope_key, status
         FROM clover_role_grants
         ORDER BY subject_id`
    );
    assert.equal(active.length, 4);
    assert.equal(active.every((row) => row.status === 'active'), true);
    const batch = await db.get('SELECT * FROM clover_role_migration_batches WHERE id = ?', [applied.batchId]);
    assert.equal(batch.status, 'applied');
    assert.equal(batch.inserted_count, 4);
    const links = await db.all('SELECT * FROM clover_role_migration_batch_grants WHERE batch_id = ?', [applied.batchId]);
    assert.equal(links.length, 4);
    const grantedEvents = await db.all("SELECT * FROM clover_role_grant_events WHERE action = 'granted'");
    assert.equal(grantedEvents.length, 4);

    const rollbackPlan = await service.buildCanonicalRoleRollbackPlan(db, applied.batchId);
    assert.equal(rollbackPlan.safe, true);
    assert.equal(rollbackPlan.grantCount, 4);
    const rolledBack = await service.rollbackCanonicalRoleMigrationBatch(db, rollbackPlan, {
        actor: 'owner@lid',
        reason: 'Rollback controlado da simulação canônica',
    });
    assert.equal(rolledBack.revokedCount, 4);
    const revoked = await db.all('SELECT status FROM clover_role_grants ORDER BY id');
    assert.equal(revoked.every((row) => row.status === 'revoked'), true);
    const updatedBatch = await db.get('SELECT status FROM clover_role_migration_batches WHERE id = ?', [applied.batchId]);
    assert.equal(updatedBatch.status, 'rolled_back');
    const revokedEvents = await db.all("SELECT * FROM clover_role_grant_events WHERE action = 'revoked'");
    assert.equal(revokedEvents.length, 4);
});

test('grant alterado depois do apply impede rollback', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const evidence = service.validateShadowEvidence(shadowReport(), 'db-hash');
    const plan = await service.buildCanonicalRoleMigrationPlan(db, evidence);
    const applied = await service.applyCanonicalRoleMigrationPlan(db, plan, {
        actor: 'owner@lid',
        reason: 'Migração canônica validada pelo shadow integral',
        shadowReportSha256: 'b'.repeat(64),
        shadowSubjectIds: evidence.subjectIds,
    });
    await db.run(
        "UPDATE clover_role_grants SET origin_ref = 'changed' WHERE id = ?",
        [applied.inserted[0].grantId]
    );
    await assert.rejects(
        () => service.buildCanonicalRoleRollbackPlan(db, applied.batchId),
        (error) => error?.code === 'migration_batch_grant_drift'
    );
});

test('executores exigem metadados antes de IO e interpretam argumentos', () => {
    const migration = migrateRunner.parseArgs([
        '--db=copy.sqlite',
        '--shadow-report=shadow.json',
        '--expected-runner-sha=abc',
        '--expected-db-sha256=def',
        '--backup=backup.sqlite',
        '--output=receipt.json',
        '--actor=owner@lid',
        '--reason=migracao controlada',
        '--apply',
    ]);
    assert.equal(migration.apply, true);
    assert.equal(migration.shadowReport, 'shadow.json');
    assert.doesNotThrow(() => migrateRunner.validateApplyOptions(migration));
    assert.throws(
        () => migrateRunner.validateApplyOptions({ apply: true }),
        (error) => error?.code === 'apply_output_required'
    );

    const rollback = rollbackRunner.parseArgs([
        '--batch-id=7',
        '--backup=backup.sqlite',
        '--output=receipt.json',
        '--actor=owner@lid',
        '--reason=rollback controlado',
        '--apply',
    ]);
    assert.equal(rollback.batchId, 7);
    assert.doesNotThrow(() => rollbackRunner.validateOptions(rollback));
    assert.throws(
        () => rollbackRunner.validateOptions({ batchId: null, apply: false }),
        (error) => error?.code === 'migration_batch_id_required'
    );
});
