'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    resetPreResetBlockNoticeGuardForTests,
    shouldSendPreResetBlockNotice,
} = require('../helpers/clover/preResetBlockNoticeGuard');

test.beforeEach(() => resetPreResetBlockNoticeGuardForTests());

test('aviso PRE_RESET é independente por jogador', () => {
    assert.equal(shouldSendPreResetBlockNotice('player-a', { now: 1000, cooldownMs: 15000 }).ok, true);
    assert.equal(shouldSendPreResetBlockNotice('player-b', { now: 1001, cooldownMs: 15000 }).ok, true);
    assert.equal(shouldSendPreResetBlockNotice('player-a', { now: 1002, cooldownMs: 15000 }).ok, false);
});

test('aviso PRE_RESET volta após a janela sem bloquear a decisão', () => {
    const first = shouldSendPreResetBlockNotice('player-a', { now: 1000, cooldownMs: 15000 });
    const repeated = shouldSendPreResetBlockNotice('player-a', { now: 2000, cooldownMs: 15000 });
    const afterWindow = shouldSendPreResetBlockNotice('player-a', { now: 16000, cooldownMs: 15000 });

    assert.deepEqual(first, { ok: true, retryMs: 0 });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.retryMs, 14000);
    assert.deepEqual(afterWindow, { ok: true, retryMs: 0 });
});
