'use strict';

const crypto = require('crypto');
const base = require('./adminOperationServiceBase');
const { applyAtomicAdminOperation } = require('./adminOperationAtomicService');
const { getAdminOperationExecutors } = require('./adminOperationRegistry');
const { getRewardPackage } = require('./adminRewardService');
const {
    assertAtomicExecutors,
    operationExecutionPolicy,
    requestedExecutionPolicy,
    withExecutionPolicy,
} = require('./adminOperationPolicy');

function executorsFor(options = {}) {
    return options.executors || getAdminOperationExecutors();
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function hashValue(value) {
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(stableValue(value ?? null)))
        .digest('hex');
}

function optionalText(value, maximum = 4000) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : null;
}

function requireRewardReference(effect, keys, label) {
    for (const key of keys) {
        const value = optionalText(effect?.[key], 160);
        if (value) return value;
    }
    throw new base.AdminOperationServiceError(
        'invalid_reward_effect_reference',
        `${label} da recompensa está sem referência canônica.`,
        400,
        { effectType: String(effect?.type || '').trim().toLowerCase(), required: keys }
    );
}

function normalizeRewardPackageEffects(value) {
    const source = Array.isArray(value) ? value : [];
    if (source.length > 30) {
        throw new base.AdminOperationServiceError(
            'reward_effects_too_large',
            'Um pacote aceita no máximo 30 efeitos adicionais.',
            400
        );
    }
    return source.map((raw, index) => {
        const effect = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const type = String(effect.type || effect.kind || '').trim().toLowerCase();
        if (type === 'title' || type === 'titulo') {
            const titleKey = requireRewardReference(effect, ['titleKey', 'title_key', 'referenceKey', 'key'], 'O Título');
            return {
                type: 'title',
                action: {
                    type: 'player.title.grant',
                    label: optionalText(effect.label, 160) || `Conceder Título ${titleKey}`,
                    payload: {
                        titleKey,
                        reason: optionalText(effect.reason || effect.notes, 2000) || 'Efeito de pacote de recompensa.',
                    },
                },
            };
        }
        if (type === 'trait' || type === 'traco' || type === 'traço') {
            const traitId = requireRewardReference(effect, ['traitId', 'trait_id', 'referenceKey', 'key'], 'O Traço');
            const slotKey = optionalText(effect.slotKey || effect.slot_key, 80);
            return {
                type: 'trait',
                action: {
                    type: 'player.trait.assign',
                    label: optionalText(effect.label, 160) || `Conceder Traço ${traitId}`,
                    payload: {
                        traitId,
                        ...(slotKey ? { slotKey } : {}),
                    },
                },
            };
        }
        if (type === 'hook' || type === 'gancho') {
            const hookId = requireRewardReference(effect, ['hookId', 'hook_id', 'referenceKey', 'key'], 'O Gancho');
            const priority = Number(effect.priority ?? 0);
            if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1_000_000) {
                throw new base.AdminOperationServiceError(
                    'invalid_reward_hook_priority',
                    `Prioridade inválida no efeito ${index + 1} do pacote.`,
                    400,
                    { priority: effect.priority }
                );
            }
            return {
                type: 'hook',
                action: {
                    type: 'player.hook.assign',
                    label: optionalText(effect.label, 160) || `Vincular Gancho ${hookId}`,
                    payload: {
                        hookId,
                        priority,
                        ...(optionalText(effect.developmentText || effect.development_text, 8000)
                            ? { developmentText: optionalText(effect.developmentText || effect.development_text, 8000) }
                            : {}),
                        ...(optionalText(effect.privateNotes || effect.private_notes, 8000)
                            ? { privateNotes: optionalText(effect.privateNotes || effect.private_notes, 8000) }
                            : {}),
                    },
                },
            };
        }
        if (type === 'access' || type === 'acesso') {
            throw new base.AdminOperationServiceError(
                'reward_access_effect_not_supported',
                'Acesso ainda não possui um domínio canônico de recompensa e não pode ser automatizado.',
                409,
                { effectIndex: index }
            );
        }
        throw new base.AdminOperationServiceError(
            'unsupported_reward_effect',
            `Tipo de efeito adicional não suportado: ${type || '(vazio)'}.`,
            400,
            { effectIndex: index, supported: ['title', 'trait', 'hook'] }
        );
    });
}

async function materializeRewardPackageEffects(db, input = {}, options = {}) {
    const actions = Array.isArray(input.actions) ? input.actions : [];
    if (!actions.some((action) => action?.type === 'reward.grant')) return input;

    const getPackage = options.getRewardPackage || getRewardPackage;
    const expanded = [];
    const snapshots = [];
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        expanded.push(action);
        if (action?.type !== 'reward.grant') continue;

        const packageId = optionalText(action.payload?.packageId || action.payload?.id, 80);
        // Concessão rápida usa entries inline e não referencia pacote persistido.
        if (!packageId) continue;
        const rewardPackage = await getPackage(db, packageId);
        const rewardEffects = normalizeRewardPackageEffects(rewardPackage?.metadata?.rewardEffects);
        const fingerprint = hashValue({
            id: rewardPackage.id,
            version: rewardPackage.version,
            rewardEffects: rewardPackage?.metadata?.rewardEffects || [],
        });
        snapshots.push({
            actionIndex,
            packageId: rewardPackage.id,
            packageVersion: Number(rewardPackage.version || 0),
            effectCount: rewardEffects.length,
            fingerprint,
        });
        for (const [effectIndex, effect] of rewardEffects.entries()) {
            expanded.push({
                ...effect.action,
                metadata: {
                    ...(effect.action.metadata || {}),
                    rewardPackageEffect: true,
                    packageId: rewardPackage.id,
                    packageVersion: Number(rewardPackage.version || 0),
                    sourceActionIndex: actionIndex,
                    effectIndex,
                    effectType: effect.type,
                },
            });
        }
    }

    return {
        ...input,
        actions: expanded,
        metadata: {
            ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
            rewardEffectPackageSnapshots: snapshots,
        },
    };
}

async function assertRewardEffectSnapshotsFresh(db, operation, options = {}) {
    const snapshots = Array.isArray(operation?.metadata?.rewardEffectPackageSnapshots)
        ? operation.metadata.rewardEffectPackageSnapshots
        : [];
    if (!snapshots.length) return;
    const getPackage = options.getRewardPackage || getRewardPackage;
    for (const snapshot of snapshots) {
        const rewardPackage = await getPackage(db, snapshot.packageId);
        const currentFingerprint = hashValue({
            id: rewardPackage.id,
            version: rewardPackage.version,
            rewardEffects: rewardPackage?.metadata?.rewardEffects || [],
        });
        if (currentFingerprint !== snapshot.fingerprint) {
            throw new base.AdminOperationServiceError(
                'reward_effect_package_changed_after_draft',
                'Os efeitos do pacote mudaram depois da criação da OP-. Crie uma nova operação.',
                409,
                {
                    packageId: snapshot.packageId,
                    draftedVersion: snapshot.packageVersion,
                    currentVersion: Number(rewardPackage.version || 0),
                }
            );
        }
    }
}

async function createAdminOperation(db, input, actor, options = {}) {
    const withRewardEffects = await materializeRewardPackageEffects(db, input, options);
    const decorated = withExecutionPolicy(withRewardEffects);
    if (requestedExecutionPolicy(decorated).policy === 'atomic') {
        assertAtomicExecutors(decorated.actions, executorsFor(options));
    }
    return base.createAdminOperation(db, decorated, actor, options);
}

async function simulateAdminOperation(db, code, actor, options = {}) {
    const operation = await base.getOperationByCode(db, code);
    await assertRewardEffectSnapshotsFresh(db, operation, options);
    if (operationExecutionPolicy(operation) === 'atomic') {
        assertAtomicExecutors(operation.actions, executorsFor(options));
    }
    return base.simulateAdminOperation(db, code, actor, options);
}

async function applyAdminOperation(db, code, actor, options = {}) {
    const operation = await base.getOperationByCode(db, code, { includeUnits: true });
    await assertRewardEffectSnapshotsFresh(db, operation, options);
    if (operationExecutionPolicy(operation) === 'atomic') {
        return applyAtomicAdminOperation(db, code, actor, {
            ...options,
            executors: executorsFor(options),
        });
    }
    return base.applyAdminOperation(db, code, actor, options);
}

module.exports = {
    ...base,
    applyAdminOperation,
    assertRewardEffectSnapshotsFresh,
    createAdminOperation,
    materializeRewardPackageEffects,
    normalizeRewardPackageEffects,
    simulateAdminOperation,
};
