'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

test('F7 calls real route owners for every critical boundary family', async () => {
    const result = await runCriticalHandlerBoundaryProbes();
    assert.equal(result.probed, result.total);
    assert.deepEqual(result.failures, []);
    assert.ok(result.probes.every((probe) => /^MATCHED_/.test(probe.outcome)));
});

test('F7 runtime boundary probe fails if a family target is disabled', async () => {
    const result = await runCriticalHandlerBoundaryProbes({ disableFamily: 'raid' });
    assert.notEqual(result.probed, result.total);
});
