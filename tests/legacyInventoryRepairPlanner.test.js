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
            proposedDescription: 'Está lacrado.',
            reason: 'Fragmento comprovado.',
            playerKey: 'P-AAAA',
        }],
        repeatedGroups: [{
            itemName: 'Anel Ampliador',
            description: 'Descrição única.',
            category: 'material',
            kind: 'acessorio',
            origin: 'Clover',
            transferable: 1,
            properties: {},
            effects: {},
            standaloneSpecification: true,
            count: 3,
            inventoryItemIds: [32, 33, 34],
            playerKeys: ['P-A', 'P-B', 'P-C'],
            generic: false,
        }],
        items: [
            {
                id: 10,
                itemName: 'Pergaminho do Ferreiro (Está lacrado,',
                description: null,
                category: 'material',
                kind: 'narrativo',
                origin: 'Clover',
                transferable: 1,
                properties: {},
                effects: {},
                classification: 'fragment',
                candidates: [],
            },
            { id: 11, itemName: 'continuação)', classification: 'fragment', candidates: [] },
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
    assert.equal(plan.summary.readyForManualApproval, 3);
    assert.equal(plan.summary.manualReview, 2);
    assert.equal(plan.summary.coveredInventoryItems, 6);
    assert.deepEqual(
        plan.readyForManualApproval.map((entry) => entry.operation),
        [
            'inventory.legacy.merge_fragments.propose',
            'inventory.template.create_and_link.propose',
            'inventory.template.link.propose',
        ]
    );
    const fragment = plan.readyForManualApproval[0];
    assert.equal(fragment.proposedTemplate.templateKey, 'pergaminho_do_ferreiro');
    assert.equal(fragment.proposedTemplate.itemName, 'Pergaminho do Ferreiro');
    assert.equal(fragment.proposedTemplate.description, 'Está lacrado.');
    assert.equal(fragment.proposedTemplate.category, 'material');
    assert.equal(fragment.proposedTemplate.kind, 'narrativo');
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
