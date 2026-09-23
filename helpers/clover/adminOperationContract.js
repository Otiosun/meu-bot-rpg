'use strict';

const base = require('./adminOperationContractBase');

const SYSTEM_TARGET_KIND = 'system';
const SYSTEM_KEY = 'clover';
const SYSTEM_ACTION_TYPES = Object.freeze(new Set([
    'system.spell_review.settings.update',
    'system.spell_review.fill.request',
    'system.box.catalog.version.create',
    'system.box.catalog.version.activate',
    'system.skill_tree.catalog.version.activate',
    'system.skill_tree.catalog.version.create',
    'system.shop.catalog.version.create',
    'system.shop.catalog.version.activate',
    'system.mission.create',
    'system.mission.update',
    'system.mission.status.transition',
    'market.listing.cancel',
    'system.dream_world.acquisition.update',
    'system.dream_world.status.transition',
    'system.dream_fragment.grant',
    'system.dream_fragment.update',
    'system.dream_fragment.create',
    'system.dream_slot.replace',
    'system.dream_slot.remove',
    'system.dream_slot.assign',
    'system.dream_run.transition',
    'system.dream_application.reject',
    'system.dream_application.select',
    'system.dream_application.review',
    'system.dream_request.reject',
    'system.dream_request.approve',
    'system.dream_world.create',
]));

const EXTRA_ACTION_CAPABILITIES = Object.freeze({
    'player.spell.approve': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.spell.remove': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.spell.review.hold': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.spell.review.defer': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.spell.review.resume': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.attributes.correct': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.item.release_reservation': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.identity.repair': base.ADMIN_CAPABILITIES.PLAYER_IDENTITY_REPAIR,
    'system.box.catalog.version.activate': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
    'system.skill_tree.catalog.version.activate': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_TREES,
    'system.skill_tree.catalog.version.create': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_TREES,
    'system.shop.catalog.version.create': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_SHOPS,
    'system.shop.catalog.version.activate': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_SHOPS,
    'system.mission.create': base.ADMIN_CAPABILITIES.MISSION_MANAGE,
    'system.mission.update': base.ADMIN_CAPABILITIES.MISSION_MANAGE,
    'system.mission.status.transition': base.ADMIN_CAPABILITIES.MISSION_MANAGE,
    'system.box.catalog.version.create': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
    'player.box.pity.correct': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'market.listing.cancel': base.ADMIN_CAPABILITIES.MARKET_MANAGE,
    'system.dream_world.status.transition': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_world.acquisition.update': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_fragment.grant': base.ADMIN_CAPABILITIES.REWARD_GRANT,
    'system.dream_fragment.update': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
    'system.dream_fragment.create': base.ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
    'system.dream_slot.replace': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_slot.remove': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_slot.assign': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_run.transition': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_application.reject': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_application.select': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_application.review': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_request.reject': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'system.dream_request.approve': [base.ADMIN_CAPABILITIES.RAID_MANAGE, base.ADMIN_CAPABILITIES.RESOURCE_ADJUST],
    'system.dream_world.create': base.ADMIN_CAPABILITIES.RAID_MANAGE,
    'player.item.update': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'system.spell_review.settings.update': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'system.spell_review.fill.request': base.ADMIN_CAPABILITIES.PLAYER_MANAGE,
});

const TARGET_KINDS = Object.freeze([
    ...base.TARGET_KINDS,
    SYSTEM_TARGET_KIND,
]);

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

function normalizeTargetSelector(selector) {
    if (!isPlainObject(selector)) {
        throw new base.AdminOperationContractError(
            'Seletor de alvo inválido.',
            'invalid_target_selector'
        );
    }
    const kind = String(selector.kind || '').trim().toLowerCase();
    if (kind === SYSTEM_TARGET_KIND) {
        const systemKey = String(
            selector.systemKey || selector.key || SYSTEM_KEY
        ).trim().toLowerCase();
        if (systemKey !== SYSTEM_KEY) {
            throw new base.AdminOperationContractError(
                'Alvo global desconhecido.',
                'unknown_system_target',
                { systemKey }
            );
        }
        return { kind: SYSTEM_TARGET_KIND, systemKey: SYSTEM_KEY };
    }
    return base.normalizeTargetSelector(selector);
}

function normalizeAction(action, index) {
    if (!isPlainObject(action)) {
        throw new base.AdminOperationContractError(
            `Ação ${index + 1} inválida.`,
            'invalid_action',
            { index }
        );
    }
    const type = String(action.type || '').trim();
    if (base.ACTION_TYPES.includes(type)) return base.normalizeAction(action, index);
    if (!Object.prototype.hasOwnProperty.call(EXTRA_ACTION_CAPABILITIES, type)) {
        throw new base.AdminOperationContractError(
            `Ação desconhecida: ${type || '(vazia)'}.`,
            'unknown_action_type',
            { index, type }
        );
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
    const capabilities = [];
    for (const action of actions || []) {
        const required = ACTION_CAPABILITIES[action.type];
        if (Array.isArray(required)) {
            capabilities.push(...required.filter(Boolean));
        } else if (required) {
            capabilities.push(required);
        }
    }
    return [...new Set(capabilities)];
}

function assertRoleCanDraftActions(role, actions) {
    const missing = requiredCapabilitiesForActions(actions)
        .filter((capability) => !base.canRole(role, capability));
    if (missing.length) {
        throw new base.AdminOperationContractError(
            'O perfil administrativo não possui permissão para todas as ações.',
            'forbidden_actions',
            { role, missing }
        );
    }
}

function assertSystemActionTargetCompatibility(targets, actions) {
    const hasSystemTarget = (targets || []).some(
        (target) => target.kind === SYSTEM_TARGET_KIND
    );
    const hasNonSystemTarget = (targets || []).some(
        (target) => target.kind !== SYSTEM_TARGET_KIND
    );
    const hasSystemAction = (actions || []).some(
        (action) => SYSTEM_ACTION_TYPES.has(action.type)
    );
    const hasNonSystemAction = (actions || []).some(
        (action) => !SYSTEM_ACTION_TYPES.has(action.type)
    );

    if (hasSystemAction && (hasNonSystemTarget || !hasSystemTarget)) {
        throw new base.AdminOperationContractError(
            'Ações globais exigem exclusivamente o alvo system:clover.',
            'system_action_requires_system_target'
        );
    }
    if (hasSystemTarget && (hasNonSystemAction || !hasSystemAction)) {
        throw new base.AdminOperationContractError(
            'O alvo system:clover aceita somente ações globais.',
            'system_target_requires_system_action'
        );
    }
}

function normalizeAdminOperationInput(input, options = {}) {
    if (!isPlainObject(input)) return base.normalizeAdminOperationInput(input, options);

    const normalizedTargets = Array.isArray(input.targets)
        ? input.targets.map(normalizeTargetSelector)
        : [];
    const normalizedActions = Array.isArray(input.actions)
        ? input.actions.map((action, index) => normalizeAction(action, index))
        : [];

    assertSystemActionTargetCompatibility(normalizedTargets, normalizedActions);

    const surrogateActions = normalizedActions.map((action) => (
        base.ACTION_TYPES.includes(action.type)
            ? action
            : { ...action, type: 'player.item.remove' }
    ));
    const surrogateTargets = normalizedTargets.map((target) => (
        target.kind === SYSTEM_TARGET_KIND
            ? { kind: 'player', playerId: '__clover_system__' }
            : target
    ));

    const normalized = base.normalizeAdminOperationInput(
        { ...input, targets: surrogateTargets, actions: surrogateActions },
        options
    );

    assertRoleCanDraftActions(normalized.actor.role, normalizedActions);

    return {
        ...normalized,
        targets: normalizedTargets,
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
    SYSTEM_ACTION_TYPES,
    SYSTEM_KEY,
    SYSTEM_TARGET_KIND,
    TARGET_KINDS,
    assertRoleCanDraftActions,
    assertSystemActionTargetCompatibility,
    canTransitionOperation,
    normalizeAction,
    normalizeAdminOperationInput,
    normalizeTargetSelector,
    requiredCapabilitiesForActions,
};
