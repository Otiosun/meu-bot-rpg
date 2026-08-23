'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { auditPreResetAuthority } = require('../scripts/auditPreResetAuthority');
const { auditPreResetAuthoritySources } = require('../helpers/clover/preResetAuthorityAudit');
const { runPreResetFoundationGate } = require('../scripts/preResetFoundationGate');

test('guard de autoridade pre-reset aprova a arvore real e rejeita misturas negativas', () => {
    assert.deepEqual(auditPreResetAuthority().blockers, []);
    const negative = auditPreResetAuthoritySources({
        character: 'UPDATE jogadores SET raca = ?',
        shop: 'INSERT INTO clover_inventory_items VALUES (?)',
        conversion: 'SELECT ph_available FROM clover_character_stats',
        returnPoints: 'SELECT * FROM clover_pr_ledger',
        access: 'return true',
    });
    assert.equal(negative.ok, false);
    assert.deepEqual([...negative.blockers].sort(), [
        'conversion_not_ledger_authority',
        'future_character_active_player_write',
        'mode_gate_not_fail_closed',
        'recruitment_pr_reference',
        'return_points_authority_invalid',
        'shop_active_character_delivery',
    ]);
});

test('gate da fundacao pre-reset exige migration, prebootstrap, discovery e guard', () => {
    const gate = runPreResetFoundationGate();
    assert.equal(gate.ok, true);
    assert.equal(gate.PRERESET_FOUNDATION_GATE, 'PASS');
});
