'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ACTION_CAPABILITIES,
    requiredCapabilitiesForActions,
} = require('../helpers/clover/adminOperationContract');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const { previewWithRollback } = require('../helpers/clover/adminDreamWorldOperationService');

const DREAM_ACTIONS = [
    'system.dream_world.create',
    'system.dream_world.acquisition.update',
    'system.dream_world.status.transition',
    'system.dream_request.approve',
    'system.dream_request.reject',
    'system.dream_application.review',
    'system.dream_application.select',
    'system.dream_application.reject',
    'system.dream_run.transition',
    'system.dream_slot.assign',
    'system.dream_slot.remove',
    'system.dream_slot.replace',
    'system.dream_fragment.create',
    'system.dream_fragment.update',
    'system.dream_fragment.grant',
];

test('Dream Worlds action family is fully executable through OP registry', () => {
    const registry = getAdminOperationExecutors();
    for (const type of DREAM_ACTIONS) {
        assert.equal(typeof registry[type]?.preview, 'function', type + ': preview');
        assert.equal(typeof registry[type]?.apply, 'function', type + ': apply');
    }
});

test('Dream request approval preserves dual capability requirement', () => {
    assert.deepEqual(
        ACTION_CAPABILITIES['system.dream_request.approve'],
        ['raid.manage', 'resource.adjust']
    );
    assert.deepEqual(
        requiredCapabilitiesForActions([{ type: 'system.dream_request.approve' }]).sort(),
        ['raid.manage', 'resource.adjust']
    );
});

test('Dream preview savepoint rolls the mutation back', async () => {
    const log = [];
    let value = 10;
    const db = {
        async exec(sql) {
            log.push(sql);
            if (sql.startsWith('ROLLBACK TO ')) value = 10;
        },
    };
    const result = await previewWithRollback(
        db,
        async () => ({ value }),
        async () => { value = 99; return { value }; },
        async () => ({ value })
    );
    assert.deepEqual(result.before, { value: 10 });
    assert.deepEqual(result.after, { value: 99 });
    assert.equal(value, 10);
    assert.ok(log.some((sql) => sql.startsWith('SAVEPOINT admin_dream_preview_')));
    assert.ok(log.some((sql) => sql.startsWith('ROLLBACK TO admin_dream_preview_')));
    assert.ok(log.some((sql) => sql.startsWith('RELEASE admin_dream_preview_')));
});
