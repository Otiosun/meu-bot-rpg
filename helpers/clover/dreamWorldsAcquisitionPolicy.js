'use strict';

class DreamWorldsAcquisitionPolicyError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DreamWorldsAcquisitionPolicyError';
        this.code = code;
        this.status = 400;
        this.details = details;
    }
}

function normalizeRealSupportLabel(value) {
    const label = String(value ?? '').trim();
    return label || null;
}

function validateDreamWorldDualAcquisition(input = {}) {
    const yullsPrice = Number(input.yullsPrice ?? input.yulls_price ?? 0);
    if (!Number.isSafeInteger(yullsPrice) || yullsPrice <= 0) {
        throw new DreamWorldsAcquisitionPolicyError(
            'missing_yulls_price',
            'Toda Fenda precisa informar um preço positivo em Yuls.',
            { yullsPrice: input.yullsPrice ?? input.yulls_price ?? null }
        );
    }

    const manualEnabled = input.manualPaymentEnabled ?? input.manual_payment_enabled;
    if (manualEnabled !== true && manualEnabled !== 1 && manualEnabled !== '1') {
        throw new DreamWorldsAcquisitionPolicyError(
            'missing_real_money_option',
            'Toda Fenda precisa permitir aquisição por dinheiro real com confirmação manual.'
        );
    }

    const manualPriceLabel = normalizeRealSupportLabel(
        input.manualPriceLabel ?? input.manual_price_label
    );
    if (!manualPriceLabel) {
        throw new DreamWorldsAcquisitionPolicyError(
            'missing_real_money_value',
            'Informe o valor de apoio em dinheiro real exibido no registro da Fenda.'
        );
    }

    return {
        ...input,
        yullsPrice,
        manualPaymentEnabled: true,
        manualPriceLabel,
    };
}

module.exports = {
    DreamWorldsAcquisitionPolicyError,
    validateDreamWorldDualAcquisition,
};
