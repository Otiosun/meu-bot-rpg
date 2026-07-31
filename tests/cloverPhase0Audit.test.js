'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function createFixture(databasePath) {
    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            esquadrao TEXT,
            ficha_status TEXT,
            jogo_status TEXT
        );
        CREATE TABLE clover_admin_roles (
            player_id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            active INTEGER NOT NULL
        );
        CREATE TABLE clover_access_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT,
            captain_player_id TEXT,
            current_stars INTEGER,
            historical_stars INTEGER,
            black_stars INTEGER
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            joined_at TEXT,
            ended_at TEXT
        );
        CREATE TABLE clover_squad_star_ledger (
            squad_key TEXT,
            player_id TEXT,
            amount INTEGER,
            kind TEXT,
            source TEXT,
            reason TEXT
        );
        CREATE TABLE clover_admin_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT,
            status TEXT
        );
        CREATE TABLE clover_admin_operation_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id INTEGER,
            status TEXT,
            applied_at TEXT,
            undone_at TEXT
        );

        INSERT INTO jogadores VALUES
            ('captain@lid', 'Capitã', 'Coringas Magenta', 'aprovada', 'liberado'),
            ('member@lid', 'Membro', 'Asas da Liberdade', 'pendente', 'bloqueado'),
            ('legacy@lid', 'Legado', 'Lobos Cinzentos', 'aprovada', 'liberado');

        INSERT INTO clover_admin_roles VALUES
            ('evaluator@lid', 'evaluator', 1),
            ('narrator@lid', 'narrator', 1);

        INSERT INTO clover_access_roles
            (subject_id, role_key, scope_type, scope_key, status)
        VALUES
            ('evaluator@lid', 'narrator', 'global', '*', 'active'),
            ('stale-admin@lid', 'admin', 'global', '*', 'active'),
            ('captain@lid', 'captain', 'squad', 'coringas_magenta', 'active');

        INSERT INTO clover_squads VALUES
            ('coringas_magenta', 'Coringas Magenta', 'captain@lid', 2, 1, 0),
            ('lobos_cinzentos', 'Lobos Cinzentos', NULL, 0, 0, 0);

        INSERT INTO clover_squad_memberships
            (squad_key, player_id, status, joined_at)
        VALUES
            ('coringas_magenta', 'member@lid', 'active', CURRENT_TIMESTAMP),
            ('coringas_magenta', 'ghost@lid', 'active', CURRENT_TIMESTAMP);

        INSERT INTO clover_squad_star_ledger VALUES
            ('coringas_magenta', 'member@lid', 3, 'ganho', 'squad_reconcile', 'legado'),
            ('coringas_magenta', 'member@lid', -1, 'gasto', 'purchase', 'compra');

        INSERT INTO clover_admin_operations (code, status) VALUES
            ('ADM-001', 'partially_applied'),
            ('ADM-002', 'approved');

        INSERT INTO clover_admin_operation_units
            (operation_id, status, applied_at)
        VALUES
            (1, 'applied', CURRENT_TIMESTAMP),
            (1, 'failed', NULL),
            (2, 'applied', CURRENT_TIMESTAMP);
    `);
    await db.close();
}

async function snapshot(databasePath) {
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    try {
        return {
            players: (await db.get('SELECT COUNT(*) AS count FROM jogadores')).count,
            memberships: (await db.get('SELECT COUNT(*) AS count FROM clover_squad_memberships')).count,
            ledger: (await db.get('SELECT COUNT(*) AS count FROM clover_squad_star_ledger')).count,
            operations: (await db.get('SELECT COUNT(*) AS count FROM clover_admin_operations')).count,
            schema: await db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"),
        };
    } finally {
        await db.close();
    }
}

function runAudit(databasePath, reportPath, extraArgs = []) {
    return execFileSync(process.execPath, [
        path.resolve(__dirname, '../scripts/auditCloverPhase0.js'),
        `--db=${databasePath}`,
        `--output=${reportPath}`,
        ...extraArgs,
    ], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
    });
}

function issueCodes(report) {
    return new Set(report.issues.map((item) => item.code));
}

test('auditoria P0 detecta contradições centrais e preserva o banco', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase0-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const reportPath = path.join(directory, 'report.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    await createFixture(databasePath);
    const before = await snapshot(databasePath);
    const stdout = runAudit(databasePath, reportPath, ['--runtime-sha=runtime-fixture-sha']);
    const after = await snapshot(databasePath);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const codes = issueCodes(report);

    assert.match(stdout, /Modo: SOMENTE LEITURA/);
    assert.equal(report.mode, 'read_only');
    assert.equal(report.reportVersion, 'clover-phase0-audit-v2');
    assert.match(report.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.equal(report.evidence.source.database.queryOnly, true);
    assert.equal(report.evidence.source.database.integrity, 'ok');
    assert.equal(report.evidence.source.database.foreignKeyViolationCount, 0);
    assert.equal(report.evidence.source.runtimeObserved.deployedSha, 'runtime-fixture-sha');
    assert.equal(report.evidence.source.runtimeObserved.shaProvided, true);
    assert.equal(typeof report.evidence.source.auditor.head, 'string');
    assert.equal(report.summary.critical > 0, true);

    assert.equal(codes.has('runtime_sha_not_provided'), false);
    assert.equal(codes.has('admin_role_missing_in_access_control'), true);
    assert.equal(codes.has('access_role_missing_in_admin_team'), true);
    assert.equal(codes.has('membership_legacy_disagreement'), true);
    assert.equal(codes.has('active_membership_without_player'), true);
    assert.equal(codes.has('legacy_squad_without_active_membership'), true);
    assert.equal(codes.has('active_member_outside_current_eligibility'), true);
    assert.equal(codes.has('legacy_squad_reconcile_entries_present'), true);
    assert.equal(codes.has('historical_stars_below_current'), true);
    assert.equal(codes.has('partially_applied_operations_present'), true);
    assert.equal(codes.has('mutated_unit_outside_parent_state'), true);

    assert.deepEqual(after, before);
});

test('--fail-on-critical retorna código específico sem modificar o banco', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase0-fail-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const reportPath = path.join(directory, 'report.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    await createFixture(databasePath);
    const before = await snapshot(databasePath);
    let status = null;
    try {
        runAudit(databasePath, reportPath, [
            '--runtime-sha=runtime-fixture-sha',
            '--fail-on-critical',
        ]);
    } catch (error) {
        status = error.status;
    }
    const after = await snapshot(databasePath);

    assert.equal(status, 2);
    assert.equal(fs.existsSync(reportPath), true);
    assert.deepEqual(after, before);
});

test('SHA do runtime é evidência e SHA esperado do auditor é validação separada', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase0-sha-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const reportPath = path.join(directory, 'report.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    await createFixture(databasePath);
    runAudit(databasePath, reportPath, [
        '--runtime-sha=deployed-runtime-sha',
        '--expected-auditor-sha=definitely-not-the-auditor-head',
    ]);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const codes = issueCodes(report);

    assert.equal(report.evidence.source.runtimeObserved.deployedSha, 'deployed-runtime-sha');
    assert.equal(report.evidence.source.auditor.expectedSha, 'definitely-not-the-auditor-head');
    assert.equal(report.evidence.source.auditor.expectedShaMatchesHead, false);
    assert.equal(codes.has('expected_auditor_sha_mismatch'), true);
});
