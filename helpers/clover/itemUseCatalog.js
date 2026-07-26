'use strict';

const ITEM_USE_ACTIONS = Object.freeze([
    Object.freeze({
        actionKey: 'redeem_spell_ticket',
        templateKeys: Object.freeze(['ticket_feitico']),
        kinds: Object.freeze(['ticket_feitico']),
        mode: 'review_request',
        label: 'Solicitar uso',
        destination: 'Fluxo de Feitiços',
        requiresReview: true,
        consumesOnApproval: true,
        effectStatus: 'not_consolidated',
        description: 'Solicita o uso do Ticket de Feitiço. O Ticket não representa automaticamente uma vaga pessoal.',
    }),
    Object.freeze({
        actionKey: 'redeem_spell_priority_coupon',
        templateKeys: Object.freeze(['cupom_prioridade']),
        kinds: Object.freeze(['cupom_pa']),
        mode: 'review_request',
        label: 'Solicitar prioridade',
        destination: 'Fluxo de Feitiços',
        requiresReview: true,
        consumesOnApproval: true,
        description: 'Solicita a prioridade permitida no fluxo de feitiços; não garante aprovação.',
    }),
    Object.freeze({
        actionKey: 'redeem_exclusive_dungeon_access',
        templateKeys: Object.freeze(['acesso_dungeon_exclusiva']),
        kinds: Object.freeze(['acesso_dungeon']),
        mode: 'review_request',
        label: 'Solicitar entrada',
        destination: 'Dungeon Exclusiva',
        requiresReview: true,
        consumesOnApproval: true,
        description: 'Solicita o uso do passe pessoal da Dungeon Exclusiva.',
    }),
    Object.freeze({
        actionKey: 'redeem_special_mission_access',
        templateKeys: Object.freeze(['acesso_missao_especial']),
        kinds: Object.freeze(['acesso_missao']),
        mode: 'review_request',
        label: 'Solicitar missão',
        destination: 'Missão Especial',
        requiresReview: true,
        consumesOnApproval: true,
        description: 'Solicita uma oportunidade de missão especial.',
    }),
    Object.freeze({
        actionKey: 'apply_purchase_voucher',
        templateKeys: Object.freeze(['vale_compra_2000', 'vale_compra_5000']),
        kinds: Object.freeze(['vale_compra']),
        mode: 'contextual',
        label: 'Usar em uma compra',
        destination: 'Loja',
        requiresReview: false,
        consumesOnApproval: false,
        description: 'Este Vale é escolhido durante uma compra válida e não usa a fila de resgates.',
    }),
    Object.freeze({
        actionKey: 'apply_repair_voucher',
        templateKeys: Object.freeze(['vale_reparo_5000', 'vale_reparo_7000']),
        kinds: Object.freeze(['vale_reparo']),
        mode: 'contextual',
        label: 'Usar em um reparo',
        destination: 'Reparo',
        requiresReview: false,
        consumesOnApproval: false,
        description: 'Este Vale é escolhido durante um reparo válido e não usa a fila de resgates.',
    }),
    Object.freeze({
        actionKey: 'open_box',
        templateKeys: Object.freeze(['box_simple_v1', 'box_rare_v1']),
        kinds: Object.freeze(['caixa_economia']),
        mode: 'direct',
        label: 'Abrir Caixa',
        destination: 'Caixas',
        requiresReview: false,
        consumesOnApproval: false,
        description: 'Abre uma Caixa pela operação transacional de Caixas.',
    }),
]);

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

function getItemUseAction(item = {}) {
    const templateKey = normalize(item.template_key || item.templateKey);
    const kind = normalize(item.kind);
    const action = ITEM_USE_ACTIONS.find((entry) => (
        (templateKey && entry.templateKeys.includes(templateKey))
        || (kind && entry.kinds.includes(kind))
    ));
    return action ? {
        actionKey: action.actionKey,
        mode: action.mode,
        label: action.label,
        destination: action.destination,
        requiresReview: action.requiresReview,
        consumesOnApproval: action.consumesOnApproval,
        effectStatus: action.effectStatus || 'defined',
        description: action.description,
    } : null;
}

function decorateItemUse(item = {}) {
    const action = getItemUseAction(item);
    const availableQuantity = Number(
        item.available_quantity
        ?? item.availableQuantity
        ?? item.quantity
        ?? 0
    );
    return {
        ...item,
        useAction: action ? {
            ...action,
            available: availableQuantity > 0 && String(item.status || 'disponivel') === 'disponivel',
        } : null,
    };
}

module.exports = {
    ITEM_USE_ACTIONS,
    decorateItemUse,
    getItemUseAction,
};
