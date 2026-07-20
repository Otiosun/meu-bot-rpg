'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    assertExpectedCounts,
    isQueueIdle,
} = require('../scripts/finishCanonicalBatch1');

test('fila só é considerada livre quando o health está online e sem atividade', () => {
    assert.equal(isQueueIdle({ ok: true, queue: { depth: 0, active: false } }), true);
    assert.equal(isQueueIdle({ ok: false, queue: { depth: 0, active: false } }), false);
    assert.equal(isQueueIdle({ ok: true, queue: { depth: 1, active: false } }), false);
    assert.equal(isQueueIdle({ ok: true, queue: { depth: 0, active: true } }), false);
    assert.equal(isQueueIdle(null), false);
});

test('contagens finais aceitam exatamente 22 registros e os dois conteúdos de Vitor', () => {
    assert.doesNotThrow(() => assertExpectedCounts({
        totals: [
            { content_type: 'custom_trait', total: 7 },
            { content_type: 'narrative_hook', total: 4 },
            { content_type: 'narrative_item', total: 2 },
            { content_type: 'system_trait', total: 9 },
        ],
        overall: { total: 22 },
        vitor: [
            { content_type: 'system_trait', content_key: 'cria_da_fronteira' },
            { content_type: 'narrative_hook', content_key: 'divida_da_montanha' },
        ],
        pending: { total: 7 },
        linked: { total: 2 },
    }));
});

test('contagens divergentes são bloqueadas', () => {
    assert.throws(() => assertExpectedCounts({
        totals: [
            { content_type: 'custom_trait', total: 7 },
            { content_type: 'narrative_hook', total: 3 },
            { content_type: 'narrative_item', total: 2 },
            { content_type: 'system_trait', total: 9 },
        ],
        overall: { total: 21 },
        vitor: [
            { content_type: 'system_trait', content_key: 'cria_da_fronteira' },
            { content_type: 'narrative_hook', content_key: 'divida_da_montanha' },
        ],
        pending: { total: 7 },
        linked: { total: 2 },
    }), /22/);
});
