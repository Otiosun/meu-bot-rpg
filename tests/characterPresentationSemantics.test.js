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

test('separa capacidade adquirida, desbloqueio pendente, limite real e supervisão', () => {
    const sources = baseSources({
        capacity: {
            limits: {
                alcanceLabel: '3 m',
                duracaoLabel: 'instantâneo ou até 1 ciclo',
                controleLabel: 'simples e direto',
                precisaoLabel: 'grosseira',
                estabilidadeLabel: 'frágil a perturbação',
                escalaLabel: 'objeto ou alvo pequeno',
            },
            creation: {
                can: [],
                buffs: [],
                cannot: [
                    'formas criadas; precisa comprar Criação',
                    'controle estável da manifestação criada',
                ],
            },
            reinforcement: {
                can: [],
                cannot: ['autobuff pela rota Invencível'],
            },
            mana: {
                can: [],
                cannot: [
                    'Bala de Mana',
                    'técnicas de Mana compradas',
                    'efeitos especiais que pertencem ao tipo de magia, Criação ou Reforço',
                    'aprovar técnica automaticamente; o ADM ainda decide com ficha, Hexágono e cena',
                ],
            },
            physical: {
                can: [],
                buffs: [],
                cannot: [
                    'progressão física comprada; precisa comprar Físico',
                    'Ki livre; o topo exige requisitos, treino e aprovação narrativa',
                    'Zetten livre; exige Ki, Força Aplicada III, Precisão Técnica III e aprovação narrativa',
                    'Estilo de Luta, arma específica ou golpe personalizado; isso será sistema separado',
                    'bônus físico em magia criada, projétil mágico, mana pura, Reforço mágico, cura ou antimagia',
                ],
            },
            support: {
                ownedNames: ['Suporte', 'Benção', 'Buff'],
                warning: 'Suporte possui nós registrados.',
            },
            treeSummaries: {
                suporte: { count: 3, names: ['Suporte', 'Benção', 'Buff'] },
            },
            approvalNodes: ['Árvore de Suporte: Buff (alto | approval)'],
            highRiskNodes: ['Árvore de Suporte: Buff (alto)'],
        },
    });

    const presentation = buildCharacterPresentation(sources, { audience: 'player' });
    const capabilities = presentation.capabilities;
    const serialized = JSON.stringify(capabilities);

    assert.deepEqual(capabilities.practicalAbilities, ['Suporte: Benção']);
    assert.ok(capabilities.unlockRequirements.includes('Criação: comprar a base da Árvore de Criação'));
    assert.ok(capabilities.unlockRequirements.includes('Reforço: autobuff pela rota Invencível'));
    assert.ok(capabilities.unlockRequirements.includes('Mana: Bala de Mana'));
    assert.ok(capabilities.unlockRequirements.includes('Físico: comprar a base da Árvore Física'));
    assert.ok(capabilities.unlockRequirements.some((item) => item.includes('uso de Ki exige requisitos')));
    assert.ok(!capabilities.unlockRequirements.some((item) => item.includes('técnicas de Mana compradas')));

    assert.ok(capabilities.currentLimits.includes('Alcance comum: 3 m.'));
    assert.ok(capabilities.currentLimits.some((item) => item.includes('bônus físicos não se aplicam')));
    assert.ok(capabilities.currentLimits.some((item) => item.includes('efeitos especiais continuam vinculados')));
    assert.ok(!capabilities.currentLimits.some((item) => item.includes('Bala de Mana')));

    assert.ok(capabilities.supervisionWarnings.some((item) => item.includes('o ADM ainda decide')));
    assert.ok(capabilities.supervisionWarnings.includes('Suporte: Buff: uso de alto risco e sujeito à decisão narrativa.'));
    assert.equal(capabilities.supervisionWarnings.filter((item) => item.includes('Suporte: Buff')).length, 1);

    assert.doesNotMatch(serialized, /isso será sistema separado/);
});
