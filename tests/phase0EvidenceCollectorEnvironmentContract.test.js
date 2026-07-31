'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    AUDITORS,
    preflight,
    run,
    validateConfig,
} = require('../scripts/collectCloverPhase0Evidence');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-environment-'));
    const runtime = path.join(root, 'runtime');
    const collector = path.join(root, 'collector');
    fs.mkdirSync(runtime);
    fs.mkdirSync(collector);
    fs.writeFileSync(path.join(runtime, 'banco.sqlite'), 'live');
    const auditors = {};
    for (const [key, scripts] of Object.entries(AUDITORS)) {
        const cwd = path.join(root, key);
        fs.mkdirSync(cwd);
        for (const script of scripts) {
            const file = path.join(cwd, script);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '// fake');
        }
        auditors[key] = { cwd, expectedSha: `${key}-sha` };
    }
    const config = validateConfig({
        outputDir: path.join(root, 'evidence'),
        referenceDate: '2026-07-31T18:00:00.000Z',
        runtime: {
            cwd: runtime,
            sourceDb: path.join(runtime, 'banco.sqlite'),
            expectedSha: 'runtime-sha',
            allowExternalDb: false,
            processName: 'clover-rpg',
        },
        auditors,
        eligibilityPolicy: { approvedSheetStatuses: [], releasedGameStatuses: [] },
    });
    return { root, runtime, collector, config };
}

function git(cwd, args) {
    if (args[0] === 'status') return '';
    if (cwd.endsWith('runtime')) return 'runtime-sha-full';
    const key = Object.keys(AUDITORS).find((candidate) => cwd.endsWith(candidate));
    if (key) return `${key}-sha-full`;
    return 'collector-sha-full';
}

function pm2(cwd, pid = 10, restartTime = 0) {
    return [{
        name: 'clover-rpg',
        pid,
        pm_id: 0,
        pm2_env: {
            status: 'online',
            pm_cwd: cwd,
            pm_exec_path: path.join(cwd, 'index.js'),
            restart_time: restartTime,
        },
    }];
}

test('preflight bloqueia symlink do banco para fora do runtime', () => {
    const item = fixture();
    const outside = path.join(item.root, 'outside.sqlite');
    const link = path.join(item.runtime, 'linked.sqlite');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, link);
    item.config.runtime.sourceDb = link;
    assert.throws(() => preflight(item.config, 'collector-sha', {
        collectorCwd: item.collector,
        git,
        pm2List: () => pm2(item.runtime),
    }), { code: 'external_database_symlink' });
});

test('coleta falha se o processo PM2 reiniciar após o preflight', async () => {
    const item = fixture();
    let pm2Reads = 0;
    let executions = 0;
    await assert.rejects(() => run(item.config, {
        expectedCollectorSha: 'collector-sha',
    }, {
        collectorCwd: item.collector,
        git,
        pm2List() {
            pm2Reads += 1;
            return pm2(item.runtime, pm2Reads === 1 ? 10 : 11, pm2Reads === 1 ? 0 : 1);
        },
        execute(step, context) {
            executions += 1;
            if (step.name === 'create-snapshot') {
                fs.writeFileSync(context.plan.snapshot, 'snapshot');
                fs.writeFileSync(context.plan.metadata, '{}');
            } else {
                for (const output of step.outputs) fs.writeFileSync(output, '{}');
            }
            return { status: 0, stdout: '', stderr: '' };
        },
    }), { code: 'execution_environment_changed' });
    assert.equal(executions, 1);
    assert.equal(fs.existsSync(path.join(item.config.outputDir, 'clover-phase0.failure.json')), true);
});
