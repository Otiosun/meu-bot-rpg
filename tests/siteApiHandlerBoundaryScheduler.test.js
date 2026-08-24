'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const { PARALLEL_SAFE, SERIAL_REQUIRED, runBoundedProbeGroups } = __test;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('F7 bounded probe scheduler executes every group once, within its limit, in canonical result order', async () => {
    const calls = new Map();
    const group = (name, wait) => ({ name, mode: PARALLEL_SAFE, run: async () => {
        calls.set(name, (calls.get(name) || 0) + 1);
        await delay(wait);
        return [name];
    } });
    const schedule = await runBoundedProbeGroups([group('A', 30), group('B', 5), group('C', 15)], { maxConcurrency: 3 });
    assert.equal(schedule.groups, 3);
    assert.equal(schedule.executed, 3);
    assert.deepEqual(schedule.missing, []);
    assert.deepEqual(schedule.duplicated, []);
    assert.ok(schedule.maxInFlightObserved <= 3);
    assert.ok(schedule.maxInFlightObserved > 1);
    assert.deepEqual(schedule.outcomes.flatMap((outcome) => outcome.captures), ['A', 'B', 'C']);
    assert.deepEqual([...calls.values()], [1, 1, 1]);
});

test('F7 bounded probe scheduler rejects a real group failure without swallowing it', async () => {
    await assert.rejects(
        runBoundedProbeGroups([
            { name: 'good', mode: PARALLEL_SAFE, run: async () => ['good'] },
            { name: 'bad', mode: SERIAL_REQUIRED, run: async () => { throw new Error('real failure'); } },
        ]),
        /critical_probe_group_failed:bad:real failure/
    );
});

test('F7 bounded probe scheduler creates a barrier around serial-required groups', async () => {
    const events = [];
    const group = (name, mode, wait) => ({ name, mode, run: async () => {
        events.push(`${name}:start`);
        await delay(wait);
        events.push(`${name}:end`);
        return [name];
    } });
    await runBoundedProbeGroups([
        group('A', PARALLEL_SAFE, 25),
        group('B', PARALLEL_SAFE, 10),
        group('S', SERIAL_REQUIRED, 1),
        group('C', PARALLEL_SAFE, 1),
    ], { maxConcurrency: 3 });
    const index = (event) => events.indexOf(event);
    assert.ok(index('A:end') < index('S:start'));
    assert.ok(index('B:end') < index('S:start'));
    assert.ok(index('S:end') < index('C:start'));
});

function stableCaptures(captures) {
    return captures.map((capture) => ({
        name: capture.name,
        descriptorId: capture.descriptorId,
        contractId: capture.contractId,
        contractShapeId: capture.contractShapeId,
        semanticFamily: capture.semanticFamily,
        statusClass: Math.floor(capture.status / 100),
        outcome: capture.outcome,
    }));
}

test('F7 real parallel-safe smoke preserves standalone boundary metadata and fixture cleanup', async () => {
    const sourceGroups = __test.criticalProbeGroups().filter((group) => [
        'base', 'pre-reset', 'squad-canonical',
    ].includes(group.name));
    assert.equal(sourceGroups.length, 3);
    assert.ok(sourceGroups.every((group) => group.mode === PARALLEL_SAFE));
    const standalone = [];
    for (const group of sourceGroups) standalone.push(stableCaptures(await group.run()));
    const concurrent = await runBoundedProbeGroups(sourceGroups, { maxConcurrency: 3 });
    assert.equal(concurrent.executed, 3);
    assert.deepEqual(concurrent.missing, []);
    assert.deepEqual(concurrent.duplicated, []);
    assert.ok(concurrent.maxInFlightObserved > 1);
    assert.deepEqual(concurrent.outcomes.map((outcome) => stableCaptures(outcome.captures)), standalone);
});
