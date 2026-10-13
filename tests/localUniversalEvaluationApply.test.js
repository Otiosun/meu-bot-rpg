'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const applyLocal = require('../scripts/applyUniversalEvaluationLocal');
const toggleLocal = require('../scripts/toggleUniversalEvaluationLocal');


test('apply local exige token explícito e migrations 31-34', () => {
    assert.equal(applyLocal.CONFIRM_TOKEN, 'APPLY_UNIVERSAL_EVALUATION_LOCAL');
    assert.deepEqual(applyLocal.EXPECTED_MIGRATIONS, [31, 32, 33, 34]);
    assert.deepEqual(applyLocal.ALLOWED_START_VERSIONS, [30, 31, 32, 33, 34]);
    assert.equal(
        applyLocal.parseConfirm(['--confirm=APPLY_UNIVERSAL_EVALUATION_LOCAL']),
        'APPLY_UNIVERSAL_EVALUATION_LOCAL'
    );
    assert.equal(applyLocal.parseConfirm([]), null);
});


test('toggle local separa enable e disable e exige versões 31-34', () => {
    assert.equal(toggleLocal.ENABLE_TOKEN, 'ENABLE_UNIVERSAL_EVALUATION_LOCAL');
    assert.equal(toggleLocal.DISABLE_TOKEN, 'DISABLE_UNIVERSAL_EVALUATION_LOCAL');
    assert.deepEqual(toggleLocal.REQUIRED_MIGRATIONS, [31, 32, 33, 34]);
    assert.equal(toggleLocal.parseMode(['--enable']), 'enable');
    assert.equal(toggleLocal.parseMode(['--disable']), 'disable');
    assert.equal(toggleLocal.parseMode(['--enable', '--disable']), null);
    assert.equal(toggleLocal.parseMode([]), null);
});


test('bootstrap usa chamadas Git seguras para PowerShell 5.1 e somente ASCII', () => {
    const script = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'bootstrapUniversalEvaluationLocal.ps1'),
        'utf8'
    );
    assert.doesNotMatch(script, /Invoke-Checked\s+git\s/);
    assert.match(script, /Invoke-Checked\s+-Command\s+'git'\s+-Arguments\s+@\(/);
    assert.doesNotMatch(script, /\$\([^\r\n)]*\?[^\r\n)]*:/);
    assert.equal([...script].some((char) => char.codePointAt(0) > 0x7F), false);
});


test('bootstrap nao entrega pm2 jlist bruto ao ConvertFrom-Json do PowerShell 5.1', () => {
    const script = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'bootstrapUniversalEvaluationLocal.ps1'),
        'utf8'
    );
    assert.match(script, /function Get-CloverPm2Summary/);
    assert.match(script, /JSON\.parse\(String\(result\.stdout/);
    assert.doesNotMatch(script, /pm2\s+jlist[\s\S]{0,500}ConvertFrom-Json/);
    assert.doesNotMatch(script, /\$Pm2Json\s*=.*pm2\s+jlist/);
});
