'use strict';

const crypto = require('crypto');

const CONTRACT_VERSION = 'clover.admin-operation.v1';

const ADMIN_ROLES = Object.freeze({
    OWNER: 'owner',
    ADMIN: 'admin',
    EVALUATOR: 'evaluator',
    NARRATOR: 'narrator',
    ASSISTANT: 'assistant',
});

const ADMIN_CAPABILITIES = Object.freeze({
    OPERATION_VIEW: 'operation.view',
    OPERATION_DRAFT: 'operation.draft',
    OPERATION_SIMULATE: 'operation.simulate',
    OPERATION_APPLY: 'operation.apply',
    OPERATION_UNDO: 'operation.undo',
    PLAYER_VIEW: 'player.view',
    PLAYER_MANAGE: 'player.manage',
    PLAYER_IDENTITY_REPAIR: 'player.identity.repair',
    CATALOG_VIEW: 'catalog.view',
    CATALOG_MANAGE_TRAITS: 'catalog.manage.traits',
    CATALOG_MANAGE_ITEMS: 'catalog.manage.items',
    CATALOG_MANAGE_HOOKS: 'catalog.manage.hooks',
    CATALOG_MANAGE_REWARDS: 'catalog.manage.rewards',
    RAID_VIEW: 'raid.view',
    RAID_MANAGE: 'raid.manage',
    RAID_REWARD_REVIEW: 'raid.reward.review',
    REWARD_GRANT: 'reward.grant',
    RESOURCE_ADJUST: 'resource.adjust',
    INTEGRITY_VIEW: 'integrity.view',
});

const ALL_CAPABILITIES = Object.freeze(Object.values(ADMIN_CAPABILITIES));

const ROLE_CAPABILITIES = Object.freeze({
    [ADMIN_ROLES.OWNER]: ALL_CAPABILITIES,
    [ADMIN_ROLES.ADMIN]: Object.freeze([
        ADMIN_CAPABILITIES.OPERATION_VIEW,
        ADMIN_CAPABILITIES.OPERATION_DRAFT,
        ADMIN_CAPABILITIES.OPERATION_SIMULATE,
        ADMIN_CAPABILITIES.OPERATION_APPLY,
        ADMIN_CAPABILITIES.OPERATION_UNDO,
        ADMIN_CAPABILITIES.PLAYER_VIEW,
        ADMIN_CAPABILITIES.PLAYER_MANAGE,
        ADMIN_CAPABILITIES.CATALOG_VIEW,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_TRAITS,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
        ADMIN_CAPABILITIES.RAID_VIEW,
        ADMIN_CAPABILITIES.RAID_MANAGE,
        ADMIN_CAPABILITIES.RAID_REWARD_REVIEW,
        ADMIN_CAPABILITIES.REWARD_GRANT,
        ADMIN_CAPABILITIES.RESOURCE_ADJUST,
        ADMIN_CAPABILITIES.INTEGRITY_VIEW,
    ]),
    [ADMIN_ROLES.EVALUATOR]: Object.freeze([
        ADMIN_CAPABILITIES.OPERATION_VIEW,
        ADMIN_CAPABILITIES.OPERATION_DRAFT,
        ADMIN_CAPABILITIES.OPERATION_SIMULATE,
        ADMIN_CAPABILITIES.PLAYER_VIEW,
        ADMIN_CAPABILITIES.PLAYER_MANAGE,
        ADMIN_CAPABILITIES.CATALOG_VIEW,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_TRAITS,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
        ADMIN_CAPABILITIES.RAID_REWARD_REVIEW,
    ]),
    [ADMIN_ROLES.NARRATOR]: Object.freeze([
        ADMIN_CAPABILITIES.OPERATION_VIEW,
        ADMIN_CAPABILITIES.OPERATION_DRAFT,
        ADMIN_CAPABILITIES.OPERATION_SIMULATE,
        ADMIN_CAPABILITIES.PLAYER_VIEW,
        ADMIN_CAPABILITIES.CATALOG_VIEW,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
        ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
        ADMIN_CAPABILITIES.RAID_VIEW,
        ADMIN_CAPABILITIES.RAID_MANAGE,
    ]),
    [ADMIN_ROLES.ASSISTANT]: Object.freeze([
        ADMIN_CAPABILITIES.OPERATION_VIEW,
        ADMIN_CAPABILITIES.OPERATION_DRAFT,
        ADMIN_CAPABILITIES.PLAYER_VIEW,
        ADMIN_CAPABILITIES.CATALOG_VIEW,
        ADMIN_CAPABILITIES.RAID_VIEW,
    ]),
});

const TARGET_KINDS = Object.freeze([
    'player',
    'players',
    'squad',
    'raid_participants',
    'filter',
]);

const ACTION_TYPES = Object.freeze([
    'catalog.trait.create',
    'catalog.trait.update',
    'catalog.trait.archive',
    'catalog.trait.restore',
    'catalog.item.create',
    'catalog.item.update',
    'catalog.item.archive',
    'catalog.item.restore',
    'catalog.hook.create',
    'catalog.hook.update',
    'catalog.hook.archive',
    'catalog.hook.restore',
    'catalog.reward.create',
    'catalog.reward.update',
    'catalog.reward.archive',
    'catalog.reward.restore',
    'player.trait.assign',
    'player.trait.remove',
    'player.trait.customize',
    'player.trait.reset_override',
    'player.hook.assign',
    'player.hook.update',
    'player.hook.complete',
    'player.hook.remove',
    'player.item.grant',
    'player.item.remove',
    'player.title.grant',
    'player.title.remove',
    'reward.grant',
    'resource.adjust',
    'raid.progress.adjust',
    'raid.reservation.release',
]);

const OPERATION_STATUSES = Object.freeze([
    'draft',
    'simulated',
    'approved',
    'applying',
    'applied',
    'partially_applied',
    'failed',
    'cancelled',
    'undone',
]);

const STATUS_TRANSITIONS = Object.freeze({
    draft: Object.freeze(['simulated', 'cancelled']),
    simulated: Object.freeze(['approved', 'cancelled']),
    approved: Object.freeze(['applying', 'cancelled']),
    applying: Object.freeze(['applied', 'partially_applied', 'failed']),
    applied: Object.freeze(['undone']),
    partially_applied: Object.freeze([]),
    failed: Object.freeze([]),
    cancelled: Object.freeze([]),
    undone: Object.freeze([]),
});

const ACTION_CAPABILITIES = Object.freeze({
    'catalog.trait.create': ADMIN_CAPABILITIES.CATALOG_MANAGE_TRAITS,
    'catalog.trait.update': ADMIN_CAPABILITIES.CATALOG_MANAGE_TRAITS,
    'catalog.trait.archive': ADMIN_CAPABILITIES.CATALOG_MANAGE_TRAITS,
    'catalog.trait.restore': ADMIN_CAPABILITIES.CATALOG_MANAGE_TRAITS,
    'catalog.item.create': ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
    'catalog.item.update': ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
    'catalog.item.archive': ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
    'catalog.item.restore': ADMIN_CAPABILITIES.CATALOG_MANAGE_ITEMS,
    'catalog.hook.create': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'catalog.hook.update': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'catalog.hook.archive': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'catalog.hook.restore': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'catalog.reward.create': ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
    'catalog.reward.update': ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
    'catalog.reward.archive': ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
    'catalog.reward.restore': ADMIN_CAPABILITIES.CATALOG_MANAGE_REWARDS,
    'player.trait.assign': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.trait.remove': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.trait.customize': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.trait.reset_override': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.hook.assign': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'player.hook.update': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'player.hook.complete': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'player.hook.remove': ADMIN_CAPABILITIES.CATALOG_MANAGE_HOOKS,
    'player.item.grant': ADMIN_CAPABILITIES.REWARD_GRANT,
    'player.item.remove': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.profile.correct': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'player.title.grant': ADMIN_CAPABILITIES.REWARD_GRANT,
    'player.title.remove': ADMIN_CAPABILITIES.PLAYER_MANAGE,
    'reward.grant': ADMIN_CAPABILITIES.REWARD_GRANT,
    'resource.adjust': ADMIN_CAPABILITIES.RESOURCE_ADJUST,
    'raid.progress.adjust': ADMIN_CAPABILITIES.RESOURCE_ADJUST,
    'raid.reservation.release': ADMIN_CAPABILITIES.RESOURCE_ADJUST,
});

class AdminOperationContractError extends Error {
    constructor(message, code = 'invalid_admin_operation', details = null) {
        super(message);
        this.name = 'AdminOperationContractError';
        this.code = code;
        this.details = details;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label) {
    const text = String(value || '').trim();
    if (!text) {
        throw new AdminOperationContractError(`${label} é obrigatório.`, 'missing_field', { field: label });
    }
    return text;
}

function normalizeRole(role) {
    const value = String(role || '').trim().toLowerCase();
    if (!Object.values(ADMIN_ROLES).includes(value)) {
        throw new AdminOperationContractError('Perfil administrativo inválido.', 'invalid_admin_role', { role });
    }
    return value;
}

function getRoleCapabilities(role) {
    const normalized = normalizeRole(role);
    return [...(ROLE_CAPABILITIES[normalized] || [])];
}

function canRole(role, capability) {
    const requested = String(capability || '').trim();
    return getRoleCapabilities(role).includes(requested);
}

function generateOperationCode(randomBytes = crypto.randomBytes) {
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    return `OP-${suffix}`;
}

function normalizeTargetSelector(selector) {
    if (!isPlainObject(selector)) {
        throw new AdminOperationContractError('Seletor de alvo inválido.', 'invalid_target_selector');
    }

    const kind = String(selector.kind || '').trim().toLowerCase();
    if (!TARGET_KINDS.includes(kind)) {
        throw new AdminOperationContractError('Tipo de alvo não reconhecido.', 'unknown_target_kind', { kind });
    }

    if (kind === 'player') {
        const playerId = String(selector.playerId || '').trim();
        const query = String(selector.query || '').trim();
        if (!playerId && !query) {
            throw new AdminOperationContractError('Informe playerId ou busca para o alvo.', 'empty_player_target');
        }
        return { kind, ...(playerId ? { playerId } : {}), ...(query ? { query } : {}) };
    }

    if (kind === 'players') {
        const values = Array.isArray(selector.values)
            ? [...new Set(selector.values.map((entry) => String(entry || '').trim()).filter(Boolean))]
            : [];
        if (!values.length) {
            throw new AdminOperationContractError('A lista de jogadores está vazia.', 'empty_players_target');
        }
        return { kind, values };
    }

    if (kind === 'squad') {
        return { kind, squadKey: requireText(selector.squadKey, 'squadKey') };
    }

    if (kind === 'raid_participants') {
        return {
            kind,
            raidKey: requireText(selector.raidKey, 'raidKey'),
            includeRemoved: Boolean(selector.includeRemoved),
        };
    }

    if (!isPlainObject(selector.filters) || !Object.keys(selector.filters).length) {
        throw new AdminOperationContractError('O filtro de alvos está vazio.', 'empty_target_filter');
    }

    return { kind, filters: { ...selector.filters } };
}

function normalizeAction(action, index) {
    if (!isPlainObject(action)) {
        throw new AdminOperationContractError(`Ação ${index + 1} inválida.`, 'invalid_action', { index });
    }

    const type = String(action.type || '').trim();
    if (!ACTION_TYPES.includes(type)) {
        throw new AdminOperationContractError(`Ação desconhecida: ${type || '(vazia)'}.`, 'unknown_action_type', {
            index,
            type,
        });
    }

    if (action.payload !== undefined && !isPlainObject(action.payload)) {
        throw new AdminOperationContractError(`Payload da ação ${index + 1} precisa ser um objeto.`, 'invalid_action_payload', {
            index,
            type,
        });
    }

    return {
        type,
        payload: { ...(action.payload || {}) },
        ...(action.label ? { label: String(action.label).trim() } : {}),
    };
}

function requiredCapabilitiesForActions(actions) {
    return [...new Set(actions.map((action) => ACTION_CAPABILITIES[action.type]).filter(Boolean))];
}

function assertRoleCanDraftActions(role, actions) {
    const missing = requiredCapabilitiesForActions(actions).filter((capability) => !canRole(role, capability));
    if (missing.length) {
        throw new AdminOperationContractError('O perfil administrativo não possui permissão para todas as ações.', 'forbidden_actions', {
            role,
            missing,
        });
    }
}

function normalizeAdminOperationInput(input, options = {}) {
    if (!isPlainObject(input)) {
        throw new AdminOperationContractError('Operação administrativa inválida.');
    }

    const actorId = requireText(options.actorId || input.actorId, 'actorId');
    const actorRole = normalizeRole(options.actorRole || input.actorRole);
    const targets = Array.isArray(input.targets) ? input.targets.map(normalizeTargetSelector) : [];
    const actions = Array.isArray(input.actions)
        ? input.actions.map((action, index) => normalizeAction(action, index))
        : [];

    if (!targets.length) {
        throw new AdminOperationContractError('A operação precisa de pelo menos um seletor de alvo.', 'missing_targets');
    }
    if (!actions.length) {
        throw new AdminOperationContractError('A operação precisa de pelo menos uma ação.', 'missing_actions');
    }

    assertRoleCanDraftActions(actorRole, actions);

    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (Number.isNaN(now.getTime())) {
        throw new AdminOperationContractError('Data da operação inválida.', 'invalid_operation_date');
    }

    const code = input.code ? requireText(input.code, 'code').toUpperCase() : generateOperationCode(options.randomBytes);
    if (!/^OP-[A-F0-9]{6}$/.test(code)) {
        throw new AdminOperationContractError('Código universal inválido.', 'invalid_operation_code', { code });
    }

    return {
        version: CONTRACT_VERSION,
        code,
        status: 'draft',
        title: requireText(input.title, 'title'),
        reason: requireText(input.reason, 'reason'),
        actor: { id: actorId, role: actorRole },
        targets,
        actions,
        requiredCapabilities: requiredCapabilitiesForActions(actions),
        idempotencyKey: requireText(input.idempotencyKey || `admin:${code}`, 'idempotencyKey'),
        metadata: isPlainObject(input.metadata) ? { ...input.metadata } : {},
        createdAt: now.toISOString(),
    };
}

function canTransitionOperation(fromStatus, toStatus) {
    const from = String(fromStatus || '').trim();
    const to = String(toStatus || '').trim();
    if (!OPERATION_STATUSES.includes(from) || !OPERATION_STATUSES.includes(to)) return false;
    return (STATUS_TRANSITIONS[from] || []).includes(to);
}

module.exports = {
    ACTION_CAPABILITIES,
    ACTION_TYPES,
    ADMIN_CAPABILITIES,
    ADMIN_ROLES,
    AdminOperationContractError,
    CONTRACT_VERSION,
    OPERATION_STATUSES,
    ROLE_CAPABILITIES,
    STATUS_TRANSITIONS,
    TARGET_KINDS,
    assertRoleCanDraftActions,
    canRole,
    canTransitionOperation,
    generateOperationCode,
    getRoleCapabilities,
    normalizeAction,
    normalizeAdminOperationInput,
    normalizeRole,
    normalizeTargetSelector,
    requiredCapabilitiesForActions,
};
