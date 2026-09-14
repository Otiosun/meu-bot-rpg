'use strict';

function product(itemKey, name, section, priceReturnPoints, options = {}) {
    return Object.freeze({
        itemKey,
        entitlementKey: options.entitlementKey || `return-shop:${itemKey}`,
        name,
        section,
        description: options.description || '',
        priceReturnPoints,
        purchasable: options.purchasable !== false && priceReturnPoints > 0,
        targetMode: options.targetMode || 'none',
        effectKind: options.effectKind || 'entitlement',
        effectValue: options.effectValue || null,
        perPlayerLimit: options.perPlayerLimit ?? null,
        globalLimit: options.globalLimit ?? null,
        quantityMode: options.quantityMode || 'fixed',
        maxQuantityPerPurchase: options.maxQuantityPerPurchase ?? 1,
        weeklyQuantityLimit: options.weeklyQuantityLimit ?? null,
        tags: Object.freeze([...(options.tags || [])]),
    });
}

const RETURN_POINT_SHOP_CATALOG_VERSION = 'return-shop-v1';

const RETURN_POINT_SHOP_CATALOG = Object.freeze([
    // Loja 1 · Trocas / recursos da próxima vida.
    product('ph_1', '1 PH', 'trocas', 1, {
        effectKind: 'future_ph',
        quantityMode: 'amount',
        maxQuantityPerPurchase: 60,
        weeklyQuantityLimit: 60,
        description: 'Concede PH ao personagem promovido no lançamento. Máximo de 60 PH por semana.',
    }),
    product('yulls_5000', '5.000 Yulls', 'trocas', 10, {
        effectKind: 'future_yulls',
        effectValue: 5000,
        description: 'Concede 5.000 Yulls ao personagem promovido no lançamento.',
    }),
    product('yulls_20000', '20.000 Yulls', 'trocas', 30, {
        effectKind: 'future_yulls',
        effectValue: 20000,
        description: 'Concede 20.000 Yulls ao personagem promovido no lançamento.',
    }),
    product('caixa_comum', 'Caixa Comum', 'trocas', 25, {
        effectKind: 'future_box', effectValue: 'box_simple_v1', perPlayerLimit: 30,
    }),
    product('caixa_rara', 'Caixa Rara', 'trocas', 40, {
        effectKind: 'future_box', effectValue: 'box_rare_v1', perPlayerLimit: 20,
    }),
    product('caixa_real', 'Caixa Real', 'trocas', 60, {
        effectKind: 'future_box', effectValue: 'box_royal_v1', perPlayerLimit: 5,
        description: 'Caixa Real fechada recebida no lancamento; abertura pendente da loot table canonica.',
    }),
    product('ticket_feitico', 'Ticket de Feitiço', 'trocas', 150, {
        effectKind: 'future_item', effectValue: 'ticket_feitico', perPlayerLimit: 1,
    }),
    product('item_magico_personalizado', 'Item Mágico Personalizado', 'trocas', 250, {
        effectKind: 'future_item_request', globalLimit: 3,
    }),
    product('cupom_prioridade_feitico', 'Cupom de Prioridade em Feitiço', 'trocas', 300, {
        effectKind: 'future_item', effectValue: 'cupom_prioridade', perPlayerLimit: 1,
    }),

    // Loja 2 · Casta / alterações do roll futuro escolhido.
    product('classe_miseravel', 'Miserável', 'casta_classe', 0, {
        purchasable: false, targetMode: 'roll', effectKind: 'social_class', effectValue: 'miseravel',
        description: 'Opção gratuita já disponível naturalmente; não exige compra.',
    }),
    product('classe_artesao', 'Artesãos e Comerciantes', 'casta_classe', 100, {
        targetMode: 'roll', effectKind: 'social_class', effectValue: 'artesao',
    }),
    product('classe_burguesia', 'Burguesia', 'casta_classe', 250, {
        targetMode: 'roll', effectKind: 'social_class', effectValue: 'burguesia',
    }),
    product('classe_nobreza', 'Nobreza', 'casta_classe', 400, {
        targetMode: 'roll', effectKind: 'social_class', effectValue: 'nobreza',
    }),
    product('classe_realeza', 'Realeza', 'casta_classe', 500, {
        targetMode: 'roll', effectKind: 'social_class', effectValue: 'realeza',
    }),

    product('reino_clover', 'Clover', 'casta_reino', 100, {
        targetMode: 'roll', effectKind: 'kingdom', effectValue: 'clover',
    }),
    product('reino_heart', 'Heart', 'casta_reino', 100, {
        targetMode: 'roll', effectKind: 'kingdom', effectValue: 'heart',
    }),
    product('reino_spade', 'Spade', 'casta_reino', 100, {
        targetMode: 'roll', effectKind: 'kingdom', effectValue: 'spade',
    }),
    product('reino_diamond', 'Diamond', 'casta_reino', 150, {
        targetMode: 'roll', effectKind: 'kingdom', effectValue: 'diamond',
    }),

    product('grimorio_clover_3f', '3 Folhas', 'casta_grimorio', 50, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'clover_3f',
    }),
    product('grimorio_spade_1', '1 Espada', 'casta_grimorio', 100, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'spade_3f',
    }),
    product('grimorio_heart_comum', 'Coração', 'casta_grimorio', 100, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'heart_3f',
    }),
    product('grimorio_diamond_comum', 'Diamond', 'casta_grimorio', 150, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'diamond_3f',
    }),
    product('grimorio_clover_4f', '4 Folhas', 'casta_grimorio', 500, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'clover_4f', globalLimit: 1,
    }),
    product('grimorio_heart_duplo', 'Coração Duplo', 'casta_grimorio', 500, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'heart_4f', globalLimit: 1,
    }),
    product('grimorio_spade_2', '2 Espadas', 'casta_grimorio', 500, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'spade_4f', globalLimit: 1,
    }),
    product('grimorio_diamond_lapidado', 'Diamante Lapidado', 'casta_grimorio', 650, {
        targetMode: 'roll', effectKind: 'grimoire', effectValue: 'diamond_4f', globalLimit: 1,
    }),

    product('raca_humano', 'Humano', 'casta_raca', 0, {
        purchasable: false, targetMode: 'roll', effectKind: 'race', effectValue: 'humano',
        description: 'Opção gratuita já disponível naturalmente; não exige compra.',
    }),
    product('raca_bruxa', 'Bruxa', 'casta_raca', 300, {
        targetMode: 'roll', effectKind: 'race', effectValue: 'bruxa',
    }),
    product('raca_anao', 'Anão', 'casta_raca', 400, {
        targetMode: 'roll', effectKind: 'race', effectValue: 'anao',
    }),
    product('raca_elfo', 'Elfo', 'casta_raca', 900, {
        targetMode: 'roll', effectKind: 'race', effectValue: 'elfo',
    }),

    product('traco_raro', 'Traço Raro', 'casta_traco', 300, {
        targetMode: 'roll', effectKind: 'rare_aptitude_entitlement',
    }),
    product('marca_rara', 'Marca Rara', 'casta_traco', 400, {
        targetMode: 'roll', effectKind: 'rare_mark_entitlement',
    }),
    product('anomalia', 'Anomalia', 'casta_traco', 500, {
        targetMode: 'roll', effectKind: 'anomaly_entitlement',
    }),

    // Loja 3 · Itens especiais da próxima vida.
    product('ticket_reliquia', 'Ticket de Relíquia', 'especiais', 1000, {
        effectKind: 'future_special', globalLimit: 1,
    }),
    product('eco_vida_passada', 'Eco da Vida Passada', 'especiais', 550, {
        effectKind: 'future_special', globalLimit: 2,
    }),
    product('salvamento_inventario', 'Salvamento de Inventário', 'especiais', 350, {
        effectKind: 'inventory_preservation', globalLimit: 2,
        description: 'Preserva somente caixas elegiveis/canonicas; nao preserva outros itens nem inventario inteiro.',
    }),
    product('coracao_cristal', 'Coração de Cristal', 'especiais', 750, {
        effectKind: 'future_special', globalLimit: 1,
    }),
    product('ryuga', 'Ryūga', 'especiais', 500, {
        effectKind: 'future_special', globalLimit: 1,
    }),
    product('gintetsu', 'Gintetsu', 'especiais', 350, {
        effectKind: 'future_special', globalLimit: 2,
    }),
    product('surtr', 'Surtr', 'especiais', 400, {
        effectKind: 'future_special', globalLimit: 1,
    }),
    product('capibara', 'Capibara', 'especiais', 500, {
        effectKind: 'future_special', globalLimit: 1,
    }),
]);

const RETURN_POINT_SHOP_BY_KEY = new Map(RETURN_POINT_SHOP_CATALOG.map((item) => [item.itemKey, item]));

function getReturnPointShopItem(itemKey) {
    return RETURN_POINT_SHOP_BY_KEY.get(String(itemKey || '').trim()) || null;
}

module.exports = {
    RETURN_POINT_SHOP_CATALOG,
    RETURN_POINT_SHOP_CATALOG_VERSION,
    getReturnPointShopItem,
};
