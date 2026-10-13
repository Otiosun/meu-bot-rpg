'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const applyLocal = require('../scripts/applyUniversalEvaluationLocal');
const toggleLocal = require('../scripts/toggleUniversalEvaluationLocal');


test('apply local exige token explícito e migrations 31-34', () => {
    assert.equal(applyLocal.CONFIRM_TOKEN, 'APPLY_UNIVERSAL_EVALUATION_LOCAL');
    assert.deepEqual(applyLocal.EXPECTED_MIGRATIONS, [31, 32, 33, 34]);
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
