'use strict';

const base = require('./adminOperationContractBase');

const EXTRA_ACTION_CAPABILITIES = Object.freeze({
    'player.item.update': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.item.release_reservation': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
});

const ACTION_TYPES = Object.freeze([
    ...base.ACTION_TYPES,
    ...Object.keys(EXTRA_ACTION_CAPABILITIES),
]);
const ACTION_CAPABILITIES = Object.freeze({
    ...base.ACTION_CAPABILITIES,
    ...EXTRA_ACTION_CAPABILITIES,
});

const OPERATION_STATUSES = Object.freeze([
    'draft',
    'simulated',
    'approved',
    'applying',
    'applied',
    'partially_applied',
    'retrying',
    'compensating',
    'compensated',
    'accepted_partial',
    'failed',
    'cancelled',
    'undone',
]);

const STATUS_TRANSITIONS = Object.freeze({
    draft: Object.freeze(['simulated', 'cancelled']),
    simulated: Object.freeze(['approved', 'cancelled']),
    approved: Object.freeze(['applying', 'cancelled']),
    applying: Object.freeze(['applied', 'partially_applied', 'failed']),
    applied: Object.freeze(['undone', 'compensating']),
    partially_applied: Object.freeze(['retrying', 'compensating', 'accepted_partial']),
    retrying: Object.freeze(['applied', 'partially_applied', 'failed']),
    compensating: Object.freeze(['compensated', 'partially_applied']),
    compensated: Object.freeze([]),
    accepted_partial: Object.freeze([]),
    failed: Object.freeze(['retrying']),
    cancelled: Object.freeze([]),
    undone: Object.freeze([]),
});

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(action, index) {
    if (!isPlainObject(action)) {
        throw new base.AdminOperationContractError(`Ação ${index + 1} inválida.`, 'invalid_action', { index });
    }
    const type = String(action.type || '').trim();
    if (base.ACTION_TYPES.includes(type)) return base.normalizeAction(action, index);
    if (!Object.prototype.hasOwnProperty.call(EXTRA_ACTION_CAPABILITIES, type)) {
        throw new base.AdminOperationContractError(`Ação desconhecida: ${type || '(vazia)'}.`, 'unknown_action_type', { index, type });
    }
    if (action.payload !== undefined && !isPlainObject(action.payload)) {
        throw new base.AdminOperationContractError(
            `Payload da ação ${index + 1} precisa ser um objeto.`,
            'invalid_action_payload',
            { index, type }
        );
    }
    return {
        type,
        payload: { ...(action.payload || {}) },
        ...(action.label ? { label: String(action.label).trim() } : {}),
    };
}

function requiredCapabilitiesForActions(actions) {
    return [...new Set((actions || []).map((action) => ACTION_CAPABILITIES[action.type]).filter(Boolean))];
}

function assertRoleCanDraftActions(role, actions) {
    const missing = requiredCapabilitiesForActions(actions).filter((capability) => !base.canRole(role, capability));
    if (missing.length) {
        throw new base.AdminOperationContractError(
            'O perfil administrativo não possui permissão para todas as ações.',
            'forbidden_actions',
            { role, missing }
        );
    }
}

function normalizeAdminOperationInput(input, options = {}) {
    if (!isPlainObject(input)) return base.normalizeAdminOperationInput(input, options);
    const normalizedActions = Array.isArray(input.actions)
        ? input.actions.map((action, index) => normalizeAction(action, index))
        : [];
    const surrogateActions = normalizedActions.map((action) => (
        base.ACTION_TYPES.includes(action.type)
            ? action
            : { ...action, type: 'player.item.remove' }
    ));
    const normalized = base.normalizeAdminOperationInput(
        { ...input, actions: surrogateActions },
        options
    );
    assertRoleCanDraftActions(normalized.actor.role, normalizedActions);
    return {
        ...normalized,
        actions: normalizedActions,
        requiredCapabilities: requiredCapabilitiesForActions(normalizedActions),
    };
}

function canTransitionOperation(fromStatus, toStatus) {
    const from = String(fromStatus || '').trim();
    const to = String(toStatus || '').trim();
    if (!OPERATION_STATUSES.includes(from) || !OPERATION_STATUSES.includes(to)) return false;
    return (STATUS_TRANSITIONS[from] || []).includes(to);
}

module.exports = {
    ...base,
    ACTION_CAPABILITIES,
    ACTION_TYPES,
    EXTRA_ACTION_CAPABILITIES,
    OPERATION_STATUSES,
    STATUS_TRANSITIONS,
    assertRoleCanDraftActions,
    canTransitionOperation,
    normalizeAction,
    normalizeAdminOperationInput,
    requiredCapabilitiesForActions,
};
