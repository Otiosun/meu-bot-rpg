'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    POLICY_MODES,
    buildPolicySkipResult,
    evaluateRuntimePrivateMessage,
    isPrivateTarget,
    normalizePolicyMode,
    resolvePolicyMode,
} = require('../helpers/clover/privateMessagePolicyRuntime');

test('modo inválido ou ausente permanece off', () => {
    assert.equal(normalizePolicyMode(), POLICY_MODES.OFF);
    assert.equal(normalizePolicyMode('qualquer'), POLICY_MODES.OFF);
    assert.equal(resolvePolicyMode({}), POLICY_MODES.OFF);
});

test('modo off preserva comportamento legado sem esconder decisão teórica', () => {
    const result = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'weekly_checklist_reset',
        dedupeKey: 'weekly:1',
    }, {});

    assert.equal(result.mode, POLICY_MODES.OFF);
    assert.equal(result.allowed, true);
    assert.equal(result.wouldAllow, false);
    assert.equal(result.enforced, false);
    assert.equal(result.observed, false);
    assert.equal(result.reason, 'policy_off');
});

test('modo observe registra bloqueio sem impedir envio', () => {
    const result = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'anti_ghost_notice',
        dedupeKey: 'anti:notice:1',
    }, {
        CLOVER_PV_POLICY_MODE: 'observe',
    });

    assert.equal(result.allowed, true);
    assert.equal(result.wouldAllow, false);
    assert.equal(result.enforced, false);
    assert.equal(result.observed, true);
    assert.equal(result.reason, 'observed_blocked');
});

test('modo enforce bloqueia desconhecido e proativo desligado', () => {
    const unknown = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'nao_classificado',
    }, {
        CLOVER_PV_POLICY_MODE: 'enforce',
    });

    const proactive = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'weekly_checklist_reset',
        dedupeKey: 'weekly:1',
    }, {
        CLOVER_PV_POLICY_MODE: 'enforce',
        CLOVER_PV_PROACTIVE_ENABLED: '1',
    });

    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, 'classification_required');
    assert.equal(proactive.allowed, false);
    assert.equal(proactive.reason, 'source_disabled_by_default');
});

test('modo enforce preserva resposta e transação corretamente identificadas', () => {
    const reactive = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'command_reply',
    }, {
        CLOVER_PV_POLICY_MODE: 'enforce',
    });

    const transactional = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'appearance_result',
        dedupeKey: 'appearance:player:approved:v1',
    }, {
        CLOVER_PV_POLICY_MODE: 'enforce',
    });

    assert.equal(reactive.allowed, true);
    assert.equal(reactive.enforced, true);
    assert.equal(transactional.allowed, true);
    assert.equal(transactional.enforced, true);
});

test('alvo de grupo ignora política privada em qualquer modo', () => {
    const result = evaluateRuntimePrivateMessage({
        targetJid: '120363000000000000@g.us',
        source: 'nao_classificado',
    }, {
        CLOVER_PV_POLICY_MODE: 'enforce',
    });

    assert.equal(isPrivateTarget('120363000000000000@g.us'), false);
    assert.equal(result.allowed, true);
    assert.equal(result.privateTarget, false);
    assert.equal(result.reason, 'non_private_target');
});

test('resultado bloqueado vira skip explícito e auditável', () => {
    const decision = evaluateRuntimePrivateMessage({
        targetJid: '5511999999999@s.whatsapp.net',
        source: 'nao_classificado',
    }, {
        CLOVER_PV_POLICY_MODE: 'enforce',
    });

    const skipped = buildPolicySkipResult(decision);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, 'pv_policy_blocked');
    assert.equal(skipped.policy.mode, 'enforce');
    assert.equal(skipped.policy.decisionReason, 'classification_required');
    assert.equal(buildPolicySkipResult({ allowed: true }), null);
});