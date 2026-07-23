'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PRESENTATION_COMPARISON_VERSION,
    buildCharacterPresentation,
    buildCharacterPresentationComparison,
} = require('../helpers/clover/characterPresentationService');

const rich = require('./fixtures/characterPresentation/catalog-rich.json');
const legacy = require('./fixtures/characterPresentation/legacy-fragmented.json');

function serialized(value) {
    return JSON.stringify(value);
}

test('compara a prévia com as fontes antigas sem devolver conteúdo bruto', () => {
    const presentation = buildCharacterPresentation(rich, {
        audience: 'player',
        generatedAt: '2026-07-23T04:00:00.000Z',
    });
    const comparison = buildCharacterPresentationComparison(rich, presentation);

    assert.equal(comparison.version, PRESENTATION_COMPARISON_VERSION);
    assert.equal(comparison.readOnly, true);
    assert.equal(comparison.legacyEndpoint, '/character');
    assert.equal(comparison.previewEndpoint, '/character/presentation-preview');
    assert.deepEqual(comparison.aligned, {
        identityName: true,
        familyName: true,
        stage: true,
        manaTotal: true,
        fixedTraits: true,
    });
    assert.deepEqual(comparison.sourceRisks, {
        structuredFamilyObject: true,
        technicalCapacityEmbedded: true,
        mixedSystemNotices: true,
    });
    assert.equal(comparison.counts.fixedTraits, 2);
    assert.equal(comparison.counts.extraTraits, 1);
    assert.equal(comparison.counts.extraAnomalies, 1);
    assert.equal(comparison.counts.hooks, 1);

    const output = serialized(comparison);
    assert.doesNotMatch(output, /ANON-RICH|OP-INTERNAL|SHOULD-NOT-LEAK|TR-INTERNAL/);
    assert.doesNotMatch(output, /flags|weights|stage_key|updated_by/);
});

test('divergência aparece como diagnóstico booleano sem vazar o valor conflitante', () => {
    const presentation = buildCharacterPresentation(legacy, { audience: 'player' });
    const changed = {
        ...legacy,
        capacity: {
            ...legacy.capacity,
            stageName: 'ESTÁGIO-INTERNO-DIVERGENTE',
        },
    };
    const comparison = buildCharacterPresentationComparison(changed, presentation);

    assert.equal(comparison.aligned.stage, false);
    assert.doesNotMatch(serialized(comparison), /ESTÁGIO-INTERNO-DIVERGENTE/);
});
