'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    POLICY_CATEGORIES,
    SOURCE_DISPOSITIONS,
    evaluatePrivateMessagePolicy,
    resolveSourcePolicy,
} = require('../helpers/clover/privateMessagePolicy');

const NO_FLAGS = Object.freeze({});
const PROACTIVE_FLAGS = Object.freeze({
    CLOVER_PV_PROACTIVE_ENABLED: '1',
});
const BULK_FLAGS = Object.freeze({
    CLOVER_PV_PROACTIVE_ENABLED: '1',
    CLOVER_PV_BULK_ENABLED: '1',
    CLOVER_PV_BULK_DAILY_LIMIT: '20',
});

test('respostas reativas ficam fora do orçamento diário', () => {
    const result = evaluatePrivateMessagePolicy({
        source: 'command_reply',
        targetCount: 1,
    }, NO_FLAGS);

    assert.equal(result.allowed, true);
    assert.equal(result.policy.category, POLICY_CATEGORIES.REACTIVE);
    assert.equal(result.dailyBudgetExempt, true);
    assert.equal(result.quietHoursExempt, true);
    assert.equal(result.maxAttempts, 1);
});

test('transações críticas são preservadas, mas exigem dedupe por evento', () => {
    for (const source of [
        'appearance_result',
        'history_adjustment',
        'game_release',
        'post_ficha',
        'linkoff_player',
        'spell_review_invite',
        'community_exit_confirmation',
    ]) {
        const blocked = evaluatePrivateMessagePolicy({ source }, NO_FLAGS);
        assert.equal(blocked.allowed, false, source);
        assert.equal(blocked.reason, 'transactional_dedupe_required', source);
        assert.equal(blocked.dailyBudgetExempt, true, source);

        const allowed = evaluatePrivateMessagePolicy({
            source,
            dedupeKey: `${source}:player:event`,
        }, NO_FLAGS);
        assert.equal(allowed.allowed, true, source);
        assert.equal(allowed.policy.category, POLICY_CATEGORIES.TRANSACTIONAL, source);
        assert.equal(allowed.dailyBudgetExempt, true, source);
        assert.equal(allowed.maxAttempts, 2, source);
    }
});

test('checklist, avisos e bônus automáticos permanecem bloqueados mesmo com flag geral', () => {
    for (const source of [
        'anti_ghost_activation',
        'anti_ghost_notice',
        'anti_ghost_return_bonus',
        'weekly_checklist_reset',
    ]) {
        const result = evaluatePrivateMessagePolicy({
            source,
            explicitConfirmation: true,
            dedupeKey: `${source}:player:period`,
        }, PROACTIVE_FLAGS);

        assert.equal(result.allowed, false, source);
        assert.equal(result.reason, 'source_disabled_by_default', source);
        assert.equal(result.dailyBudgetExempt, false, source);
        assert.equal(result.maxAttempts, 1, source);
    }
});

test('incentivo manual individual exige flag, confirmação, alvo único e dedupe', () => {
    const base = {
        source: 'return_bonus_manual',
        targetCount: 1,
        explicitConfirmation: true,
        dedupeKey: 'return_bonus_manual:player:offer',
    };

    assert.equal(
        evaluatePrivateMessagePolicy(base, NO_FLAGS).reason,
        'proactive_disabled'
    );
    assert.equal(
        evaluatePrivateMessagePolicy({ ...base, explicitConfirmation: false }, PROACTIVE_FLAGS).reason,
        'explicit_confirmation_required'
    );
    assert.equal(
        evaluatePrivateMessagePolicy({ ...base, targetCount: 2 }, PROACTIVE_FLAGS).reason,
        'single_target_required'
    );
    assert.equal(
        evaluatePrivateMessagePolicy({ ...base, dedupeKey: null }, PROACTIVE_FLAGS).reason,
        'proactive_dedupe_required'
    );

    const result = evaluatePrivateMessagePolicy(base, PROACTIVE_FLAGS);
    assert.equal(result.allowed, true);
    assert.equal(result.dailyBudgetExempt, false);
    assert.equal(result.minimumSpacingSeconds, 60);
});

test('transmissões em massa exigem duas flags, confirmação, dedupe e limite', () => {
    const base = {
        source: 'transmit_approved_players',
        targetCount: 10,
        explicitConfirmation: true,
        dedupeKey: 'broadcast:approved:campaign-1',
    };

    assert.equal(
        evaluatePrivateMessagePolicy(base, PROACTIVE_FLAGS).reason,
        'bulk_disabled'
    );
    assert.equal(
        evaluatePrivateMessagePolicy({ ...base, explicitConfirmation: false }, BULK_FLAGS).reason,
        'explicit_confirmation_required'
    );
    assert.equal(
        evaluatePrivateMessagePolicy({ ...base, targetCount: 21 }, BULK_FLAGS).reason,
        'bulk_limit_exceeded'
    );
    assert.equal(
        evaluatePrivateMessagePolicy({ ...base, dedupeKey: null }, BULK_FLAGS).reason,
        'proactive_dedupe_required'
    );

    const result = evaluatePrivateMessagePolicy(base, BULK_FLAGS);
    assert.equal(result.allowed, true);
    assert.equal(result.bulkDailyLimit, 20);
    assert.equal(result.maxAttempts, 1);
    assert.equal(result.minimumSpacingSeconds, 60);
});

test('fluxo desconhecido falha fechado', () => {
    const result = evaluatePrivateMessagePolicy({
        source: 'something_new',
        category: 'unknown',
        targetCount: 1,
    }, BULK_FLAGS);

    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'classification_required');
    assert.equal(result.policy.disposition, 'review_required');
});

test('grupo e infraestrutura não entram na política de PV', () => {
    for (const category of [
        POLICY_CATEGORIES.NON_PRIVATE,
        POLICY_CATEGORIES.INFRASTRUCTURE,
    ]) {
        const result = evaluatePrivateMessagePolicy({
            source: null,
            category,
        }, NO_FLAGS);

        assert.equal(result.allowed, true);
        assert.equal(result.appliesToPrivatePolicy, false);
    }
});

test('matriz de fontes mantém o corte aprovado', () => {
    assert.equal(SOURCE_DISPOSITIONS.appearance_result.disposition, 'preserve');
    assert.equal(SOURCE_DISPOSITIONS.linkoff_player.disposition, 'preserve');
    assert.equal(SOURCE_DISPOSITIONS.spell_review_invite.disposition, 'preserve');
    assert.equal(SOURCE_DISPOSITIONS.weekly_checklist_reset.disposition, 'disabled_by_default');
    assert.equal(SOURCE_DISPOSITIONS.anti_ghost_notice.disposition, 'disabled_by_default');
    assert.equal(SOURCE_DISPOSITIONS.transmit_approved_players.disposition, 'bulk_blocked_by_default');
    assert.equal(resolveSourcePolicy('missing').disposition, 'review_required');
});
