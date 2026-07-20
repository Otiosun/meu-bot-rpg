'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRepairPlan,
    classifyIssue,
    renderMarkdown,
} = require('../helpers/clover/playerDataRepairPlanner');

test('ganchos ausentes ficam fora da fila de corrupção', () => {
    const report = {
        generatedAt: '2026-07-20T18:18:59.872Z',
        database: 'banco.sqlite',
        summary: {},
        issues: [{
            severity: 'review',
            category: 'narrative_hook',
            code: 'hook_missing',
            playerId: '1@lid',
            characterName: 'Sem Gancho',
            field: 'gancho_narrativo',
            current: '-',
        }],
    };
    const plan = buildRepairPlan(report);
    assert.equal(plan.summary.originalIssues, 1);
    assert.equal(plan.summary.optionalReviewsExcluded, 1);
    assert.equal(plan.summary.actionableIssues, 0);
    assert.equal(plan.summary.actionablePlayers, 0);
    assert.equal(plan.summary.automaticRepairs, 0);
});

test('relatório real é reduzido de 79 para 24 apontamentos acionáveis', () => {
    const issues = [];
    for (let index = 0; index < 55; index += 1) {
        issues.push({
            code: 'hook_missing',
            playerId: `optional-${index}`,
            characterName: `Opcional ${index}`,
        });
    }
    for (let index = 0; index < 24; index += 1) {
        issues.push({
            code: 'profile_required_missing',
            playerId: `action-${index % 17}`,
            characterName: `Ação ${index % 17}`,
            field: 'classe',
            current: 'N/A',
        });
    }
    const plan = buildRepairPlan({ issues });
    assert.equal(plan.summary.originalIssues, 79);
    assert.equal(plan.summary.optionalReviewsExcluded, 55);
    assert.equal(plan.summary.actionableIssues, 24);
    assert.equal(plan.summary.actionablePlayers, 17);
});

test('mapeamentos legados são apenas candidatos e nunca correções automáticas', () => {
    for (const [legacy, canonical] of [
        ['fisico_root', 'fisico'],
        ['vigor_base', 'vigor'],
        ['controle_corporal_base', 'controle_corporal'],
    ]) {
        const result = classifyIssue({ code: 'legacy_node_unknown', current: legacy });
        assert.equal(result.bucket, 'legacy_mapping_candidate');
        assert.equal(result.suggestedValue, canonical);
        assert.equal(result.automatic, false);
    }
});

test('substituições textuais conhecidas ainda exigem conferência de fonte', () => {
    const result = classifyIssue({
        code: 'trait_text_encoding',
        characterName: 'Elizabeth',
        field: 'aptidao_comum',
        current: 'Olhar Anal?tico',
    });
    assert.equal(result.bucket, 'text_candidate_high_confidence');
    assert.equal(result.suggestedValue, 'Olhar Analítico');
    assert.equal(result.automatic, false);
});

test('markdown apresenta jogadores acionáveis e explica revisões opcionais', () => {
    const plan = buildRepairPlan({
        issues: [
            {
                code: 'profile_required_missing',
                playerId: '1@lid',
                characterName: 'Eris',
                field: 'classe',
                current: 'N/A',
            },
            {
                code: 'hook_missing',
                playerId: '2@lid',
                characterName: 'Sem Gancho',
                field: 'gancho_narrativo',
                current: '-',
            },
        ],
    });
    const markdown = renderMarkdown(plan);
    assert.match(markdown, /### Eris/);
    assert.match(markdown, /Revisões opcionais fora da fila/);
    assert.match(markdown, /não altera o SQLite/i);
});
