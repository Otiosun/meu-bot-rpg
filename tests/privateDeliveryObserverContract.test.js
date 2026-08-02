'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    classifyObservedJob,
    maskTarget,
    observeDeliveryJobs,
} = require('../helpers/clover/privateDeliveryObserver');

const NOW = new Date('2026-08-02T03:00:00Z');

function job(overrides = {}) {
    return {
        id: 1,
        kind: 'private_text',
        target_jid: '5511999999999@s.whatsapp.net',
        payload_json: JSON.stringify({ text: 'segredo', source: 'post_ficha' }),
        status: 'pending',
        priority: 10,
        attempts: 0,
        max_attempts: 3,
        run_after: '2026-08-02 02:00:00',
        locked_at: null,
        created_by: 'system',
        created_at: '2026-08-02 01:00:00',
        category: 'critical',
        dedupe_key: 'post_ficha|player|1',
        ...overrides,
    };
}

test('transação válida aparece como elegível sem expor conteúdo', () => {
    const observed = classifyObservedJob(job(), { now: NOW, env: {} });
    assert.equal(observed.decision, 'eligible');
    assert.equal(observed.source, 'post_ficha');
    assert.equal(observed.dedupePresent, true);
    assert.equal(observed.target, '***9999@s.whatsapp.net');
    assert.equal(JSON.stringify(observed).includes('segredo'), false);
    assert.equal(JSON.stringify(observed).includes('5511999999999'), false);
});

test('proativo antigo aparece bloqueado pela política', () => {
    const observed = classifyObservedJob(job({
        payload_json: JSON.stringify({ text: 'volte', source: 'return_bonus' }),
        category: 'ghost',
        dedupe_key: 'return_bonus|player|day',
    }), { now: NOW, env: {} });
    assert.equal(observed.decision, 'policy_blocked');
});

test('job vencido aparece como expirado antes de elegibilidade', () => {
    const observed = classifyObservedJob(job({ created_at: '2026-07-20 00:00:00' }), {
        now: NOW,
        env: { CLOVER_PV_DELIVERY_MAX_AGE_HOURS: '72' },
    });
    assert.equal(observed.decision, 'expired');
});

test('job futuro não é tratado como pronto', () => {
    const observed = classifyObservedJob(job({ run_after: '2026-08-03 00:00:00' }), {
        now: NOW,
        env: {},
    });
    assert.equal(observed.decision, 'scheduled_future');
});

test('processing antigo ou sem lock é marcado como travado', () => {
    const stale = classifyObservedJob(job({
        status: 'processing',
        locked_at: '2026-08-02 01:00:00',
    }), { now: NOW, staleLockMinutes: 30 });
    assert.equal(stale.decision, 'stale_processing');

    const active = classifyObservedJob(job({
        status: 'processing',
        locked_at: '2026-08-02 02:50:00',
    }), { now: NOW, staleLockMinutes: 30 });
    assert.equal(active.decision, 'processing');
});

test('relatório conta duplicidade ativa de dedupe', () => {
    const report = observeDeliveryJobs([
        job({ id: 1 }),
        job({ id: 2 }),
        job({ id: 3, status: 'sent' }),
    ], { now: NOW, env: {} });

    assert.equal(report.readOnly, true);
    assert.equal(report.summary.total, 3);
    assert.equal(report.summary.eligible, 2);
    assert.equal(report.summary.duplicateDedupeKeyCount, 1);
    assert.equal(report.duplicateDedupeKeys[0].count, 2);
});

test('status terminal e tipo não privado não entram como elegíveis', () => {
    assert.equal(
        classifyObservedJob(job({ status: 'failed' }), { now: NOW }).decision,
        'terminal'
    );
    assert.equal(
        classifyObservedJob(job({ kind: 'group_text' }), { now: NOW }).decision,
        'ignored_non_private'
    );
});

test('mascaramento nunca retorna o jid completo', () => {
    assert.equal(maskTarget('551188887777@s.whatsapp.net'), '***7777@s.whatsapp.net');
    assert.equal(maskTarget(null), null);
});
