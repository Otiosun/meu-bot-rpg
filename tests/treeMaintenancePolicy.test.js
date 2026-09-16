'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    TREES_MAINTENANCE_MESSAGE,
    getTreeMutationBlock,
} = require('../helpers/clover/treeMaintenancePolicy');
const { buyNode, createPendingPurchase } = require('../helpers/clover/skillTreeService');
const { approveSkillApproval, requestSkillApproval } = require('../helpers/clover/skillApprovalService');

test('maintenance ON bloqueia apenas mutacoes novas', () => {
    const result = getTreeMutationBlock({ maintenanceMode: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'trees_maintenance');
    assert.match(result.message, /Capacidades já adquiridas continuam válidas/i);
    assert.equal(result.message, TREES_MAINTENANCE_MESSAGE);
});

test('maintenance OFF restaura o fluxo anterior', () => {
    assert.equal(getTreeMutationBlock({ maintenanceMode: false }), null);
});

test('servico central bloqueia compra direta e pendente antes de escrever', async () => {
    assert.equal((await buyNode(null, 'p', 'mana', 'mana', 'p')).reason, 'trees_maintenance');
    assert.equal((await createPendingPurchase(null, 'p', 'mana', 'mana', 'p')).reason, 'trees_maintenance');
    assert.equal((await buyNode(null, 'p', 'arvore_inexistente', 'x', 'p', { maintenanceMode: false })).reason, 'tree_not_found');
    await assert.rejects(() => requestSkillApproval(null, 'p', 'mana', 'mana'), { code: 'trees_maintenance' });
    await assert.rejects(() => approveSkillApproval(null, 'request', 'admin'), { code: 'trees_maintenance' });
});
