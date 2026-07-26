'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLegacyInventoryRepairPlan } = require('../helpers/clover/legacyInventoryRepairPlanner');

test('gera propostas sem aplicar e preserva casos ambíguos para revisão', () => {
    const report = {
        fragmentPairs: [{
            confidence: 'high',
            inventoryItemIds: [10, 11],
            keepInventoryItemId: 10,
            removeInventoryItemId: 11,
            proposedItemName: 'Pergaminho do Ferreiro',
            proposedDescription: 'Regra preservada como descrição.',
            reason: 'Fragmento comprovado.',
            playerKey: 'P-AAAA',
        }],
        repeatedGroups: [{
            itemName: 'Anel Ampliador',
            description: 'Descrição suficientemente completa para um modelo próprio.',
            category: 'material',
            kind: 'acessorio',
            origin: 'Clover',
            transferable: 1,
            properties: {},
            effects: {},
            count: 3,
            inventoryItemIds: [32, 33, 34],
            playerKeys: ['P-A', 'P-B', 'P-C'],
            generic: false,
            standaloneSpecification: true,
        }],
        items: [
            { id: 10, itemName: 'Pergaminho (', classification: 'fragment', candidates: [] },
            { id: 11, itemName: 'final)', classification: 'fragment', candidates: [] },
            { id: 32, itemName: 'Anel Ampliador', classification: 'repeated_consistent_item', candidates: [] },
            { id: 33, itemName: 'Anel Ampliador', classification: 'repeated_consistent_item', candidates: [] },
            { id: 34, itemName: 'Anel Ampliador', classification: 'repeated_consistent_item', candidates: [] },
            {
                id: 57,
                itemName: 'Item Oficial',
                classification: 'existing_template_high',
                candidates: [{ confidence: 'high', templateKey: 'item_oficial' }],
            },
            {
                id: 58,
                itemName: 'Poção de Mana Simples',
                description: 'Consumível comum com uma regra própria completamente cadastrada.',
                category: 'consumivel',
                kind: 'consumivel_comum',
                origin: 'Clover',
                transferable: 1,
                properties: {},
                effects: {},
                classification: 'standalone_model_candidate',
                candidates: [{ confidence: 'medium', templateKey: 'pocao_mana' }],
                playerKey: 'P-POTION',
                source: 'pa_box',
            },
            {
                id: 4,
                itemName: 'Feitiço',
                generic: true,
                classification: 'manual_specification',
                candidates: [],
            },
            {
                id: 2,
                itemName: 'Dungeon exclusiva',
                classification: 'existing_template_review',
                candidates: [{ confidence: 'medium', templateKey: 'acesso_dungeon_exclusiva' }],
            },
        ],
    };

    const plan = buildLegacyInventoryRepairPlan(report);

    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.writesPerformed, false);
    assert.equal(plan.summary.readyForManualApproval, 4);
    assert.equal(plan.summary.manualReview, 2);
    assert.equal(plan.summary.coveredInventoryItems, 7);
    assert.deepEqual(
        plan.readyForManualApproval.map((entry) => entry.operation),
        [
            'inventory.legacy.merge_fragments.propose',
            'inventory.template.create_and_link.propose',
            'inventory.template.link.propose',
            'inventory.template.create_and_link.propose',
        ]
    );
    const potion = plan.readyForManualApproval.find((entry) => entry.inventoryItemIds.includes(58));
    assert.equal(potion.proposedTemplate.templateKey, 'pocao_de_mana_simples');
    assert.equal(potion.evidence.rejectedSimilarTemplates[0].templateKey, 'pocao_mana');
    assert.equal(plan.manualReview.some((entry) => entry.itemName === 'Feitiço'), true);
    assert.equal(plan.manualReview.some((entry) => entry.itemName === 'Dungeon exclusiva'), true);
    assert.equal(plan.readyForManualApproval.every((entry) => entry.requiresManualApproval), true);
});

test('não propõe criação de modelo para repetição genérica', () => {
    const plan = buildLegacyInventoryRepairPlan({
        fragmentPairs: [],
        repeatedGroups: [{
            itemName: 'Item mágico',
            count: 4,
            inventoryItemIds: [1, 2, 3, 4],
            generic: true,
            standaloneSpecification: false,
        }],
        items: [1, 2, 3, 4].map((id) => ({
            id,
            itemName: 'Item mágico',
            generic: true,
            classification: 'manual_specification',
            candidates: [],
        })),
    });

    assert.equal(plan.summary.readyForManualApproval, 0);
    assert.equal(plan.summary.manualReview, 4);
});
