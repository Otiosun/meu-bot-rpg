'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTraitDescriptionRepairPlan } = require('../helpers/clover/traitDescriptionRepairPlanner');

function template(overrides = {}) {
    return {
        id: 'TR-1',
        name: 'Traço de Teste',
        slotKey: 'aptidao_comum',
        description: null,
        candidates: [],
        ...overrides,
    };
}

test('coloca um candidato único de alta confiança em aprovação manual', () => {
    const plan = buildTraitDescriptionRepairPlan({
        templates: [template({
            candidates: [{
                source: 'catalog_sibling',
                confidence: 'high',
                reason: 'Mesma identidade canônica.',
                description: 'Descrição comprovada.',
                effect: 'Efeito comprovado.',
                restrictions: 'Restrição comprovada.',
                templateId: 'TR-2',
                sourceRef: 'clover_trait_templates:TR-2',
            }],
        })],
    });

    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.writesPerformed, false);
    assert.equal(plan.summary.readyForManualApproval, 1);
    assert.equal(plan.summary.manualReview, 0);
    assert.equal(plan.ready[0].proposedDescription, 'Descrição comprovada.');
    assert.equal(plan.ready[0].proposedEffect, 'Efeito comprovado.');
    assert.equal(plan.ready[0].proposedRestrictions, 'Restrição comprovada.');
    assert.equal(plan.ready[0].requiresManualApproval, true);
});

test('agrupa evidências idênticas sem criar propostas duplicadas', () => {
    const plan = buildTraitDescriptionRepairPlan({
        templates: [template({
            candidates: [
                {
                    source: 'catalog_sibling',
                    confidence: 'high',
                    reason: 'Mesmo modelo canônico.',
                    description: 'A mesma descrição.',
                    templateId: 'TR-2',
                    sourceRef: 'clover_trait_templates:TR-2',
                },
                {
                    source: 'historias_extras',
                    confidence: 'high',
                    reason: 'Mesmo texto em registro legado confirmado.',
                    description: '  A mesma descrição.  ',
                    playerId: 'P1',
                    sourceRef: 'jogadores.historias_extras:0',
                },
            ],
        })],
    });

    assert.equal(plan.summary.readyForManualApproval, 1);
    assert.equal(plan.ready[0].evidence.length, 2);
    assert.equal(plan.ready[0].proposedDescription, 'A mesma descrição.');
});

test('manda descrições de alta confiança conflitantes para análise manual', () => {
    const plan = buildTraitDescriptionRepairPlan({
        templates: [template({
            candidates: [
                {
                    source: 'catalog_sibling',
                    confidence: 'high',
                    reason: 'Primeira origem.',
                    description: 'Primeira versão.',
                },
                {
                    source: 'player_trait_override',
                    confidence: 'high',
                    reason: 'Segunda origem.',
                    description: 'Segunda versão incompatível.',
                },
            ],
        })],
    });

    assert.equal(plan.summary.readyForManualApproval, 0);
    assert.equal(plan.summary.manualReview, 1);
    assert.match(plan.manualReview[0].reason, /conflitantes/i);
    assert.equal(plan.manualReview[0].variants.length, 2);
});

test('não promove candidato médio para reparo automático', () => {
    const plan = buildTraitDescriptionRepairPlan({
        templates: [template({
            candidates: [{
                source: 'historias_extras',
                confidence: 'medium',
                reason: 'Mesmo nome e categoria.',
                description: 'Descrição plausível, mas não comprovada.',
            }],
        })],
    });

    assert.equal(plan.summary.readyForManualApproval, 0);
    assert.equal(plan.summary.manualReview, 1);
    assert.match(plan.manualReview[0].reason, /nenhum candidato de alta confiança/i);
});

test('ignora modelo já descrito e registro sem identidade suficiente', () => {
    const plan = buildTraitDescriptionRepairPlan({
        templates: [
            template({ description: 'Já existe.' }),
            template({ id: null, name: null }),
        ],
    });

    assert.equal(plan.summary.readyForManualApproval, 0);
    assert.equal(plan.summary.manualReview, 0);
    assert.equal(plan.summary.skipped, 2);
});
