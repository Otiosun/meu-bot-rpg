'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assignmentGrantsIntegratedPermission,
    contextCanAnywhere,
} = require('../helpers/clover/integratedAccessContextService');
const {
    PRE_RESET_ADMIN_LEVEL_EQUIVALENCE,
    canReviewPreResetAppearance,
    resolvePreResetAdminLevel,
} = require('../helpers/clover/preResetAdminAuthority');

const REVIEW_CAPABILITY = 'prereset.review';

function canonicalAssignment(roleKey) {
    return {
        source:'canonical_role_grant',
        role_key:roleKey,
        scope_type:'global',
        scope_key:'*',
    };
}

test('F11: equivalencia canonica fixa ADM 3=admin global e ADM 4=owner', () => {
    assert.deepEqual(PRE_RESET_ADMIN_LEVEL_EQUIVALENCE, { 3:'admin', 4:'owner' });
});

test('F11: ADM nivel 4 owner possui review PRE_RESET em qualquer superficie', () => {
    const context = { owner:true, assignments:[] };
    assert.equal(resolvePreResetAdminLevel(context), 4);
    assert.equal(contextCanAnywhere(context, REVIEW_CAPABILITY), true);
    assert.equal(canReviewPreResetAppearance(context), true);
});

test('F11: ADM nivel 3 admin global recebe review PRE_RESET pelo wildcard integrado', () => {
    const assignment = canonicalAssignment('admin');
    const context = { owner:false, assignments:[assignment] };
    assert.equal(assignmentGrantsIntegratedPermission(assignment, REVIEW_CAPABILITY), true);
    assert.equal(contextCanAnywhere(context, REVIEW_CAPABILITY), true);
    assert.equal(resolvePreResetAdminLevel(context), 3);
    assert.equal(canReviewPreResetAppearance(context), true);
});

test('F11: cargo sem autoridade ADM 3/4 nao ganha review PRE_RESET por acidente', () => {
    for (const roleKey of ['assistant','captain','vice_captain','evaluator','narrator']) {
        const assignment = canonicalAssignment(roleKey);
        const context = { owner:false, assignments:[assignment] };
        assert.equal(resolvePreResetAdminLevel(context), null, roleKey);
        assert.equal(canReviewPreResetAppearance(context), false, roleKey);
    }
});
