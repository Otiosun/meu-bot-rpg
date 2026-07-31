'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    eligibilityArgs,
    buildPlan,
    loadConfig,
    parseArgs,
    run,
    sameSha,
    validateConfig,
} = require('../scripts/collectCloverPhase0Evidence');

const AUDITOR_KEYS = [
    'phase0',
    'roleShadow',
    'membershipIntegrity',
    'membershipReadShadow',
    'eligibilityStatus',
];

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-evidence-'));
    const runtime = path.join(root, 'runtime');
    const collector = path.join(root, 'collector');
    fs.mkdirSync(runtime);
    fs.mkdirSync(collector);
    fs.writeFileSync(path.join(runtime, 'banco.sqlite'), 'live-db');
    const auditors = {};
    for (const key of AUDITOR_KEYS) {
        const cwd = path.join(root, key);
        fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
        auditors[key] = { cwd, expectedSha: `${key}-sha` };
    }
    const scripts = {
        phase0: [
            'createCloverPhase0Snapshot.js',
            'auditCloverPhase0.js',
            'auditLegacySquadReconcileCallsites.js',
        ],
        roleShadow: ['auditCanonicalRoleShadow.js'],
        membershipIntegrity: ['auditSquadMembershipIntegrity.js'],
        membershipReadShadow: ['auditSquadMembershipReadShadow.js'],
        eligibilityStatus: ['auditSquadMembershipEligibilityStatuses.js'],
    };
    for (const [key, names] of Object.entries(scripts)) {
        for (const name of names) fs.writeFileSync(path.join(auditors[key].cwd, 'scripts', name), '// fake');
    }
    return {
        root,
        collector,
        outputDir: path.join(root, 'evidence'),
        config: validateConfig({
            version: 'test',
            outputDir: path.join(root, 'evidence'),
            runtime: {
                cwd: runtime,
                sourceDb: path.join(runtime, 'banco.sqlite'),
                expectedSha: 'runtime-sha',
                allowExternalDb: false,
                processName: 'clover-rpg',
            },
            auditors,
            eligibilityPolicy: {
                approvedSheetStatuses: [],
                releasedGameStatuses: [],
            },
            referenceDate: '2026-07-31T18:00:00.000Z',
        }),
    };
}

function fakeGit(cwd, args) {
    if (args[0] === 'rev-parse') {
        if (cwd.endsWith('runtime')) return 'runtime-sha-full';
        const key = AUDITOR_KEYS.find((candidate) => cwd.endsWith(candidate));
        if (key) return `${key}-sha-full`;
        return 'collector-sha-full';
    }
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
}

function fakePm2List(runtimeCwd) {
    return [{
        name: 'clover-rpg',
        pid: 123,
        pm_id: 0,
        pm2_env: {
            status: 'online',
            pm_cwd: runtimeCwd,
            pm_exec_path: path.join(runtimeCwd, 'index.js'),
            restart_time: 2,
        },
    }];
}

function successfulExecutor(blockedNames = new Set()) {
    return (step, context) => {
        if (step.name === 'create-snapshot') {
            fs.writeFileSync(context.plan.snapshot, 'snapshot-stable');
            fs.writeFileSync(context.plan.metadata, '{}');
        } else {
            for (const output of step.outputs) fs.writeFileSync(output, JSON.stringify({ step: step.name }));
        }
        return {
            status: blockedNames.has(step.name) ? 2 : 0,
            stdout: `stdout ${step.name}`,
            stderr: '',
        };
    };
}

test('parseArgs exige config e aceita proteções', () => {
    assert.deepEqual(parseArgs([
        '--config=/tmp/plan.json',
        '--expected-collector-sha=abc',
        '--dry-run',
        '--json-only',
    ]), {
        config: '/tmp/plan.json',
        expectedCollectorSha: 'abc',
        dryRun: true,
        jsonOnly: true,
    });
    assert.throws(() => parseArgs([]), { code: 'missing_config' });
});

test('sameSha aceita apenas prefixo real', () => {
    assert.equal(sameSha('abcdef123', 'abcdef'), true);
    assert.equal(sameSha('abcdef', 'abcdef123'), true);
    assert.equal(sameSha('abcdef', 'abc999'), false);
    assert.equal(sameSha(null, 'abc'), null);
});

test('loadConfig resolve caminhos relativos ao arquivo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-config-'));
    const file = path.join(root, 'plan.json');
    fs.writeFileSync(file, JSON.stringify({
        outputDir: './evidence',
        runtime: { cwd: './runtime', db: './banco.sqlite', expectedSha: 'runtime' },
        auditors: Object.fromEntries(AUDITOR_KEYS.map((key) => [key, { cwd: `./${key}`, expectedSha: key }])),
    }));
    const config = loadConfig(file);
    assert.equal(config.outputDir, path.join(root, 'evidence'));
    assert.equal(config.runtime.sourceDb, path.join(root, 'runtime', 'banco.sqlite'));
    assert.equal(config.auditors.phase0.cwd, path.join(root, 'phase0'));
});

test('validateConfig bloqueia política incompleta e banco externo implícito', () => {
    const fixture = makeFixture();
    const incomplete = structuredClone(fixture.config);
    incomplete.eligibilityPolicy.approvedSheetStatuses = ['aprovada'];
    assert.throws(() => validateConfig(incomplete), { code: 'incomplete_eligibility_policy' });

    const external = structuredClone(fixture.config);
    external.runtime.sourceDb = path.join(fixture.root, 'outside.sqlite');
    assert.throws(() => validateConfig(external), { code: 'external_database_not_allowed' });
});

test('buildEligibilityArgs aplica allowlists juntas e fail-on-policy-risk', () => {
    const fixture = makeFixture();
    fixture.config.eligibilityPolicy = {
        approvedSheetStatuses: ['aprovada', 'aprovado'],
        releasedGameStatuses: ['liberada'],
    };
    const args = eligibilityArgs(fixture.config, '/tmp/snapshot.sqlite', '/tmp/report.json');
    assert.equal(args.includes('--approved-sheet-status=aprovada'), true);
    assert.equal(args.includes('--approved-sheet-status=aprovado'), true);
    assert.equal(args.includes('--released-game-status=liberada'), true);
    assert.equal(args.includes('--fail-on-policy-risk'), true);
});

test('dry-run valida tudo sem criar diretório de saída', async () => {
    const fixture = makeFixture();
    const result = await run(fixture.config, {
        expectedCollectorSha: 'collector-sha',
        dryRun: true,
    }, {
        collectorCwd: fixture.collector,
        currentCollectorSha: () => 'collector-sha-full',
        git: fakeGit,
        pm2List: () => fakePm2List(fixture.config.runtime.cwd),
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.steps.length, 7);
    assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('preflight bloqueia SHA do coletor antes de criar evidência', async () => {
    const fixture = makeFixture();
    await assert.rejects(() => run(fixture.config, {
        expectedCollectorSha: 'different',
    }, {
        collectorCwd: fixture.collector,
        currentCollectorSha: () => 'collector-sha-full',
        git: fakeGit,
        pm2List: () => fakePm2List(fixture.config.runtime.cwd),
    }), { code: 'checkout_sha_mismatch' });
    assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('coleta completa continua após código 2 e cria manifesto bloqueado', async () => {
    const fixture = makeFixture();
    const blocked = new Set(['phase0-audit', 'membership-read-shadow']);
    const result = await run(fixture.config, {
        expectedCollectorSha: 'collector-sha',
    }, {
        collectorCwd: fixture.collector,
        currentCollectorSha: () => 'collector-sha-full',
        git: fakeGit,
        pm2List: () => fakePm2List(fixture.config.runtime.cwd),
        execute: successfulExecutor(blocked),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, 'blocked_by_evidence');
    assert.deepEqual(result.manifest.blockedSteps, ['phase0-audit', 'membership-read-shadow']);
    assert.equal(result.manifest.snapshot.unchanged, true);
    assert.equal(fs.existsSync(result.manifestPath), true);
    assert.equal(fs.existsSync(result.digestPath), true);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(result.manifestPath).mode & 0o777, 0o600);
    }
    assert.equal(result.manifest.steps.length, 7);
});

test('falha técnica interrompe etapas seguintes e grava recibo de falha', async () => {
    const fixture = makeFixture();
    let calls = 0;
    await assert.rejects(() => run(fixture.config, {
        expectedCollectorSha: 'collector-sha',
    }, {
        collectorCwd: fixture.collector,
        currentCollectorSha: () => 'collector-sha-full',
        git: fakeGit,
        pm2List: () => fakePm2List(fixture.config.runtime.cwd),
        execute(step, context) {
            calls += 1;
            if (step.name === 'create-snapshot') {
                fs.writeFileSync(context.plan.snapshot, 'snapshot');
                fs.writeFileSync(context.plan.metadata, '{}');
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: 'boom' };
        },
    }), { code: 'evidence_step_failed' });
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(fixture.outputDir, 'clover-phase0.failure.json')), true);
});

test('alteração do snapshot durante auditoria é detectada', async () => {
    const fixture = makeFixture();
    await assert.rejects(() => run(fixture.config, {
        expectedCollectorSha: 'collector-sha',
    }, {
        collectorCwd: fixture.collector,
        currentCollectorSha: () => 'collector-sha-full',
        git: fakeGit,
        pm2List: () => fakePm2List(fixture.config.runtime.cwd),
        execute(step, context) {
            if (step.name === 'create-snapshot') {
                fs.writeFileSync(context.plan.snapshot, 'snapshot');
                fs.writeFileSync(context.plan.metadata, '{}');
            } else {
                for (const output of step.outputs) fs.writeFileSync(output, '{}');
                fs.appendFileSync(context.plan.snapshot, '-changed');
            }
            return { status: 0, stdout: '', stderr: '' };
        },
    }), { code: 'snapshot_changed_during_audit' });
});

test('preflight bloqueia PM2 em cwd diferente', async () => {
    const fixture = makeFixture();
    await assert.rejects(() => run(fixture.config, {
        expectedCollectorSha: 'collector-sha',
        dryRun: true,
    }, {
        collectorCwd: fixture.collector,
        currentCollectorSha: () => 'collector-sha-full',
        git: fakeGit,
        pm2List: () => fakePm2List(path.join(fixture.root, 'outro-runtime')),
    }), { code: 'pm2_cwd_mismatch' });
});

test('buildSteps mantém ordem de snapshot e auditorias', () => {
    const fixture = makeFixture();
    assert.deepEqual(buildPlan(fixture.config).steps.map((step) => step.name), [
        'create-snapshot',
        'phase0-audit',
        'legacy-reconcile-callsites',
        'canonical-role-shadow',
        'membership-integrity',
        'membership-read-shadow',
        'membership-eligibility-statuses',
    ]);
});
