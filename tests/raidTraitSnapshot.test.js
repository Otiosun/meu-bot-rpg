'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    enrichSnapshotNarrative,
    hasNarrativeDetails,
    isStructuredTrait,
} = require('../helpers/clover/raidTraitAwareService');

function overview() {
    return {
        slots: [{
            slotKey: 'aptidao_comum',
            value: 'Corpo de Rotina',
            source: 'catalog',
            assignment: {
                id: 88,
                traitId: 'trait-corpo-rotina',
                operationCode: 'OP-ABC123',
                assignedBy: 'admin-interno',
            },
            trait: {
                id: 'trait-corpo-rotina',
                name: 'Corpo de Rotina',
                slotKey: 'aptidao_comum',
                description: 'O corpo responde melhor quando repete uma rotina já dominada.',
                effectText: 'Recebe vantagem nas ações treinadas de forma consistente.',
                restrictionsText: 'Não se aplica a técnicas nunca praticadas.',
                status: 'active',
                version: 4,
                metadata: {
                    imageUrl: 'data:image/jpeg;base64,TRAIT_IMAGE',
                    internalAudit: 'não pode sair no snapshot público',
                },
            },
        }],
        extraTraits: [],
        extraAnomalies: [],
        hooks: [{
            title: 'A Espada Cega',
            body: 'Uma lâmina sem fio ainda aguarda a decisão de quem a carrega.',
            source: 'catalog',
        }],
        narrativeItems: [],
    };
}

test('snapshot público preserva foto, descrição, efeito e restrições', () => {
    const snapshot = enrichSnapshotNarrative({
        player: { personagem_nome: 'Artorius' },
        bonus: { traits: {} },
    }, overview());

    assert.equal(snapshot.narrative.fixedTraits.length, 1);
    assert.deepEqual(snapshot.narrative.fixedTraits[0], {
        slotKey: 'aptidao_comum',
        label: 'Aptidão Comum',
        name: 'Corpo de Rotina',
        description: 'O corpo responde melhor quando repete uma rotina já dominada.',
        effect: 'Recebe vantagem nas ações treinadas de forma consistente.',
        restrictions: 'Não se aplica a técnicas nunca praticadas.',
        rarity: 'comum',
        kind: null,
        image: 'data:image/jpeg;base64,TRAIT_IMAGE',
        source: 'catalog',
        hasDescription: true,
    });
    assert.equal(snapshot.traits, snapshot.narrative);
    assert.equal(snapshot.narrative.hooks[0].title, 'A Espada Cega');
    assert.doesNotMatch(JSON.stringify(snapshot.narrative), /OP-ABC123|admin-interno|internalAudit|trait-corpo-rotina/);
    assert.equal(hasNarrativeDetails(snapshot.narrative), true);
});

test('formato antigo apenas com nome não bloqueia reparo completo', () => {
    const partial = {
        fixedTraits: [{ label: 'Aptidão', value: 'Corpo de Rotina' }],
        extraTraits: [],
        extraAnomalies: [],
        hooks: [],
        narrativeItems: [],
    };
    assert.equal(isStructuredTrait(partial.fixedTraits[0]), false);
    assert.equal(hasNarrativeDetails(partial), false);

    const emptyButEnriched = {
        fixedTraits: [],
        extraTraits: [],
        extraAnomalies: [],
        hooks: [],
        narrativeItems: [],
    };
    assert.equal(hasNarrativeDetails(emptyButEnriched), true);
});

test('alterar o catálogo depois não modifica o objeto já congelado', () => {
    const source = overview();
    const frozen = enrichSnapshotNarrative({ bonus: { traits: {} } }, source);
    source.slots[0].trait.description = 'Descrição editada depois do início.';
    source.slots[0].trait.metadata.imageUrl = 'data:image/jpeg;base64,NOVA_IMAGEM';

    assert.equal(
        frozen.narrative.fixedTraits[0].description,
        'O corpo responde melhor quando repete uma rotina já dominada.',
    );
    assert.equal(
        frozen.narrative.fixedTraits[0].image,
        'data:image/jpeg;base64,TRAIT_IMAGE',
    );
});

test('serviço insere narrativa antes do mesmo COMMIT que inicia a Raid', () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, '../helpers/clover/raidTraitAwareService.js'),
        'utf8'
    );
    const hookPosition = source.indexOf('enrichRaidSnapshotsInTransaction');
    const commitPosition = source.indexOf('return target.exec(sql, ...args)');
    assert.ok(hookPosition >= 0);
    assert.ok(commitPosition > hookPosition);
    assert.match(source, /command === 'COMMIT'/);
    assert.match(source, /SET snapshot_json = \?/);
    assert.match(source, /onlyMissing: true/);
    assert.doesNotMatch(source, /readTraitOverviewSafe/);
    assert.match(source, /raid_trait_snapshot_incomplete/);
});
