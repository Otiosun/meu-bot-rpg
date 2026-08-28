'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assignmentGrantsIntegratedPermission,
    contextCanAnywhere,
} = require('../helpers/clover/integratedAccessContextService');

const REVIEW_CAPABILITY = 'prereset.review';

function canonicalAssignment(roleKey) {
    return {
        source:'canonical_role_grant',
        role_key:roleKey,
        scope_type:'global',
        scope_key:'*',
    };
}

test('F11: owner possui review PRE_RESET em qualquer superficie', () => {
    assert.equal(contextCanAnywhere({ owner:true, assignments:[] }, REVIEW_CAPABILITY), true);
});

test('F11: admin canonico recebe review PRE_RESET pelo wildcard integrado', () => {
    const assignment = canonicalAssignment('admin');
    assert.equal(assignmentGrantsIntegratedPermission(assignment, REVIEW_CAPABILITY), true);
    assert.equal(contextCanAnywhere({ owner:false, assignments:[assignment] }, REVIEW_CAPABILITY), true);
});

test('F11: cargo sem autoridade administrativa nao ganha review PRE_RESET por acidente', () => {
    for (const roleKey of ['assistant','captain','vice_captain']) {
        const assignment = canonicalAssignment(roleKey);
        assert.equal(assignmentGrantsIntegratedPermission(assignment, REVIEW_CAPABILITY), false, roleKey);
    }
});
