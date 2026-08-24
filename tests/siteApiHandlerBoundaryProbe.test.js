'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

test('F7 calls real route owners for every critical boundary family', async () => {
    const result = await runCriticalHandlerBoundaryProbes();
    assert.equal(result.probed, result.total);
    assert.deepEqual(result.failures, []);
    assert.ok(result.probes.every((probe) => /^MATCHED_/.test(probe.outcome)));
    assert.ok(result.captures.some((probe) => probe.name === 'base-public' && probe.payload?.ok === true));
    assert.deepEqual(result.captures.filter((probe) => probe.name.startsWith('raid')).map((probe) => [probe.name, probe.descriptorId, probe.contractId, probe.semanticFamily]), [
        ['raid-create', 'raid.create', 'raid-create-v1', 'raid-core-create-v1'],
        ['raid-condition', 'raid.condition.add', 'raid-condition-add-v1', 'raid-core-condition-add-v1'],
        ['raid-reward', 'raid.reward.add', 'raid-reward-add-v1', 'raid-core-reward-add-v1'],
    ]);
    assert.equal(result.captures.find((probe) => probe.name === 'raid-create').payload?.raid?.key, 'probe-raid');
    assert.equal(result.captures.find((probe) => probe.name === 'raid-condition').payload?.condition?.id, 1);
    assert.equal(result.captures.find((probe) => probe.name === 'raid-reward').payload?.reward?.id, 1);
    assert.equal(result.captures.find((probe) => probe.name === 'admin-bootstrap').payload?.actor?.id, 'probe-admin');
    assert.deepEqual(result.captures.find((probe) => probe.name === 'admin-policy-catalog').payload?.policies, ['atomic', 'per_target']);
});

test('F7 runtime boundary probe fails if a family target is disabled', async () => {
    const full = await runCriticalHandlerBoundaryProbes();
    const result = await runCriticalHandlerBoundaryProbes({ disableFamily: 'raid' });
    const expectedRemoved = full.probes.filter((probe) => probe.name.startsWith('raid')).length;
    assert.equal(expectedRemoved, 3);
    assert.equal(result.probed, full.probed - expectedRemoved);
    assert.equal(result.total, full.total);
    assert.equal(result.probes.filter((probe) => probe.name.startsWith('raid')).length, 0);
});
