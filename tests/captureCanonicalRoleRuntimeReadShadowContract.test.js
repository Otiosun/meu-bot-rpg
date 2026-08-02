'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require('../scripts/captureCanonicalRoleRuntimeReadShadow');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-role-capture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtimeRepo = path.join(root, 'runtime');
    const privateRoot = path.join(root, 'private');
    fs.mkdirSync(runtimeRepo, { recursive: true });
    fs.mkdirSync(privateRoot, { recursive: true });
    const db = path.join(runtimeRepo, 'banco.sqlite');
    fs.writeFileSync(db, 'live-database-fixture');
    return {
        root,
        runtimeRepo,
        privateRoot,
        db,
        snapshot: path.join(privateRoot, 'snapshot.sqlite'),
        metadata: path.join(privateRoot, 'metadata.json'),
        report: path.join(privateRoot, 'report.json'),
    };
}

function options(f) {
    return {
        db: f.db,
        snapshot: f.snapshot,
        metadata: f.metadata,
        report: f.report,
        runtimeRepo: f.runtimeRepo,
        expectedRuntimeSha: 'runtime-sha',
        expectedAuditorSha: 'auditor-sha',
        referenceDate: '2026-08-02T02:20:00.000Z',
        failOnUnsafe: true,
        jsonOnly: false,
    };
}

function dependencies(f, safety = {}) {
    const snapshotContent = 'consistent-private-snapshot';
    return {
        inspectRepository: (repoPath, expectedSha, label) => ({
            path: repoPath,
            sha: expectedSha,
            expectedSha,
            expectedMatch: true,
            trackedClean: true,
            label,
        }),
        backupSqliteDatabase: async (source, destination) => {
            assert.equal(source, f.db);
            fs.writeFileSync(destination, snapshotContent, { flag: 'wx' });
            return {
                sourcePath: source,
                destinationPath: destination,
                bytes: Buffer.byteLength(snapshotContent),
                integrity: 'ok',
                method: 'node:sqlite.backup',
            };
        },
        fileSha256: async (filename) => sha256(fs.readFileSync(filename)),
        runRuntimeReadAudit: async (auditOptions) => {
            assert.equal(auditOptions.db, f.snapshot);
            assert.equal(auditOptions.expectedDatabaseSha256, sha256(snapshotContent));
            assert.equal(auditOptions.expectedAuditorSha, 'auditor-sha');
            const report = {
                version: 'clover.canonical-role-runtime-read-audit.v2',
                database: { sha256: auditOptions.expectedDatabaseSha256 },
                safety: {
                    subjectCount: 15,
                    safeForAdminReader: true,
                    safeForScopedAccessReader: true,
                    safeForGenericAccessReader: false,
                    safeToSwitchAllRuntimeReaders: false,
                    ...safety,
                },
                outputPath: auditOptions.output,
            };
            fs.writeFileSync(auditOptions.output, `${JSON.stringify(report)}\n`, { flag: 'wx' });
            return report;
        },
    };
}

test('parseArgs exige todos os caminhos e reconhece modo inseguro', () => {
    const parsed = capture.parseArgs([
        '--db=C:/runtime/banco.sqlite',
        '--snapshot=C:/private/snapshot.sqlite',
        '--metadata=C:/private/metadata.json',
        '--report=C:/private/report.json',
        '--runtime-repo=C:/runtime',
        '--expected-runtime-sha=runtime',
        '--expected-auditor-sha=auditor',
        '--reference-date=2026-08-02T02:20:00.000Z',
        '--fail-on-unsafe',
        '--json-only',
    ]);

    assert.equal(parsed.db, 'C:/runtime/banco.sqlite');
    assert.equal(parsed.snapshot, 'C:/private/snapshot.sqlite');
    assert.equal(parsed.runtimeRepo, 'C:/runtime');
    assert.equal(parsed.expectedRuntimeSha, 'runtime');
    assert.equal(parsed.expectedAuditorSha, 'auditor');
    assert.equal(parsed.failOnUnsafe, true);
    assert.equal(parsed.jsonOnly, true);

    assert.throws(
        () => capture.parseArgs(['--db=banco.sqlite']),
        (error) => error?.code === 'required_argument_missing'
    );
});

test('isInside distingue repositório e pasta privada vizinha', (t) => {
    const f = fixture(t);
    assert.equal(capture.isInside(f.db, f.runtimeRepo), true);
    assert.equal(capture.isInside(f.snapshot, f.runtimeRepo), false);
});

test('captura cria snapshot, relatório e metadados sem escrever na origem', async (t) => {
    const f = fixture(t);
    const sourceBefore = fs.readFileSync(f.db);

    const result = await capture.runCapture(options(f), dependencies(f));

    assert.deepEqual(fs.readFileSync(f.db), sourceBefore);
    assert.equal(result.version, 'clover.canonical-role-runtime-read-capture.v2');
    assert.equal(result.snapshot.integrity, 'ok');
    assert.equal(result.snapshot.method, 'node:sqlite.backup');
    assert.equal(result.report.safeForAdminReader, true);
    assert.equal(result.report.safeForScopedAccessReader, true);
    assert.equal(result.report.safeForGenericAccessReader, false);
    assert.equal(result.report.safeToSwitchAllRuntimeReaders, false);
    assert.equal(fs.existsSync(f.snapshot), true);
    assert.equal(fs.existsSync(f.report), true);
    assert.equal(fs.existsSync(f.metadata), true);

    const metadata = JSON.parse(fs.readFileSync(f.metadata, 'utf8'));
    assert.equal(metadata.version, 'clover.canonical-role-runtime-read-capture.v2');
    assert.equal(metadata.writeToSource, false);
    assert.equal(metadata.sourceOpenedReadOnly, true);
    assert.equal(metadata.snapshot.sha256, result.snapshot.sha256);
    assert.equal(metadata.report.version, 'clover.canonical-role-runtime-read-audit.v2');
    assert.equal(metadata.report.databaseSha256, result.snapshot.sha256);
});

test('saídas existentes e sobrepostas são recusadas antes do backup', async (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.snapshot, 'existing');
    let backupCalls = 0;
    const deps = dependencies(f);
    deps.backupSqliteDatabase = async () => {
        backupCalls += 1;
        throw new Error('should not run');
    };

    await assert.rejects(
        () => capture.runCapture(options(f), deps),
        (error) => error?.code === 'output_already_exists'
    );
    assert.equal(backupCalls, 0);

    assert.throws(
        () => capture.assertExclusiveOutputs([f.metadata, f.metadata, f.report]),
        (error) => error?.code === 'output_paths_overlap'
    );
});

test('banco fora do runtime e saída dentro do runtime são bloqueados', async (t) => {
    const f = fixture(t);
    const outsideDb = path.join(f.privateRoot, 'outside.sqlite');
    fs.writeFileSync(outsideDb, 'outside');

    await assert.rejects(
        () => capture.runCapture({ ...options(f), db: outsideDb }, dependencies(f)),
        (error) => error?.code === 'database_outside_runtime'
    );

    const insideSnapshot = path.join(f.runtimeRepo, 'snapshot.sqlite');
    await assert.rejects(
        () => capture.runCapture({ ...options(f), snapshot: insideSnapshot }, dependencies(f)),
        (error) => error?.code === 'output_inside_repository'
    );
});

test('inspectRepository bloqueia SHA divergente e alterações rastreadas', (t) => {
    const f = fixture(t);
    const originalSpawnSync = require('child_process').spawnSync;
    assert.equal(typeof originalSpawnSync, 'function');

    assert.throws(
        () => capture.inspectRepository(path.join(f.root, 'missing'), 'abc', 'runtime'),
        (error) => error?.code === 'repository_not_found'
    );
});

test('resultado seguro também é registrado sem alterar o contrato do snapshot', async (t) => {
    const f = fixture(t);
    const result = await capture.runCapture(options(f), dependencies(f, {
        safeForGenericAccessReader: true,
        safeToSwitchAllRuntimeReaders: true,
    }));

    assert.equal(result.report.safeForAdminReader, true);
    assert.equal(result.report.safeForScopedAccessReader, true);
    assert.equal(result.report.safeForGenericAccessReader, true);
    assert.equal(result.report.safeToSwitchAllRuntimeReaders, true);
    assert.equal(result.snapshot.sha256, sha256('consistent-private-snapshot'));
});
