'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auditor = require('../scripts/auditCanonicalRoleRuntimeReadShadow');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function safeSubjectReport(overrides = {}) {
    return {
        version: 'clover.canonical-role-runtime-read-shadow.v2',
        subjectId: 'admin@lid',
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        catalogs: {
            admin: ['operation.view'],
            access: ['raid.view'],
        },
        summary: {
            safeForAdminReader: true,
            safeForScopedAccessReader: true,
            safeForGenericAccessReader: true,
            safeToSwitchAllRuntimeReaders: true,
        },
        ...overrides,
    };
}

function safeBatch(overrides = {}) {
    const report = safeSubjectReport();
    return {
        version: 'clover.canonical-role-runtime-read-shadow-batch.v2',
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        subjectCount: 1,
        safeForAdminReaderCount: 1,
        safeForScopedAccessReaderCount: 1,
        safeForGenericAccessReaderCount: 1,
        safeToSwitchAllRuntimeReadersCount: 1,
        adminCriticalCount: 0,
        accessGenericCriticalCount: 0,
        accessScopedCriticalCount: 0,
        genericScopeHardeningCount: 0,
        foreignScopeLeakCount: 0,
        reports: [report],
        ...overrides,
    };
}

function fixtureFile(t, content = 'immutable-snapshot') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-runtime-role-shadow-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const database = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(database, content);
    return { directory, database, content };
}

function dependencies(batch, overrides = {}) {
    let closed = false;
    const db = {
        close: async () => { closed = true; },
    };
    return {
        openDatabase: async () => db,
        buildBatch: async () => batch,
        currentGitSha: () => 'abcdef1234567890',
        fileSha256: async (filePath) => sha256(fs.readFileSync(filePath)),
        wasClosed: () => closed,
        ...overrides,
    };
}

test('parseArgs aceita filtros repetidos e proteções', () => {
    const options = auditor.parseArgs([
        '--db=snapshot.sqlite',
        '--output=report.json',
        '--subject=admin@lid',
        '--subject', 'captain@lid',
        '--scope=alpha',
        '--scope', 'beta',
        '--permission=squad.manage.members',
        '--permission', 'raid.view',
        '--reference-date=2026-08-02T02:20:00.000Z',
        '--expected-auditor-sha=abcdef',
        '--expected-db-sha256=' + 'a'.repeat(64),
        '--fail-on-unsafe',
        '--json-only',
    ]);

    assert.equal(options.db, 'snapshot.sqlite');
    assert.equal(options.output, 'report.json');
    assert.deepEqual(options.subjectIds, ['admin@lid', 'captain@lid']);
    assert.deepEqual(options.scopeKeys, ['alpha', 'beta']);
    assert.deepEqual(options.permissions, ['squad.manage.members', 'raid.view']);
    assert.equal(options.expectedAuditorSha, 'abcdef');
    assert.equal(options.expectedDatabaseSha256, 'a'.repeat(64));
    assert.equal(options.failOnUnsafe, true);
    assert.equal(options.jsonOnly, true);
});

test('sameSha aceita apenas prefixo real', () => {
    assert.equal(auditor.sameSha('abcdef1234', 'abcdef'), true);
    assert.equal(auditor.sameSha('abcdef', 'abcdef1234'), true);
    assert.equal(auditor.sameSha('abcdef1234', 'bcdef'), false);
    assert.equal(auditor.sameSha(null, 'abcdef'), null);
});

test('auditoria preserva snapshot, fecha banco e grava relatório exclusivo', async (t) => {
    const fixture = fixtureFile(t);
    const output = path.join(fixture.directory, 'report.json');
    const deps = dependencies(safeBatch());

    const beforeStat = fs.statSync(fixture.database);
    const report = await auditor.runRuntimeReadAudit({
        db: fixture.database,
        output,
        subjectIds: [],
        scopeKeys: [],
        permissions: [],
        referenceDate: '2026-08-02T02:20:00.000Z',
        expectedAuditorSha: 'abcdef',
        expectedDatabaseSha256: sha256(fixture.content),
        failOnUnsafe: false,
        jsonOnly: false,
    }, deps);

    const afterStat = fs.statSync(fixture.database);
    assert.equal(deps.wasClosed(), true);
    assert.equal(report.version, 'clover.canonical-role-runtime-read-audit.v2');
    assert.equal(report.write, false);
    assert.equal(report.queryOnlySafe, true);
    assert.equal(report.enforcementChanged, false);
    assert.equal(report.database.unchanged, true);
    assert.equal(report.database.sha256, sha256(fixture.content));
    assert.equal(report.auditor.expectedMatch, true);
    assert.equal(report.safety.safeToSwitchAllRuntimeReaders, true);
    assert.equal(beforeStat.size, afterStat.size);
    assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs);
    assert.equal(fs.existsSync(output), true);
    assert.throws(() => fs.writeFileSync(output, 'overwrite', { flag: 'wx' }), /EEXIST/);
});

test('SHA do auditor e SHA do banco bloqueiam antes da abertura', async (t) => {
    const fixture = fixtureFile(t);
    let opened = 0;
    const deps = dependencies(safeBatch(), {
        openDatabase: async () => {
            opened += 1;
            return { close: async () => null };
        },
    });

    await assert.rejects(
        () => auditor.runRuntimeReadAudit({
            db: fixture.database,
            subjectIds: [], scopeKeys: [], permissions: [],
            referenceDate: null,
            expectedAuditorSha: 'ffff',
            expectedDatabaseSha256: null,
        }, deps),
        (error) => error?.code === 'auditor_sha_mismatch'
    );
    assert.equal(opened, 0);

    await assert.rejects(
        () => auditor.runRuntimeReadAudit({
            db: fixture.database,
            subjectIds: [], scopeKeys: [], permissions: [],
            referenceDate: null,
            expectedAuditorSha: 'abcdef',
            expectedDatabaseSha256: '0'.repeat(64),
        }, deps),
        (error) => error?.code === 'database_sha256_mismatch'
    );
    assert.equal(opened, 0);
});

test('contrato inválido do batch ou do relatório é bloqueado', async (t) => {
    const fixture = fixtureFile(t);

    await assert.rejects(
        () => auditor.runRuntimeReadAudit({
            db: fixture.database,
            subjectIds: [], scopeKeys: [], permissions: [],
            referenceDate: null,
            expectedAuditorSha: 'abcdef',
            expectedDatabaseSha256: sha256(fixture.content),
        }, dependencies(safeBatch({ write: true }))),
        (error) => error?.code === 'invalid_runtime_read_shadow_batch'
            && error.details.errors.includes('batch_not_read_only')
    );

    const invalidReport = safeSubjectReport({ catalogs: null });
    await assert.rejects(
        () => auditor.runRuntimeReadAudit({
            db: fixture.database,
            subjectIds: [], scopeKeys: [], permissions: [],
            referenceDate: null,
            expectedAuditorSha: 'abcdef',
            expectedDatabaseSha256: sha256(fixture.content),
        }, dependencies(safeBatch({ reports: [invalidReport] }))),
        (error) => error?.code === 'invalid_runtime_read_shadow_batch'
            && error.details.errors.includes('report_contract_violation')
    );
});

test('mudança do snapshot durante a leitura é detectada', async (t) => {
    const fixture = fixtureFile(t);
    const deps = dependencies(safeBatch(), {
        buildBatch: async () => {
            fs.appendFileSync(fixture.database, '-changed');
            return safeBatch();
        },
    });

    await assert.rejects(
        () => auditor.runRuntimeReadAudit({
            db: fixture.database,
            subjectIds: [], scopeKeys: [], permissions: [],
            referenceDate: null,
            expectedAuditorSha: 'abcdef',
            expectedDatabaseSha256: sha256(fixture.content),
        }, deps),
        (error) => error?.code === 'runtime_read_shadow_database_changed'
    );
    assert.equal(deps.wasClosed(), true);
});

test('sumário separa segurança da Central, acesso escopado e acesso genérico', async (t) => {
    const fixture = fixtureFile(t);
    const unsafeReport = safeSubjectReport({
        subjectId: 'captain@lid',
        summary: {
            safeForAdminReader: true,
            safeForScopedAccessReader: true,
            safeForGenericAccessReader: false,
            safeToSwitchAllRuntimeReaders: false,
        },
    });
    const batch = safeBatch({
        safeForGenericAccessReaderCount: 0,
        safeToSwitchAllRuntimeReadersCount: 0,
        accessGenericCriticalCount: 1,
        genericScopeHardeningCount: 1,
        foreignScopeLeakCount: 1,
        reports: [unsafeReport],
    });
    const deps = dependencies(batch);

    const report = await auditor.runRuntimeReadAudit({
        db: fixture.database,
        subjectIds: [], scopeKeys: [], permissions: [],
        referenceDate: null,
        expectedAuditorSha: 'abcdef',
        expectedDatabaseSha256: sha256(fixture.content),
    }, deps);

    assert.equal(report.safety.safeForAdminReader, true);
    assert.equal(report.safety.safeForScopedAccessReader, true);
    assert.equal(report.safety.safeForGenericAccessReader, false);
    assert.equal(report.safety.safeToSwitchAllRuntimeReaders, false);
    assert.deepEqual(report.safety.unsafeGenericAccessSubjects, ['captain@lid']);
    assert.deepEqual(report.safety.unsafeAllSubjects, ['captain@lid']);
    assert.equal(report.safety.genericScopeHardeningCount, 1);
    assert.equal(report.safety.foreignScopeLeakCount, 1);
});
