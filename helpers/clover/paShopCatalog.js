'use strict';

const PA_SHOP_ITEMS = Object.freeze([
    Object.freeze({
        id: 1,
        key: 'ph',
        aliases: ['1', 'ph', 'ponto', 'pontos', 'ph de servico', 'ph de serviço'],
        name: 'PH de serviço',
        unitPaCost: 1,
        rewardAmount: 1,
        rewardLabel: '1 PH',
        weeklyLimit: null,
        quantityMode: 'required',
        limitMode: 'common_ph',
        description: 'Converte PA em PH dentro do teto semanal comum do personagem.',
    }),
    Object.freeze({
        id: 2,
        key: 'yulls',
        aliases: ['2', 'yull', 'yulls', 'dinheiro'],
        name: 'Yulls de serviço',
        unitPaCost: 5,
        rewardAmount: 500,
        rewardLabel: '500¥',
        weeklyLimit: 10,
        quantityMode: 'optional',
        limitMode: 'fixed',
        description: 'Entrega 500 Yulls por unidade comprada.',
    }),
    Object.freeze({
        id: 3,
        key: 'caixa_simples',
        aliases: ['3', 'caixa', 'caixa simples'],
        name: 'Caixa simples',
        unitPaCost: 8,
        rewardAmount: 1,
        rewardLabel: '1 caixa',
        weeklyLimit: 1,
        quantityMode: 'single',
        limitMode: 'fixed',
        description: 'Adiciona uma caixa simples selada ao inventário.',
    }),
    Object.freeze({
        id: 4,
        key: 'cupom_prioridade',
        aliases: ['4', 'cupom', 'prioridade', 'cupom de prioridade'],
        name: 'Cupom de prioridade',
        unitPaCost: 35,
        rewardAmount: 1,
        rewardLabel: '1 cupom',
        weeklyLimit: 1,
        quantityMode: 'single',
        limitMode: 'fixed',
        description: 'Adiciona um cupom de prioridade para uma avaliação simples própria.',
    }),
    Object.freeze({
        id: 5,
        key: 'estrela_esquadrao',
        aliases: ['5', 'estrela', 'estrela de esquadrao', 'estrela de esquadrão'],
        name: 'Estrela de esquadrão',
        unitPaCost: 30,
        rewardAmount: 1,
        rewardLabel: '+1 estrela',
        weeklyLimit: 1,
        quantityMode: 'single',
        limitMode: 'fixed',
        description: 'Entrega +1 estrela ao personagem e ao esquadrão registrado.',
    }),
]);

function normalizeShopToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getPaShopItem(value) {
    const normalized = normalizeShopToken(value);
    if (!normalized) return null;
    return PA_SHOP_ITEMS.find((item) => (
        String(item.id) === normalized
        || item.key === normalized.replace(/\s+/g, '_')
        || item.aliases.some((alias) => normalizeShopToken(alias) === normalized)
    )) || null;
}

module.exports = {
    PA_SHOP_ITEMS,
    getPaShopItem,
    normalizeShopToken,
};