'use strict';

const {
    getHookTemplate,
    getPlayerHookAssignment,
} = require('./adminHookService');
const { getRewardPackage } = require('./adminRewardService');
const { getItemTemplateReadOnly } = require('./adminItemsReadApi');
const { getTraitTemplate } = require('./adminTraitService');

const HOOK_V2_VERSION = 2;
const HOOK_PRESENTATION_TYPES = Object.freeze([
    'narrative',
    'item',
    'trait',
    'title',
    'access',
    'mixed',
]);
const HOOK_VISIBILITIES = Object.freeze([
    'admin_only',
    'hidden',
    'player',
]);
const HOOK_TRIGGER_TYPES = Object.freeze([
    'manual',
    'on_assign',
    'on_item_use',
    'on_raid_complete',
    'on_hook_complete',
    'scheduled',
]);
const HOOK_LIFECYCLE_STAGES = Object.freeze([
    'assigned',
    'revealed',
    'in_progress',
    'completed',
    'claimed',
    'expired',
    'removed',
]);
const HOOK_EFFECT_EVENTS = Object.freeze([
    'on_assign',
    'on_reveal',
    'on_progress',
    'on_complete',
    'on_claim',
]);
const HOOK_EFFECT_TYPES = Object.freeze([
    'reward_package',
    'item',
    'trait',
    'title',
    'access',
]);
const HOOK_EFFECT_DELIVERIES = Object.freeze(['manual', 'operation']);

const AUTOMATIC_EFFECT_ACTIONS = Object.freeze({
    reward_package: 'reward.grant',
    item: 'player.item.grant',
    trait: 'player.trait.assign',
});

const STAGE_TRANSITIONS = Object.freeze({
    assigned: Object.freeze(['revealed', 'in_progress', 'completed', 'expired', 'removed']),
    revealed: Object.freeze(['in_progress', 'completed', 'expired', 'removed']),
    in_progress: Object.freeze(['completed', 'expired', 'removed']),
    completed: Object.freeze(['claimed', 'removed']),
    claimed: Object.freeze(['removed']),
    expired: Object.freeze(['removed']),
    removed: Object.freeze([]),
});

class AdminHookV2Error extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminHookV2Error';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function optionalText(value, maximum = 4000) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : null;
}

function requireText(value, field, maximum = 4000) {
    const text = optionalText(value, maximum);
    if (!text) {
        throw new AdminHookV2Error('missing_hook_v2_field', `${field} é obrigatório.`, 400, { field });
    }
    return text;
}

function normalizeKey(value, fallback = 'gancho') {
    return String(value || fallback)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || fallback;
}

function normalizeChoice(value, aliases, allowed, fallback, field) {
    const raw = String(value || fallback || '').trim().toLowerCase();
    const normalized = aliases[raw] || raw;
    if (!allowed.includes(normalized)) {
        throw new AdminHookV2Error('invalid_hook_v2_field', `${field} inválido.`, 400, {
            field,
            value: raw,
            allowed,
        });
    }
    return normalized;
}

function normalizePresentationType(value) {
    return normalizeChoice(value, {
        narrativo: 'narrative',
        narrativa: 'narrative',
        objeto: 'item',
        traco: 'trait',
        'traço': 'trait',
        titulo: 'title',
        'título': 'title',
        acesso: 'access',
        misto: 'mixed',
    }, HOOK_PRESENTATION_TYPES, 'narrative', 'Tipo de apresentação');
}

function normalizeVisibility(value) {
    return normalizeChoice(value, {
        adm: 'admin_only',
        admin: 'admin_only',
        privado: 'admin_only',
        oculto: 'hidden',
        secreto: 'hidden',
        jogador: 'player',
        visivel: 'player',
        'visível': 'player',
    }, HOOK_VISIBILITIES, 'player', 'Visibilidade');
}

function normalizeTrigger(value = {}) {
    const source = isPlainObject(value) ? value : { type: value };
    const type = normalizeChoice(source.type || source.kind || source.tipo, {
        manualmente: 'manual',
        vinculo: 'on_assign',
        'vínculo': 'on_assign',
        ao_vincular: 'on_assign',
        usar_item: 'on_item_use',
        item_use: 'on_item_use',
        concluir_raid: 'on_raid_complete',
        raid_complete: 'on_raid_complete',
        concluir_gancho: 'on_hook_complete',
        hook_complete: 'on_hook_complete',
        data: 'scheduled',
        agendado: 'scheduled',
    }, HOOK_TRIGGER_TYPES, 'manual', 'Gatilho');

    const reference = optionalText(
        source.reference || source.referenceKey || source.reference_key || source.ref || source.codigo,
        160
    );
    const scheduledAtRaw = optionalText(source.scheduledAt || source.scheduled_at || source.data, 80);
    let scheduledAt = null;
    if (scheduledAtRaw) {
        const timestamp = Date.parse(scheduledAtRaw);
        if (!Number.isFinite(timestamp)) {
            throw new AdminHookV2Error('invalid_hook_schedule', 'Data programada inválida.', 400, {
                scheduledAt: scheduledAtRaw,
            });
        }
        scheduledAt = new Date(timestamp).toISOString();
    }

    const needsReference = new Set(['on_item_use', 'on_raid_complete', 'on_hook_complete']);
    if (needsReference.has(type) && !reference) {
        throw new AdminHookV2Error('missing_hook_trigger_reference', 'O gatilho selecionado exige uma referência.', 400, {
            triggerType: type,
        });
    }
    if (type === 'scheduled' && !scheduledAt) {
        throw new AdminHookV2Error('missing_hook_schedule', 'O gatilho programado exige data e hora.', 400);
    }

    return stableValue({
        type,
        reference,
        scheduledAt,
        config: isPlainObject(source.config) ? stableValue(source.config) : {},
    });
}

function normalizeEffectType(value) {
    return normalizeChoice(value, {
        pacote: 'reward_package',
        recompensa: 'reward_package',
        reward: 'reward_package',
        reward_package_id: 'reward_package',
        objeto: 'item',
        item_template: 'item',
        traco: 'trait',
        'traço': 'trait',
        titulo: 'title',
        'título': 'title',
        acesso: 'access',
        desbloqueio: 'access',
    }, HOOK_EFFECT_TYPES, null, 'Tipo de efeito');
}

function normalizeEffectEvent(value) {
    return normalizeChoice(value, {
        assign: 'on_assign',
        vincular: 'on_assign',
        reveal: 'on_reveal',
        revelar: 'on_reveal',
        progress: 'on_progress',
        progresso: 'on_progress',
        complete: 'on_complete',
        concluir: 'on_complete',
        claim: 'on_claim',
        resgatar: 'on_claim',
    }, HOOK_EFFECT_EVENTS, 'on_complete', 'Etapa do efeito');
}

function normalizeEffectDelivery(value) {
    return normalizeChoice(value, {
        automatic: 'operation',
        automatico: 'operation',
        'automático': 'operation',
        op: 'operation',
        operacao: 'operation',
        'operação': 'operation',
        adm: 'manual',
    }, HOOK_EFFECT_DELIVERIES, 'manual', 'Modo de entrega');
}

function positiveInteger(value, field, fallback = 1, maximum = 1000) {
    const raw = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isInteger(raw) || raw < 1 || raw > maximum) {
        throw new AdminHookV2Error('invalid_hook_v2_field', `${field} inválido.`, 400, {
            field,
            minimum: 1,
            maximum,
        });
    }
    return raw;
}

function automaticActionForEffect(type, reference, quantity) {
    const actionType = AUTOMATIC_EFFECT_ACTIONS[type];
    if (!actionType) return null;
    if (type === 'reward_package') {
        return { type: actionType, payload: { packageId: reference.key } };
    }
    if (type === 'item') {
        return { type: actionType, payload: { templateKey: reference.key, quantity } };
    }
    if (type === 'trait') {
        return { type: actionType, payload: { traitId: reference.key } };
    }
    return null;
}

function normalizeEffect(value, index) {
    const source = isPlainObject(value) ? value : {};
    const type = normalizeEffectType(source.type || source.kind || source.tipo);
    const event = normalizeEffectEvent(source.event || source.stage || source.etapa);
    const delivery = normalizeEffectDelivery(source.delivery || source.mode || source.entrega);
    const rawReference = isPlainObject(source.reference) ? source.reference : {};
    const referenceKey = requireText(
        rawReference.key
            || rawReference.id
            || source.referenceKey
            || source.reference_key
            || source.packageId
            || source.package_id
            || source.templateKey
            || source.template_key
            || source.traitId
            || source.trait_id
            || source.key
            || source.codigo,
        `Referência do efeito ${index + 1}`,
        160
    );
    const referenceName = optionalText(
        rawReference.name || source.referenceName || source.reference_name || source.name || source.nome,
        180
    );
    const quantity = type === 'item'
        ? positiveInteger(source.quantity ?? source.quantidade ?? source.amount, `Quantidade do efeito ${index + 1}`, 1, 100)
        : 1;
    const id = normalizeKey(source.id || source.effectId || source.effect_id || `${event}_${type}_${index + 1}`, `effect_${index + 1}`);
    const label = optionalText(source.label || source.rotulo || source.rótulo, 180)
        || referenceName
        || referenceKey;
    const reference = stableValue({ key: referenceKey, name: referenceName });
    const operationAction = automaticActionForEffect(type, reference, quantity);

    if (delivery === 'operation' && !operationAction) {
        throw new AdminHookV2Error(
            'hook_effect_not_reversible',
            `O efeito ${type} ainda não possui executor OP- reversível para entrega automática.`,
            409,
            { type, supported: Object.keys(AUTOMATIC_EFFECT_ACTIONS) }
        );
    }

    return stableValue({
        id,
        event,
        type,
        delivery,
        label,
        reference,
        quantity,
        operationAction,
        notes: optionalText(source.notes || source.notas, 1000),
    });
}

function normalizeStageContent(value = {}) {
    const source = isPlainObject(value) ? value : {};
    const result = {};
    for (const stage of HOOK_LIFECYCLE_STAGES) {
        if (!isPlainObject(source[stage])) continue;
        result[stage] = stableValue({
            title: optionalText(source[stage].title || source[stage].titulo, 180),
            body: optionalText(source[stage].body || source[stage].text || source[stage].texto, 4000),
        });
    }
    return result;
}

function normalizeHookV2Spec(value = {}, options = {}) {
    const source = isPlainObject(value) ? value : {};
    const effectsSource = Array.isArray(source.effects || source.efeitos)
        ? (source.effects || source.efeitos)
        : [];
    if (effectsSource.length > 30) {
        throw new AdminHookV2Error('hook_effect_limit', 'Um Gancho aceita no máximo 30 efeitos.', 400, {
            maximum: 30,
        });
    }
    const effects = effectsSource.map(normalizeEffect);
    const ids = new Set();
    for (const effect of effects) {
        if (ids.has(effect.id)) {
            throw new AdminHookV2Error('duplicate_hook_effect', `O efeito ${effect.id} está duplicado.`, 409, {
                effectId: effect.id,
            });
        }
        ids.add(effect.id);
    }

    return stableValue({
        version: HOOK_V2_VERSION,
        presentationType: normalizePresentationType(
            source.presentationType || source.presentation_type || source.type || source.tipo || options.presentationType
        ),
        visibility: normalizeVisibility(source.visibility || source.visibilidade || options.visibility),
        trigger: normalizeTrigger(source.trigger || source.gatilho || options.trigger || { type: 'manual' }),
        claimRequired: Boolean(source.claimRequired ?? source.claim_required ?? source.exigeResgate ?? false),
        playerSummary: optionalText(source.playerSummary || source.player_summary || source.resumoJogador, 1000),
        stageContent: normalizeStageContent(source.stageContent || source.stage_content || source.etapas),
        effects,
    });
}

function defaultHookV2Spec(template = {}) {
    const category = String(template.category || '').trim().toLowerCase();
    const presentationType = HOOK_PRESENTATION_TYPES.includes(category) ? category : 'narrative';
    return normalizeHookV2Spec({
        presentationType,
        visibility: 'player',
        trigger: { type: 'manual' },
        effects: [],
    });
}

function readHookV2Spec(template = {}) {
    const raw = template?.metadata?.hookV2;
    return raw ? normalizeHookV2Spec(raw) : defaultHookV2Spec(template);
}

function extractHookV2Payload(payload = {}) {
    if (isPlainObject(payload.hookV2)) return payload.hookV2;
    if (isPlainObject(payload.hook_v2)) return payload.hook_v2;
    if (isPlainObject(payload.metadata?.hookV2)) return payload.metadata.hookV2;
    const keys = [
        'presentationType', 'presentation_type', 'visibility', 'visibilidade',
        'trigger', 'gatilho', 'effects', 'efeitos', 'claimRequired', 'claim_required',
        'playerSummary', 'player_summary', 'stageContent', 'stage_content',
    ];
    if (!keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) return null;
    return Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(payload, key)).map((key) => [key, payload[key]]));
}

async function resolveEffectReference(db, effect) {
    try {
        if (effect.type === 'reward_package') {
            const value = await getRewardPackage(db, effect.reference.key, { nullIfMissing: true });
            return value
                ? { ok: true, type: effect.type, key: value.id, name: value.name, status: value.status, version: value.version }
                : { ok: false, type: effect.type, key: effect.reference.key, reason: 'reward_package_not_found' };
        }
        if (effect.type === 'item') {
            const value = await getItemTemplateReadOnly(db, effect.reference.key);
            return value
                ? { ok: true, type: effect.type, key: value.templateKey || value.template_key || effect.reference.key, name: value.name || value.itemName || value.item_name || effect.label, status: value.active === false ? 'archived' : 'active' }
                : { ok: false, type: effect.type, key: effect.reference.key, reason: 'item_template_not_found' };
        }
        if (effect.type === 'trait') {
            const value = await getTraitTemplate(db, effect.reference.key);
            return value
                ? { ok: true, type: effect.type, key: value.id, name: value.name, status: value.status, version: value.version }
                : { ok: false, type: effect.type, key: effect.reference.key, reason: 'trait_not_found' };
        }
        return {
            ok: true,
            type: effect.type,
            key: effect.reference.key,
            name: effect.reference.name || effect.label,
            status: 'inline',
        };
    } catch (error) {
        return {
            ok: false,
            type: effect.type,
            key: effect.reference.key,
            reason: error?.code || 'reference_resolution_failed',
        };
    }
}

async function validateHookV2References(db, spec) {
    const references = [];
    for (const effect of spec.effects) {
        const resolved = await resolveEffectReference(db, effect);
        references.push({ effectId: effect.id, ...resolved });
    }
    const invalid = references.filter((entry) => !entry.ok);
    if (invalid.length) {
        throw new AdminHookV2Error(
            'hook_effect_reference_not_found',
            'Um ou mais efeitos apontam para referências inexistentes.',
            409,
            { invalid, references }
        );
    }
    return references;
}

function effectEventForStage(stage) {
    return {
        assigned: 'on_assign',
        revealed: 'on_reveal',
        in_progress: 'on_progress',
        completed: 'on_complete',
        claimed: 'on_claim',
    }[stage] || null;
}

function effectPlanForStage(spec, stage) {
    const event = effectEventForStage(stage);
    return event ? spec.effects.filter((effect) => effect.event === event) : [];
}

function assignmentStage(assignment = {}) {
    const stored = assignment?.metadata?.hookV2Lifecycle?.stage;
    if (HOOK_LIFECYCLE_STAGES.includes(stored)) return stored;
    if (assignment.status === 'completed') return 'completed';
    if (assignment.status === 'removed') return 'removed';
    return 'assigned';
}

function normalizeLifecycleStage(value) {
    return normalizeChoice(value, {
        vinculado: 'assigned',
        atribuido: 'assigned',
        'atribuído': 'assigned',
        revelado: 'revealed',
        progresso: 'in_progress',
        andamento: 'in_progress',
        concluido: 'completed',
        'concluído': 'completed',
        resgatado: 'claimed',
        expirado: 'expired',
        removido: 'removed',
    }, HOOK_LIFECYCLE_STAGES, null, 'Etapa do Gancho');
}

function assertLifecycleTransition(from, to) {
    if (from === to) return;
    const allowed = STAGE_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
        throw new AdminHookV2Error('invalid_hook_transition', `Não é possível mover o Gancho de ${from} para ${to}.`, 409, {
            from,
            to,
            allowed,
        });
    }
}

function lifecycleMetadata(assignment, spec, targetStage, options = {}) {
    const from = assignmentStage(assignment);
    const to = normalizeLifecycleStage(targetStage);
    assertLifecycleTransition(from, to);
    const now = options.timestamp || new Date().toISOString();
    const previous = isPlainObject(assignment?.metadata?.hookV2Lifecycle)
        ? assignment.metadata.hookV2Lifecycle
        : {};
    const lifecycle = {
        ...previous,
        version: HOOK_V2_VERSION,
        stage: to,
        previousStage: from,
        updatedAt: now,
    };
    const timestampFields = {
        assigned: 'assignedAt',
        revealed: 'revealedAt',
        in_progress: 'progressedAt',
        completed: 'completedAt',
        claimed: 'claimedAt',
        expired: 'expiredAt',
        removed: 'removedAt',
    };
    const field = timestampFields[to];
    if (field && !lifecycle[field]) lifecycle[field] = now;
    const effectPlan = effectPlanForStage(spec, to);
    return stableValue({
        ...(assignment?.metadata || {}),
        hookV2Lifecycle: lifecycle,
        hookV2SpecSnapshot: spec,
        hookV2PendingEffects: effectPlan,
    });
}

async function prepareTemplatePayload(db, action, existing = null) {
    const payload = action.payload || {};
    const extracted = extractHookV2Payload(payload);
    if (!extracted && existing) return null;
    const spec = normalizeHookV2Spec(extracted || defaultHookV2Spec(payload));
    const references = await validateHookV2References(db, spec);
    payload.metadata = stableValue({
        ...(existing?.metadata || {}),
        ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
        hookV2: spec,
        hookV2References: references,
    });
    action.payload = payload;
    return { spec, references };
}

function mergeAssignmentMetadata(before, payload) {
    return stableValue({
        ...(before?.metadata || {}),
        ...(isPlainObject(payload?.metadata) ? payload.metadata : {}),
    });
}

function decorateHookExecutors(executors = {}) {
    const result = { ...executors };

    for (const type of ['catalog.hook.create', 'catalog.hook.update']) {
        const base = result[type];
        if (!base) continue;
        result[type] = {
            ...base,
            async preview(context) {
                const existing = type === 'catalog.hook.update'
                    ? await getHookTemplate(context.db, context.action.payload?.hookId || context.action.payload?.id)
                    : null;
                await prepareTemplatePayload(context.db, context.action, existing);
                return base.preview(context);
            },
        };
    }

    const assign = result['player.hook.assign'];
    if (assign) {
        result['player.hook.assign'] = {
            ...assign,
            async preview(context) {
                const template = await getHookTemplate(context.db, context.action.payload?.hookId || context.action.payload?.id);
                const spec = readHookV2Spec(template);
                const shell = { status: 'active', metadata: {} };
                context.action.payload = {
                    ...(context.action.payload || {}),
                    metadata: lifecycleMetadata(shell, spec, 'assigned'),
                };
                const preview = await assign.preview(context);
                return {
                    ...preview,
                    after: {
                        ...preview.after,
                        v2: {
                            spec,
                            stage: 'assigned',
                            effectPlan: effectPlanForStage(spec, 'assigned'),
                        },
                    },
                };
            },
        };
    }

    const update = result['player.hook.update'];
    if (update) {
        result['player.hook.update'] = {
            ...update,
            async preview(context) {
                const assignmentId = context.action.payload?.assignmentId || context.action.payload?.assignment_id;
                const before = await getPlayerHookAssignment(context.db, assignmentId);
                const spec = before.metadata?.hookV2SpecSnapshot || readHookV2Spec(before.template);
                const requestedStage = context.action.payload?.lifecycleStage
                    || context.action.payload?.lifecycle_stage
                    || context.action.payload?.stage
                    || context.action.payload?.etapa;
                context.action.payload = {
                    ...(context.action.payload || {}),
                    metadata: requestedStage
                        ? lifecycleMetadata(before, spec, requestedStage)
                        : mergeAssignmentMetadata(before, context.action.payload || {}),
                };
                const preview = await update.preview(context);
                const stage = assignmentStage(preview.after);
                return {
                    ...preview,
                    after: {
                        ...preview.after,
                        v2: { spec, stage, effectPlan: effectPlanForStage(spec, stage) },
                    },
                };
            },
        };
    }

    for (const [type, targetStage] of [
        ['player.hook.complete', 'completed'],
        ['player.hook.remove', 'removed'],
    ]) {
        const base = result[type];
        if (!base) continue;
        result[type] = {
            ...base,
            async preview(context) {
                const assignmentId = context.action.payload?.assignmentId || context.action.payload?.assignment_id;
                const before = await getPlayerHookAssignment(context.db, assignmentId);
                const spec = before.metadata?.hookV2SpecSnapshot || readHookV2Spec(before.template);
                const preview = await base.preview(context);
                const metadata = lifecycleMetadata(before, spec, targetStage);
                return {
                    ...preview,
                    after: {
                        ...preview.after,
                        metadata,
                        v2: { spec, stage: targetStage, effectPlan: effectPlanForStage(spec, targetStage) },
                    },
                };
            },
            async apply(context) {
                const applied = await base.apply(context);
                const metadata = context.after?.metadata || {};
                await context.db.run(
                    'UPDATE clover_player_hooks SET metadata_json = ? WHERE id = ?',
                    [JSON.stringify(metadata), context.after.id]
                );
                const current = await getPlayerHookAssignment(context.db, context.after.id);
                return { ...applied, after: current };
            },
        };
    }

    return result;
}

function getHookV2Schema() {
    return {
        ok: true,
        version: HOOK_V2_VERSION,
        presentationTypes: [...HOOK_PRESENTATION_TYPES],
        visibilities: [...HOOK_VISIBILITIES],
        triggerTypes: [...HOOK_TRIGGER_TYPES],
        lifecycleStages: [...HOOK_LIFECYCLE_STAGES],
        lifecycleTransitions: STAGE_TRANSITIONS,
        effectEvents: [...HOOK_EFFECT_EVENTS],
        effectTypes: [...HOOK_EFFECT_TYPES],
        effectDeliveries: [...HOOK_EFFECT_DELIVERIES],
        automaticEffectActions: AUTOMATIC_EFFECT_ACTIONS,
    };
}

module.exports = {
    AUTOMATIC_EFFECT_ACTIONS,
    AdminHookV2Error,
    HOOK_EFFECT_DELIVERIES,
    HOOK_EFFECT_EVENTS,
    HOOK_EFFECT_TYPES,
    HOOK_LIFECYCLE_STAGES,
    HOOK_PRESENTATION_TYPES,
    HOOK_TRIGGER_TYPES,
    HOOK_V2_VERSION,
    HOOK_VISIBILITIES,
    STAGE_TRANSITIONS,
    assignmentStage,
    assertLifecycleTransition,
    decorateHookExecutors,
    defaultHookV2Spec,
    effectPlanForStage,
    extractHookV2Payload,
    getHookV2Schema,
    lifecycleMetadata,
    normalizeEffect,
    normalizeHookV2Spec,
    normalizeLifecycleStage,
    readHookV2Spec,
    validateHookV2References,
};
