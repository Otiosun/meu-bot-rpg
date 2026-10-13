'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const applyLocal = require('../scripts/applyUniversalEvaluationLocal');
const toggleLocal = require('../scripts/toggleUniversalEvaluationLocal');
const bootstrapLocal = require('../scripts/bootstrapUniversalEvaluationLocal');


test('apply local exige token explícito e migrations 55-58 sobre baseline live 54', () => {
    assert.equal(applyLocal.CONFIRM_TOKEN, 'APPLY_UNIVERSAL_EVALUATION_LOCAL');
    assert.deepEqual(applyLocal.EXPECTED_MIGRATIONS, [55, 56, 57, 58]);
    assert.deepEqual(applyLocal.ALLOWED_START_VERSIONS, [54, 55, 56, 57, 58]);
    assert.equal(applyLocal.FINAL_SCHEMA_VERSION, 58);
    assert.equal(
        applyLocal.parseConfirm(['--confirm=APPLY_UNIVERSAL_EVALUATION_LOCAL']),
        'APPLY_UNIVERSAL_EVALUATION_LOCAL'
    );
    assert.equal(applyLocal.parseConfirm([]), null);
});


test('toggle local separa enable e disable e exige migrations 55-58', () => {
    assert.equal(toggleLocal.ENABLE_TOKEN, 'ENABLE_UNIVERSAL_EVALUATION_LOCAL');
    assert.equal(toggleLocal.DISABLE_TOKEN, 'DISABLE_UNIVERSAL_EVALUATION_LOCAL');
    assert.deepEqual(toggleLocal.REQUIRED_MIGRATIONS, [55, 56, 57, 58]);
    assert.equal(toggleLocal.REQUIRED_USER_VERSION, 58);
    assert.equal(toggleLocal.parseMode(['--enable']), 'enable');
    assert.equal(toggleLocal.parseMode(['--disable']), 'disable');
    assert.equal(toggleLocal.parseMode(['--enable', '--disable']), null);
    assert.equal(toggleLocal.parseMode([]), null);
});


test('bootstrap Node e o entrypoint canonico e permanece ASCII-only', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'bootstrapUniversalEvaluationLocal.js');
    const script = fs.readFileSync(scriptPath, 'utf8');

    assert.equal(bootstrapLocal.TARGET_BRANCH, 'clover/evaluation-support-migration-2026-10-13');
    assert.equal(bootstrapLocal.PM2_NAME, 'clover-rpg');
    assert.equal(bootstrapLocal.APPLY_TOKEN, 'APPLY_UNIVERSAL_EVALUATION_LOCAL');
    assert.match(script, /JSON\.parse\(result\.stdout/);
    assert.match(script, /backupSqliteDatabase/);
    assert.match(script, /restoreDatabase/);
    assert.match(script, /restoreCode/);
    assert.match(script, /migrations 55-58/);
    assert.doesNotMatch(script, /migrations 31-34/);
    assert.equal([...script].some((char) => char.codePointAt(0) > 0x7F), false);
});


test('bootstrap PowerShell legado tambem permanece ASCII, usa 55-58 e evita parser JSON bruto', () => {
    const script = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'bootstrapUniversalEvaluationLocal.ps1'),
        'utf8'
    );
    assert.doesNotMatch(script, /Invoke-Checked\s+git\s/);
    assert.match(script, /Invoke-Checked\s+-Command\s+'git'\s+-Arguments\s+@\(/);
    assert.doesNotMatch(script, /\$\([^\r\n)]*\?[^\r\n)]*:/);
    assert.equal([...script].some((char) => char.codePointAt(0) > 0x7F), false);
    assert.match(script, /function Get-CloverPm2Summary/);
    assert.match(script, /migrations 55-58/);
    assert.doesNotMatch(script, /migrations 31-34/);
    assert.doesNotMatch(script, /pm2\s+jlist[\s\S]{0,500}ConvertFrom-Json/);
});
