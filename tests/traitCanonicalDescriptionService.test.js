'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    CANONICAL_TRAIT_CATALOG,
    buildCanonicalTraitDescriptionPlan,
    catalogIntegrity,
    normalizeTraitName,
} = require('../helpers/clover/traitCanonicalDescriptionService');
const {
    looksLikeMojibake,
} = require('../scripts/diagnoseTraitDescriptionHistory');

test('catálogo canônico possui 35 nomes únicos e descritos', () => {
    const integrity = catalogIntegrity();
    assert.equal(integrity.ok, true);
    assert.equal(integrity.total, 35);
    assert.equal(integrity.uniqueNames, 35);
    assert.deepEqual(integrity.duplicates, []);
    assert.deepEqual(integrity.invalid, []);
});

test('normalização reconhece alfabeto visual sem alterar o nome salvo', () => {
    assert.equal(normalizeTraitName('Mα̃os quᥱ Trᥱmᥱm'), 'maos que tremem');
    assert.equal(normalizeTraitName('Mãos que Tremem'), 'maos que tremem');
    assert.equal(normalizeTraitName('***** Amaldiçoada'), 'amaldicoada');
});

test('plano preenche somente nome exato sem reescrever o modelo', () => {
    const plan = buildCanonicalTraitDescriptionPlan([
        {
            id: 17,
            name: 'Corpo de Rotina',
            slot_key: 'base_aptitude',
            description: null,
            effect_text: null,
            restrictions_text: null,
        },
    ]);
    assert.equal(plan.summary.plannedUpdates, 1);
    assert.equal(plan.actions[0].namePreserved, true);
    assert.equal(plan.actions[0].before.name, 'Corpo de Rotina');
    assert.equal(plan.actions[0].after.name, 'Corpo de Rotina');
    assert.match(plan.actions[0].after.description, /repetição/i);
    assert.match(plan.actions[0].after.effectText, /Força/i);
});

test('modelo já descrito é preservado por padrão', () => {
    const plan = buildCanonicalTraitDescriptionPlan([
        {
            id: 18,
            name: 'Olhar Analítico',
            description: 'Descrição já aprovada.',
        },
    ]);
    assert.equal(plan.summary.plannedUpdates, 0);
    assert.equal(plan.summary.alreadyDescribed, 1);
    assert.equal(plan.alreadyDescribed[0].template.description, 'Descrição já aprovada.');
    assert.equal(plan.alreadyDescribed[0].canonicalMatch, 'exact_normalized_name');
});

test('modelo personalizado descrito é preservado mesmo fora do catálogo', () => {
    const plan = buildCanonicalTraitDescriptionPlan([
        {
            id: 181,
            name: 'Nada Mais Óbvio que a Fome',
            description: 'Descrição pessoal aprovada.',
        },
    ]);
    assert.equal(plan.summary.plannedUpdates, 0);
    assert.equal(plan.summary.alreadyDescribed, 1);
    assert.equal(plan.summary.unmatched, 0);
    assert.equal(plan.alreadyDescribed[0].canonicalMatch, 'none');
});

test('nome genérico ou oculto vazio não recebe descrição inventada', () => {
    const plan = buildCanonicalTraitDescriptionPlan([
        { id: 19, name: '***** Amaldiçoada', description: null },
        { id: 20, name: 'Traço sem fonte', description: null },
    ]);
    assert.equal(plan.summary.plannedUpdates, 0);
    assert.equal(plan.summary.unmatched, 2);
    assert.deepEqual(
        plan.unmatched.map((entry) => entry.template.name),
        ['***** Amaldiçoada', 'Traço sem fonte']
    );
});

test('detector não confunde acento válido com mojibake', () => {
    assert.equal(looksLikeMojibake('Infância em Conserva'), false);
    assert.equal(looksLikeMojibake('Mãos Precisas'), false);
    assert.equal(looksLikeMojibake('InfÃ¢ncia em Conserva'), true);
    assert.equal(looksLikeMojibake('IntuiÃ§Ã£o Social'), true);
});

test('fonte canônica permanece identificável e não declara escrita', () => {
    const plan = buildCanonicalTraitDescriptionPlan([]);
    assert.equal(plan.mode, 'readonly_plan');
    assert.equal(plan.policy.appliesWrites, false);
    assert.equal(plan.policy.changesNames, false);
    assert.equal(
        CANONICAL_TRAIT_CATALOG.source.driveFileId,
        '1x15FjCtdaJJTolYHKz_6D_NYv87EQ4PUiEudAQ30seU'
    );
});
