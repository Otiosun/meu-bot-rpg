'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ADMIN_CAPABILITIES,
    ADMIN_ROLES,
    getRoleCapabilities,
} = require('../helpers/clover/adminOperationContract');

test('evaluator bootstrap exposes raid reward review without granting raid view', () => {
    const evaluator = new Set(getRoleCapabilities(ADMIN_ROLES.EVALUATOR));
    assert.equal(ADMIN_CAPABILITIES.RAID_REWARD_REVIEW, 'raid.reward.review');
    assert.equal(evaluator.has(ADMIN_CAPABILITIES.RAID_REWARD_REVIEW), true);
    assert.equal(evaluator.has(ADMIN_CAPABILITIES.RAID_VIEW), false);
});

test('admin bootstrap also exposes raid reward review', () => {
    const admin = new Set(getRoleCapabilities(ADMIN_ROLES.ADMIN));
    assert.equal(admin.has(ADMIN_CAPABILITIES.RAID_REWARD_REVIEW), true);
});
