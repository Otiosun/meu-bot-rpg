'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildCharacterPresentation,
} = require('../helpers/clover/characterPresentationService');

function baseSources(overrides = {}) {
    return {
        player: {
            personagem_nome: 'Killian de Teste',
            familia: '-',
        },
        bonus: {
            identity: { name: 'Killian de Teste' },
            family: {
                key: 'sem_linhagem',
                label: 'Sem linhagem registrada',
                details: { summary: null },
                notes: [],
            },
            automatic: [],
            notAutomatic: [],
            customBonuses: [],
            treeDiscounts: {},
            warnings: [],
            traits: {},
        },
        capacity: {},
        traits: {
            slots: [],
            extraTraits: [],
            extraAnomalies: [],
            hooks: [],
            narrativeItems: [],
            bonuses: [],
        },
        ...overrides,
    };
}

test('trata mensagens naturais de ausência como ausência real', () => {
    const sources = baseSources();
    sources.traits.hooks = [{
        title: 'Nenhum gancho narrativo registrado.',
        body: 'Detalhes narrativos ainda não cadastrados.',
        source: 'legacy',
    }];
    sources.bonus.traits = {
        anomaly: { label: 'Nenhuma anomalia cadastrada' },
        hook: 'Não informado',
    };

    const presentation = buildCharacterPresentation(sources, { audience: 'player' });

    assert.equal(presentation.identity.family, null);
    assert.deepEqual(presentation.narrative.hooks, []);
    assert.deepEqual(presentation.narrative.fixedTraits, []);
});

test('separa benefício recorrente, afinidade narrativa e condição de cena', () => {
    const sources = baseSources();
    sources.bonus.notAutomatic = [
        'Salário semanal de 800¥.',
        'Afinidade narrativa com runas, cura, mana natural e suporte.',
        'Recebe +10% quando protege um aliado ferido.',
        'Bônus de família e traços não entram automaticamente nos números.',
    ];

    const presentation = buildCharacterPresentation(sources, { audience: 'player' });

    assert.equal(presentation.modifiers.recurring.length, 1);
    assert.match(presentation.modifiers.recurring[0].effect, /Salário semanal/);
    assert.equal(presentation.modifiers.recurring[0].source, 'Benefício recorrente');

    assert.equal(presentation.modifiers.narrative.length, 1);
    assert.match(presentation.modifiers.narrative[0].effect, /Afinidade narrativa/);
    assert.equal(presentation.modifiers.narrative[0].source, 'Afinidade narrativa');

    assert.equal(presentation.modifiers.conditional.length, 1);
    assert.match(presentation.modifiers.conditional[0].effect, /protege um aliado/);

    assert.equal(presentation.modifiers.notices.length, 1);
    assert.equal(presentation.modifiers.notices[0].source, 'Regra do sistema');
});

test('avisos do sistema nunca preservam origem de bônus condicionado', () => {
    const sources = baseSources();
    sources.bonus.notAutomatic = [
        {
            description: 'Descontos de árvore entram automaticamente no custo da compra.',
            source: 'Bônus condicionado',
        },
    ];

    const presentation = buildCharacterPresentation(sources, { audience: 'narrator' });

    assert.equal(presentation.modifiers.notices.length, 1);
    assert.equal(presentation.modifiers.notices[0].source, 'Regra do sistema');
    assert.equal(presentation.modifiers.conditional.length, 0);
});
