'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    parseReturnShopFulfillmentAction,
    parseReturnShopSelfFinalizationAction,
    renderHistory,
    renderReturnShopFulfillmentResult,
    renderReturnShopSelfFinalizationResult,
    renderSummary,
} = require('../comandos/pr');

test('renderSummary mostra apenas saldo de PR e aponta extrato para detalhes', () => {
    const text = renderSummary({
        balance: 42,
        shopEnabled: true,
    });

    assert.match(text, /42 PR/);
    assert.match(text, /extrato/i);
    assert.doesNotMatch(text, /lojadivulga/i);
    assert.doesNotMatch(text, /\*Loja:\*/i);
    assert.doesNotMatch(text, /Grupos informados/i);
    assert.doesNotMatch(text, /Grupos remunerados/i);
    assert.doesNotMatch(text, /PR por grupos/i);
});

test('renderHistory mostra origem dos lancamentos quando player pede extrato', () => {
    const text = renderHistory([
        {
            amount: 120,
            kind: 'ajuste_admin',
            source: 'ajuste_admin',
            reason: 'Conversao final de PH e PA para PR antes do reset',
            created_at: '2026-08-31 07:00:00',
        },
        {
            amount: -5,
            kind: 'gasto',
            source: 'loja',
            reason: 'Compra Loja PR',
            created_at: '2026-08-31 07:05:00',
        },
    ]);

    assert.match(text, /Extrato/i);
    assert.match(text, /\+120 PR/);
    assert.match(text, /ajuste_admin/);
    assert.match(text, /-5 PR/);
    assert.match(text, /loja/);
});

test('parseReturnShopFulfillmentAction reconhece revisao e cumprimento por mencao', () => {
    const preview = parseReturnShopFulfillmentAction('revisar loja @player', {
        mentionedJid: ['player@lid'],
    });
    assert.equal(preview.type, 'fulfillment');
    assert.equal(preview.apply, false);
    assert.equal(preview.targetId, 'player@lid');

    const apply = parseReturnShopFulfillmentAction('cumprir loja @player', {
        mentionedJid: ['player@lid'],
    });
    assert.equal(apply.type, 'fulfillment');
    assert.equal(apply.apply, true);
    assert.equal(apply.targetId, 'player@lid');
});

test('parseReturnShopSelfFinalizationAction reconhece apenas a confirmacao do proprio player', () => {
    assert.deepEqual(
        parseReturnShopSelfFinalizationAction('finalizar compras'),
        { type: 'self_fulfillment' }
    );
    assert.deepEqual(
        parseReturnShopSelfFinalizationAction('confirmar loja'),
        { type: 'self_fulfillment' }
    );
    assert.deepEqual(
        parseReturnShopSelfFinalizationAction('finalizar compras @player'),
        { type: 'none' }
    );
});

test('renderReturnShopFulfillmentResult resume cumpridas e pendencias', () => {
    const text = renderReturnShopFulfillmentResult({
        fulfilled: [
            { label: 'Reino Clover + Elfo', targetRollNumber: 2 },
        ],
        pendingAssignment: [
            { label: 'Grimorio de 4 Folhas' },
        ],
        pendingCharacter: [
            { label: 'Caixa Real' },
        ],
        blocked: [],
        applied: true,
    }, {
        personagem_nome: 'Sofia',
        id: 'player@lid',
    });

    assert.match(text, /Sofia/);
    assert.match(text, /Reino Clover \+ Elfo/);
    assert.match(text, /roll #2/i);
    assert.match(text, /sem roll/i);
    assert.match(text, /proximo personagem/i);
});

test('renderReturnShopSelfFinalizationResult bloqueia aplicacao parcial e orienta o player', () => {
    const pending = renderReturnShopSelfFinalizationResult({
        fulfilled: [],
        ready: [{ label: 'Reino Clover', targetRollNumber: 2 }],
        pendingAssignment: [{ label: 'Grimorio de 4 Folhas' }],
        pendingCharacter: [{ label: 'Caixa Real' }],
        blocked: [],
        applied: false,
        incomplete: true,
    });

    assert.match(pending, /nada foi aplicado/i);
    assert.match(pending, /Grimorio de 4 Folhas/);
    assert.match(pending, /pr compras/i);

    const applied = renderReturnShopSelfFinalizationResult({
        fulfilled: [{ label: 'Reino Clover', targetRollNumber: 2 }],
        ready: [],
        pendingAssignment: [],
        pendingCharacter: [{ label: 'Caixa Real' }],
        blocked: [],
        applied: true,
        complete: true,
    });

    assert.match(applied, /compras aplicadas/i);
    assert.match(applied, /roll #2/i);
    assert.match(applied, /Caixa Real/);
    assert.match(applied, /criar sua ficha/i);
});
