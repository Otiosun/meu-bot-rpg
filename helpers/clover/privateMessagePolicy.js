'use strict';

const POLICY_CATEGORIES = Object.freeze({
    REACTIVE: 'reactive',
    TRANSACTIONAL: 'transactional',
    PROACTIVE_SINGLE: 'proactive_single',
    PROACTIVE_BULK: 'proactive_bulk',
    NON_PRIVATE: 'non_private',
    INFRASTRUCTURE: 'infrastructure',
    UNKNOWN: 'unknown',
});

const SOURCE_DISPOSITIONS = Object.freeze({
    appearance_result: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Resultado de aparência',
    },
    history_adjustment: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Ajuste de história/persona',
    },
    game_release: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Liberação do jogo',
    },
    post_ficha: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Instruções pós-ficha',
    },
    linkoff_player: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Link do grupo OFF',
    },
    spell_review_invite: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Convite do grupo de avaliação',
    },
    community_exit_confirmation: {
        category: POLICY_CATEGORIES.TRANSACTIONAL,
        disposition: 'preserve',
        label: 'Confirmação de saída/retorno',
    },
    command_reply: {
        category: POLICY_CATEGORIES.REACTIVE,
        disposition: 'preserve',
        label: 'Resposta a comando',
    },
    anti_ghost_reply: {
        category: POLICY_CATEGORIES.REACTIVE,
        disposition: 'preserve',
        label: 'Resposta privada do anti-ghost',
    },
    return_bonus_manual: {
        category: POLICY_CATEGORIES.PROACTIVE_SINGLE,
        disposition: 'manual_confirm_only',
        label: 'Incentivo manual individual',
    },
    anti_ghost_activation: {
        category: POLICY_CATEGORIES.PROACTIVE_SINGLE,
        disposition: 'disabled_by_default',
        label: 'Aviso inicial do anti-ghost',
    },
    anti_ghost_notice: {
        category: POLICY_CATEGORIES.PROACTIVE_SINGLE,
        disposition: 'disabled_by_default',
        label: 'Avisos escalonados do anti-ghost',
    },
    anti_ghost_return_bonus: {
        category: POLICY_CATEGORIES.PROACTIVE_SINGLE,
        disposition: 'disabled_by_default',
        label: 'Bônus automático de retorno',
    },
    weekly_checklist_reset: {
        category: POLICY_CATEGORIES.PROACTIVE_SINGLE,
        disposition: 'disabled_by_default',
        label: 'Checklist semanal automático',
    },
    transmit_approved_players: {
        category: POLICY_CATEGORIES.PROACTIVE_BULK,
        disposition: 'bulk_blocked_by_default',
        label: 'Transmissão para fichas aprovadas',
    },
    transmit_pending_history: {
        category: POLICY_CATEGORIES.PROACTIVE_BULK,
        disposition: 'bulk_blocked_by_default',
        label: 'Transmissão para histórias pendentes',
    },
});

function isEnabled(env, key) {
    return String(env?.[key] || '').trim() === '1';
}

function normalizeCategory(category) {
    const value = String(category || '').trim().toLowerCase();
    return Object.values(POLICY_CATEGORIES).includes(value)
        ? value
        : POLICY_CATEGORIES.UNKNOWN;
}

function normalizeSource(source) {
    return String(source || '').trim().toLowerCase();
}

function resolveSourcePolicy(source, fallbackCategory = POLICY_CATEGORIES.UNKNOWN) {
    const sourceKey = normalizeSource(source);
    const known = SOURCE_DISPOSITIONS[sourceKey];
    if (known) {
        return {
            source: sourceKey,
            ...known,
        };
    }

    return {
        source: sourceKey || null,
        category: normalizeCategory(fallbackCategory),
        disposition: 'review_required',
        label: sourceKey || 'Fluxo não classificado',
    };
}

function categoryDefaults(category) {
    switch (normalizeCategory(category)) {
    case POLICY_CATEGORIES.REACTIVE:
        return {
            dailyBudgetExempt: true,
            quietHoursExempt: true,
            maxAttempts: 1,
            dedupeRequired: false,
            minimumSpacingSeconds: 0,
        };
    case POLICY_CATEGORIES.TRANSACTIONAL:
        return {
            dailyBudgetExempt: true,
            quietHoursExempt: true,
            maxAttempts: 2,
            dedupeRequired: true,
            minimumSpacingSeconds: 0,
        };
    case POLICY_CATEGORIES.PROACTIVE_SINGLE:
        return {
            dailyBudgetExempt: false,
            quietHoursExempt: false,
            maxAttempts: 1,
            dedupeRequired: true,
            minimumSpacingSeconds: 60,
        };
    case POLICY_CATEGORIES.PROACTIVE_BULK:
        return {
            dailyBudgetExempt: false,
            quietHoursExempt: false,
            maxAttempts: 1,
            dedupeRequired: true,
            minimumSpacingSeconds: 60,
        };
    default:
        return {
            dailyBudgetExempt: true,
            quietHoursExempt: true,
            maxAttempts: 0,
            dedupeRequired: false,
            minimumSpacingSeconds: 0,
        };
    }
}

function blocked(policy, reason, extra = {}) {
    return {
        allowed: false,
        reason,
        policy,
        ...categoryDefaults(policy.category),
        ...extra,
    };
}

function allowed(policy, extra = {}) {
    return {
        allowed: true,
        reason: 'allowed',
        policy,
        ...categoryDefaults(policy.category),
        ...extra,
    };
}

function evaluatePrivateMessagePolicy(input = {}, env = process.env) {
    const sourcePolicy = resolveSourcePolicy(input.source, input.category);
    const category = normalizeCategory(sourcePolicy.category);
    const policy = {
        ...sourcePolicy,
        category,
    };

    const targetCount = Math.max(0, Number(input.targetCount || 1));
    const explicitConfirmation = input.explicitConfirmation === true;
    const hasDedupeKey = Boolean(String(input.dedupeKey || '').trim());
    const proactiveEnabled = isEnabled(env, 'CLOVER_PV_PROACTIVE_ENABLED');
    const bulkEnabled = isEnabled(env, 'CLOVER_PV_BULK_ENABLED');
    const bulkDailyLimit = Math.max(
        1,
        Math.min(100, Number(env?.CLOVER_PV_BULK_DAILY_LIMIT || 20) || 20)
    );

    if (category === POLICY_CATEGORIES.NON_PRIVATE || category === POLICY_CATEGORIES.INFRASTRUCTURE) {
        return allowed(policy, {
            appliesToPrivatePolicy: false,
            targetCount,
        });
    }

    if (category === POLICY_CATEGORIES.UNKNOWN || policy.disposition === 'review_required') {
        return blocked(policy, 'classification_required', {
            appliesToPrivatePolicy: true,
            targetCount,
        });
    }

    if (category === POLICY_CATEGORIES.REACTIVE) {
        return allowed(policy, {
            appliesToPrivatePolicy: true,
            targetCount,
        });
    }

    if (category === POLICY_CATEGORIES.TRANSACTIONAL) {
        if (!hasDedupeKey) {
            return blocked(policy, 'transactional_dedupe_required', {
                appliesToPrivatePolicy: true,
                targetCount,
            });
        }
        return allowed(policy, {
            appliesToPrivatePolicy: true,
            targetCount,
        });
    }

    if (category === POLICY_CATEGORIES.PROACTIVE_SINGLE) {
        if (!proactiveEnabled) {
            return blocked(policy, 'proactive_disabled', {
                appliesToPrivatePolicy: true,
                targetCount,
            });
        }
        if (policy.disposition === 'disabled_by_default') {
            return blocked(policy, 'source_disabled_by_default', {
                appliesToPrivatePolicy: true,
                targetCount,
            });
        }
        if (!explicitConfirmation) {
            return blocked(policy, 'explicit_confirmation_required', {
                appliesToPrivatePolicy: true,
                targetCount,
            });
        }
        if (targetCount !== 1) {
            return blocked(policy, 'single_target_required', {
                appliesToPrivatePolicy: true,
                targetCount,
            });
        }
        if (!hasDedupeKey) {
            return blocked(policy, 'proactive_dedupe_required', {
                appliesToPrivatePolicy: true,
                targetCount,
            });
        }
        return allowed(policy, {
            appliesToPrivatePolicy: true,
            targetCount,
        });
    }

    if (category === POLICY_CATEGORIES.PROACTIVE_BULK) {
        if (!proactiveEnabled || !bulkEnabled) {
            return blocked(policy, 'bulk_disabled', {
                appliesToPrivatePolicy: true,
                targetCount,
                bulkDailyLimit,
            });
        }
        if (!explicitConfirmation) {
            return blocked(policy, 'explicit_confirmation_required', {
                appliesToPrivatePolicy: true,
                targetCount,
                bulkDailyLimit,
            });
        }
        if (targetCount < 1 || targetCount > bulkDailyLimit) {
            return blocked(policy, 'bulk_limit_exceeded', {
                appliesToPrivatePolicy: true,
                targetCount,
                bulkDailyLimit,
            });
        }
        if (!hasDedupeKey) {
            return blocked(policy, 'proactive_dedupe_required', {
                appliesToPrivatePolicy: true,
                targetCount,
                bulkDailyLimit,
            });
        }
        return allowed(policy, {
            appliesToPrivatePolicy: true,
            targetCount,
            bulkDailyLimit,
        });
    }

    return blocked(policy, 'unsupported_category', {
        appliesToPrivatePolicy: true,
        targetCount,
    });
}

module.exports = {
    POLICY_CATEGORIES,
    SOURCE_DISPOSITIONS,
    categoryDefaults,
    evaluatePrivateMessagePolicy,
    normalizeCategory,
    resolveSourcePolicy,
};
