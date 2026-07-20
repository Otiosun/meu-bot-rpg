'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    loadVitorRecords,
    selectResumeMode,
} = require('../scripts/finalizeCanonicalBatch1Resume');

const manifest = path.resolve(__dirname, '..', 'data', 'player-canonical-batch-1-import.json');

test('carrega exatamente os dois registros oficiais de Vitor', () => {
    const records = loadVitorRecords(manifest);
    assert.equal(records.length, 2);
    assert.deepEqual(
        records.map((record) => `${record.contentType}:${record.contentKey}`).sort(),
        [
            'narrative_hook:divida_da_montanha',
            'system_trait:cria_da_fronteira',
        ]
    );
    assert.ok(records.every((record) => record.playerId === '119516088528998@lid'));
});

test('aceita somente o estado comprovado 20 + Vitor ausente', () => {
    assert.equal(selectResumeMode({
        total: 20,
        vitor: 0,
        byType: {
            system_trait: 8,
            custom_trait: 7,
            narrative_hook: 3,
            narrative_item: 2,
        },
    }), 'insert_vitor');
});

test('após 22 registros executa apenas verificação', () => {
    assert.equal(selectResumeMode({ total: 22, vitor: 2, byType: {} }), 'verify_only');
});

test('qualquer estado divergente é recusado', () => {
    assert.throws(() => selectResumeMode({
        total: 21,
        vitor: 1,
        byType: {
            system_trait: 9,
            custom_trait: 7,
            narrative_hook: 3,
            narrative_item: 2,
        },
    }), /Estado canônico inesperado/);
});
