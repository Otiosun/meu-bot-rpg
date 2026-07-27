'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DreamWorldsAcquisitionPolicyError,
    validateDreamWorldDualAcquisition,
} = require('../helpers/clover/dreamWorldsAcquisitionPolicy');

test('política aceita Fenda com Yuls positivos e valor real público', () => {
    const result = validateDreamWorldDualAcquisition({
        yullsPrice: 250000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 49,90',
    });

    assert.equal(result.yullsPrice, 250000);
    assert.equal(result.manualPaymentEnabled, true);
    assert.equal(result.manualPriceLabel, 'R$ 49,90');
});

test('política normaliza campos legados sem perder os dois caminhos', () => {
    const result = validateDreamWorldDualAcquisition({
        yulls_price: '100000',
        manual_payment_enabled: 1,
        manual_price_label: '  R$ 29,90  ',
    });

    assert.equal(result.yullsPrice, 100000);
    assert.equal(result.manualPaymentEnabled, true);
    assert.equal(result.manualPriceLabel, 'R$ 29,90');
});

test('política recusa preço ausente ou inválido em Yuls', () => {
    for (const yullsPrice of [0, -1, 1.5, 'não-numérico']) {
        assert.throws(
            () => validateDreamWorldDualAcquisition({
                yullsPrice,
                manualPaymentEnabled: true,
                manualPriceLabel: 'R$ 49,90',
            }),
            (error) => error instanceof DreamWorldsAcquisitionPolicyError
                && error.code === 'missing_yulls_price'
                && error.status === 400,
        );
    }
});

test('política recusa Fenda sem aquisição por dinheiro real', () => {
    assert.throws(
        () => validateDreamWorldDualAcquisition({
            yullsPrice: 100000,
            manualPaymentEnabled: false,
            manualPriceLabel: 'R$ 49,90',
        }),
        (error) => error instanceof DreamWorldsAcquisitionPolicyError
            && error.code === 'missing_real_money_option'
            && error.status === 400,
    );
});

test('política recusa valor real público vazio', () => {
    assert.throws(
        () => validateDreamWorldDualAcquisition({
            yullsPrice: 100000,
            manualPaymentEnabled: true,
            manualPriceLabel: '   ',
        }),
        (error) => error instanceof DreamWorldsAcquisitionPolicyError
            && error.code === 'missing_real_money_value'
            && error.status === 400,
    );
});
