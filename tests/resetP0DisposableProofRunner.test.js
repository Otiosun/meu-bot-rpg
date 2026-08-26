'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertCanonicalNodeVersion,
    assertSafeEnvironment,
    assertTechnicalProofSummary,
    extractSummary,
    loadCanonicalNodeVersion,
    parseArgs,
    safeChildEnv,
} = require('../scripts/runResetP0DisposableProof');

test('runner exige SHA esperado explícito e rejeita argumento desconhecido', () => {
    assert.throws(
        () => parseArgs([]),
        (error) => error?.code === 'local_proof_expected_head_required'
    );
    assert.throws(
        () => parseArgs(['--expected-head=' + 'a'.repeat(40), '--surprise=yes']),
        (error) => error?.code === 'local_proof_unknown_argument'
    );
    assert.deepEqual(
        parseArgs(['--expected-head=' + 'a'.repeat(40), '--output=C:/tmp/proof.txt']),
        { expectedHead: 'a'.repeat(40), output: 'C:/tmp/proof.txt' }
    );
});

test('runner recusa qualquer ativação destrutiva no shell e sanitiza filhos', () => {
    const dangerous = [
        'PRE_RESET_LAUNCH_ENABLED',
        'CLOVER_GLOBAL_RESET_ENABLED',
        'CLOVER_GLOBAL_RESET_RECOVER_EXECUTION',
        'CLOVER_RESET_EXECUTION_AUTHORIZED',
    ];
    for (const key of dangerous) {
        assert.throws(
            () => assertSafeEnvironment({ [key]: 'YES' }),
            (error) => error?.code === 'local_proof_unsafe_environment'
        );
    }

    const child = safeChildEnv({
        NODE_ENV: 'production',
        PRE_RESET_LAUNCH_ENABLED: 'YES',
        PRE_RESET_FRONTEND_INTEGRATED: 'YES',
        CLOVER_GLOBAL_RESET_ENABLED: 'YES',
        CLOVER_GLOBAL_RESET_OPERATION_ID: 'danger',
        CLOVER_GLOBAL_RESET_RECOVER_EXECUTION: 'YES',
        CLOVER_RESET_EXECUTION_AUTHORIZED: 'YES',
        SAFE_SENTINEL: 'kept',
    });
    assert.equal(child.NODE_ENV, 'test');
    assert.equal(child.SAFE_SENTINEL, 'kept');
    assert.equal(child.PRE_RESET_LAUNCH_ENABLED, undefined);
    assert.equal(child.PRE_RESET_FRONTEND_INTEGRATED, undefined);
    assert.equal(child.CLOVER_GLOBAL_RESET_ENABLED, undefined);
    assert.equal(child.CLOVER_GLOBAL_RESET_OPERATION_ID, undefined);
    assert.equal(child.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION, undefined);
    assert.equal(child.CLOVER_RESET_EXECUTION_AUTHORIZED, undefined);
});

test('runner aceita somente resumo técnico 14/14 mantendo reset real NO_GO', () => {
    const output = [
        'P0_PASS=14/14',
        'P0_PROGRESS_PERCENT=100',
        'PRE_RESET_MODE_DEFAULT_OFF=YES',
        'PRE_RESET_CURRENTLY_OFF=YES',
        'GLOBAL_RESET_MUTATION_SWITCH_OFF=YES',
        'ACTIVATION_AUTHORIZED=NO',
        'RESET_GO_NO_GO=NO_GO',
    ].join('\n');
    const summary = extractSummary(output);
    assert.equal(assertTechnicalProofSummary(summary), true);

    assert.throws(
        () => assertTechnicalProofSummary({ ...summary, P0_PASS: '13/14' }),
        (error) => error?.code === 'local_proof_summary_failed'
    );
    assert.throws(
        () => assertTechnicalProofSummary({ ...summary, ACTIVATION_AUTHORIZED: 'YES', RESET_GO_NO_GO: 'GO' }),
        (error) => error?.code === 'local_proof_summary_failed'
    );
});

test('runner exige exatamente a versão canônica de .node-version', () => {
    const canonical = loadCanonicalNodeVersion();
    assert.match(canonical, /^\d+\.\d+\.\d+$/);
    assert.equal(assertCanonicalNodeVersion(`v${canonical}`, canonical), true);
    assert.throws(
        () => assertCanonicalNodeVersion('v22.16.0', canonical),
        (error) => error?.code === 'local_proof_node_version_mismatch'
    );
    assert.throws(
        () => assertCanonicalNodeVersion('v99.0.0', canonical),
        (error) => error?.code === 'local_proof_node_version_mismatch'
    );
});
