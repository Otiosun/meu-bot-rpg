'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { conversionFor } = require('../scripts/previewPreResetLaunchReadOnly');

const approvedPolicy = {
    status:'approved',
    policy_version:'TEST_ONLY_1_TO_1',
    numerator:1,
    denominator:1,
    rounding:'floor',
};

function positiveClaim(overrides = {}) {
    return {
        policy_version:'TEST_ONLY_1_TO_1',
        source_pr_balance:10,
        pv_before:7,
        calculated_pv:10,
        operation_key:'pr-pv:test',
        ...overrides,
    };
}

test('claim positivo exige policy aprovada e valida ainda presente', () => {
    const result = conversionFor(0,17,{ status:'pending' },positiveClaim());
    assert.equal(result.status,'claim_inconsistent');
    assert.ok(result.reviewIssues.includes('conversion_claim_policy_missing_or_invalid'));
});

test('claim positivo exige a mesma policy_version imutavel', () => {
    const result = conversionFor(0,17,{
        ...approvedPolicy,
        policy_version:'OTHER_POLICY_V2',
    },positiveClaim());
    assert.equal(result.status,'claim_inconsistent');
    assert.ok(result.reviewIssues.includes('conversion_claim_policy_version_mismatch'));
});

test('claim positivo precisa reproduzir exatamente o calculo da policy', () => {
    const result = conversionFor(0,16,approvedPolicy,positiveClaim({ calculated_pv:9 }));
    assert.equal(result.status,'claim_inconsistent');
    assert.ok(result.reviewIssues.includes('conversion_claim_calculation_mismatch'));
});

test('claim sem PR legado continua valido sem depender de policy posterior', () => {
    const result = conversionFor(0,7,{ status:'pending' },{
        policy_version:'no-pr',
        source_pr_balance:0,
        pv_before:7,
        calculated_pv:0,
        operation_key:'pr-pv:no-pr',
    });
    assert.equal(result.status,'claimed');
    assert.deepEqual(result.reviewIssues,[]);
    assert.equal(result.convertedPv,0);
    assert.equal(result.resultingPv,7);
});