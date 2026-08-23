'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    EXPECTED_AUDIT,
    EXPECTED_MAIN,
    EXPECTED_PLAN,
    REQUIRED_FLAG,
    assertExact,
    parseArgs,
    resolveLiveDbPathFromPm2,
} = require('../scripts/executeApprovedSquadLiveRepairF3G1');

test('executor refuses a missing explicit approval gate', () => {
    assert.throws(
        () => parseArgs(['--db', 'x.sqlite', '--pre-repair-backup', 'b.sqlite', '--pre-repair-sha256', 'a'.repeat(64), '--expected-main', EXPECTED_MAIN]),
        /Usage requires/
    );
});

test('executor only resolves the online clover-rpg PM2 database', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-f3g1-runtime-'));
    const db = path.join(root, 'banco.sqlite');
    fs.writeFileSync(db, 'fixture');
    try {
        const jlist = JSON.stringify([
            { name: 'mudzap', pm2_env: { status: 'online', pm_cwd: path.join(root, 'mudzap') } },
            { name: 'clover-rpg', pm2_env: { status: 'online', pm_cwd: root } },
        ]);
        assert.equal(resolveLiveDbPathFromPm2(jlist), fs.realpathSync(db));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('exact gates fail closed when a count changes', () => {
    assert.doesNotThrow(() => assertExact(EXPECTED_AUDIT, EXPECTED_AUDIT, 'audit'));
    assert.doesNotThrow(() => assertExact(EXPECTED_PLAN, EXPECTED_PLAN, 'plan'));
    assert.throws(() => assertExact({ ...EXPECTED_PLAN, safe_actions_total: 12 }, EXPECTED_PLAN, 'plan'), /safe_actions_total/);
    assert.equal(REQUIRED_FLAG, '--execute-approved-f3g1-live-repair');
});
