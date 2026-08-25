'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { reconcileReturnPointConversions } = require('../helpers/clover/returnPointConversionService');
const {
    createPreResetSiteApiEvidenceFixture: fixture,
    createTestOnlyPreResetPolicy: policy,
    futureCharacterDraft: draft,
    requestPreResetApi: request,
} = require('../helpers/clover/preResetSiteApiEvidenceFixture');

test('pre-reset HTTP usa sessao canonica, policy fail-closed e preserva ativo', async (t) => {
    const f = await fixture(t);
    const activeBefore = await f.db.get('SELECT raca, dinheiro FROM jogadores WHERE id = ?', [f.players.alpha]);
    assert.equal((await request(f.port, 'GET', '/pre-reset/status')).status, 401);

    const statusOff = await request(f.port, 'GET', '/pre-reset/status', f.sessions.alpha);
    assert.equal(statusOff.status, 200);
    assert.equal(Object.values(statusOff.body.policy).every((entry) => entry.enabled === false && entry.status === 'NOT_CONFIGURED'), true);
    const publicStatus = JSON.stringify(statusOff.body);
    assert.equal(/"rate"|"products"|"reason"|"cutoff"|"phConsumption"/.test(publicStatus), false);

    for (const pathname of [
        '/pre-reset/future-character',
        '/pre-reset/return-points/balance',
        '/pre-reset/conversion',
        '/pre-reset/shop/catalog',
        '/pre-reset/entitlements',
    ]) {
        const locked = await request(f.port, 'GET', pathname, f.sessions.alpha);
        assert.equal(locked.status, 403, pathname);
        assert.equal(locked.body.error, 'prereset_mode_disabled', pathname);
    }
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'mode-off-0001' })).body.error, 'prereset_mode_disabled');

    f.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true' };
    const created = await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'future-create-0001' });
    assert.equal(created.status, 403);
    assert.equal(created.body.error, 'policy_not_configured');

    f.options.preResetPolicyRegistry = policy();
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { playerId: f.players.beta, expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'idor-body-0001' })).body.error, 'client_authority_forbidden');
    const opened = await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'future-create-0001' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.character.playerId, undefined);
    assert.equal(opened.body.character.draftHash, undefined);
    assert.equal((await request(f.port, 'GET', '/pre-reset/future-character', f.sessions.beta)).body.character, null);
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 1, draft: draft('Atualizado') }, { 'Idempotency-Key': 'future-update-0001' })).status, 200);
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 1, draft: draft('Conflito') }, { 'Idempotency-Key': 'future-stale-0001' })).body.error, 'revision_conflict');
    const submitted = await request(f.port, 'POST', '/pre-reset/future-character/submit', f.sessions.alpha, { expectedRevision: 2, draft: draft('Atualizado') }, { 'Idempotency-Key': 'future-submit-0001' });
    assert.equal(submitted.body.character.status, 'submitted');
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character/submit', f.sessions.alpha, { expectedRevision: 2, draft: draft('Atualizado') }, { 'Idempotency-Key': 'future-submit-0001' })).body.duplicate, true);
    assert.equal((await request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.beta, { action: 'approve', reason: 'fake role', expectedRevision: 3, role: 'admin' }, { 'Idempotency-Key': 'review-denied-0001' })).body.error, 'capability_denied');
    assert.equal((await request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.beta, { action: 'approve', reason: 'insufficient capability', expectedRevision: 3 }, { 'Idempotency-Key': 'review-capability-0001' })).body.error, 'capability_denied');
    const approval = await request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.admin, { action: 'approve', reason: 'fixture review', expectedRevision: 3 }, { 'Idempotency-Key': 'review-approve-0001' });
    assert.equal(approval.status, 200);
    assert.equal(approval.body.character.status, 'approved');
    assert.deepEqual(await f.db.get('SELECT raca, dinheiro FROM jogadores WHERE id = ?', [f.players.alpha]), activeBefore);
    assert.equal((await f.db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id = ?', [f.players.alpha])).total, 0);
});

test('conversao e shop HTTP so aceitam policy TEST-ONLY e mantem atomicidade', async (t) => {
    const f = await fixture(t);
    f.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true' };
    assert.equal((await request(f.port, 'POST', '/pre-reset/conversion/claim', f.sessions.alpha, {}, { 'Idempotency-Key': 'conversion-off-0001' })).body.error, 'policy_not_configured');
    assert.equal((await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': 'shop-off-0001' })).body.error, 'policy_not_configured');
    f.options.preResetPolicyRegistry = policy({ conversion: true, shop: true });
    const preview = await request(f.port, 'GET', '/pre-reset/conversion', f.sessions.alpha);
    assert.equal(preview.body.conversion.calculatedReturnPoints > 9, true);
    assert.deepEqual((await request(f.port, 'GET', '/pre-reset/conversion', f.sessions.alpha)).body.conversion, preview.body.conversion);
    const claim = await request(f.port, 'POST', '/pre-reset/conversion/claim', f.sessions.alpha, {}, { 'Idempotency-Key': 'conversion-claim-0001' });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.conversion.claimed, true);
    assert.equal((await request(f.port, 'POST', '/pre-reset/conversion/claim', f.sessions.alpha, {}, { 'Idempotency-Key': 'conversion-claim-0002' })).body.conversion.duplicate, true);
    assert.equal((await reconcileReturnPointConversions(f.db, f.players.alpha)).ok, true);
    assert.equal((await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race', price: 1 }, { 'Idempotency-Key': 'shop-price-0001' })).body.error, 'client_authority_forbidden');
    const [left, right] = await Promise.all([
        request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': 'shop-concurrent-0001' }),
        request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': 'shop-concurrent-0002' }),
    ]);
    assert.equal([left.status, right.status].filter((status) => status === 200).length, 1);
    assert.equal([left.body.error, right.body.error].includes('entitlement_already_owned'), true, JSON.stringify({ left, right }));
    const succeededKey = left.status === 200 ? 'shop-concurrent-0001' : 'shop-concurrent-0002';
    assert.equal((await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': succeededKey })).body.duplicate, true);
    const balanceBeforeRollback = (await request(f.port, 'GET', '/pre-reset/return-points/balance', f.sessions.alpha)).body.balance;
    await f.db.exec(`CREATE TRIGGER fixture_prereset_rollback BEFORE INSERT ON clover_prereset_entitlements
        WHEN NEW.entitlement_key = 'future_rollback:test' BEGIN SELECT RAISE(ABORT, 'INTERNAL_SQL_SENTINEL_DO_NOT_LEAK'); END`);
    const rollback = await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-rollback' }, { 'Idempotency-Key': 'shop-rollback-0001' });
    assert.equal(rollback.status, 500);
    assert.equal(rollback.body.error, 'internal_error');
    assert.equal(rollback.body.message, 'Nao foi possivel concluir a operacao. Tente novamente mais tarde.');
    assert.equal(JSON.stringify(rollback.body).includes('INTERNAL_SQL_SENTINEL_DO_NOT_LEAK'), false);
    assert.equal(/sqlite|select |insert |stack|error:|[a-z]:\\/i.test(JSON.stringify(rollback.body)), false);
    assert.equal((await request(f.port, 'GET', '/pre-reset/return-points/balance', f.sessions.alpha)).body.balance, balanceBeforeRollback);
    const insufficient = await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-grimoire' }, { 'Idempotency-Key': 'shop-insufficient-0001' });
    assert.equal(insufficient.body.error, 'insufficient_return_points');
    f.options.env = {};
    assert.equal((await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-grimoire' }, { 'Idempotency-Key': 'shop-kill-0001' })).body.error, 'prereset_mode_disabled');
    assert.equal((await request(f.port, 'GET', '/pre-reset/return-points/balance', f.sessions.alpha)).body.error, 'prereset_mode_disabled');
    assert.equal((await f.db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id = ?', [f.players.alpha])).total, 0);
});