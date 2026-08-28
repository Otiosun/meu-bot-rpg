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

async function currentCharacterSnapshot(db, playerId) {
    return {
        player: await db.get('SELECT raca, dinheiro, ficha_status, jogo_status FROM jogadores WHERE id = ?', [playerId]),
        stats: await db.get('SELECT ph_accumulated, ph_available, stage_key, pb_total, pb_spent FROM clover_character_stats WHERE player_id = ?', [playerId]),
        phLedger: await db.all(`SELECT id, amount, kind, source, reason, related_id, created_by, created_at, metadata_json
            FROM clover_ph_ledger WHERE player_id = ? ORDER BY id ASC`, [playerId]),
        recruitmentPrCount: Number((await db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id = ?', [playerId]))?.total || 0),
        inventoryCount: Number((await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ?', [playerId]))?.total || 0),
    };
}

test('pre-reset HTTP usa sessao canonica, policy fail-closed e preserva ativo', async (t) => {
    const f = await fixture(t);
    const activeBefore = await currentCharacterSnapshot(f.db, f.players.alpha);
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

    const offMutations = [
        request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'mode-off-post-0001' }),
        request(f.port, 'PUT', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'mode-off-put-0001' }),
        request(f.port, 'POST', '/pre-reset/future-character/submit', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'mode-off-submit-0001' }),
        request(f.port, 'POST', '/pre-reset/conversion/claim', f.sessions.alpha, {}, { 'Idempotency-Key': 'mode-off-conversion-0001' }),
        request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race' }, { 'Idempotency-Key': 'mode-off-shop-0001' }),
        request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.admin, { action: 'approve', reason: 'must stay off', expectedRevision: 1 }, { 'Idempotency-Key': 'mode-off-review-0001' }),
    ];
    for (const locked of await Promise.all(offMutations)) {
        assert.equal(locked.status, 403);
        assert.equal(locked.body.error, 'prereset_mode_disabled');
    }
    assert.deepEqual(await currentCharacterSnapshot(f.db, f.players.alpha), activeBefore);

    f.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true', PRE_RESET_RETURN_ENABLED: 'true' };
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
    assert.equal((await request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.admin, { action: 'approve', reason: 'client role forbidden', expectedRevision: 3, role: 'owner' }, { 'Idempotency-Key': 'review-client-role-0001' })).body.error, 'client_authority_forbidden');
    const approval = await request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.admin, { action: 'approve', reason: 'fixture review', expectedRevision: 3 }, { 'Idempotency-Key': 'review-approve-0001' });
    assert.equal(approval.status, 200);
    assert.equal(approval.body.character.status, 'approved');
    assert.deepEqual(await currentCharacterSnapshot(f.db, f.players.alpha), activeBefore);
});

test('conversao e shop HTTP so aceitam policy TEST-ONLY e mantem atomicidade', async (t) => {
    const f = await fixture(t);
    const activeBefore = await currentCharacterSnapshot(f.db, f.players.alpha);
    f.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true', PRE_RESET_RETURN_ENABLED: 'true' };
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
    assert.equal((await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-race', balance: 999999 }, { 'Idempotency-Key': 'shop-balance-0001' })).body.error, 'client_authority_forbidden');
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
    assert.deepEqual(await currentCharacterSnapshot(f.db, f.players.alpha), activeBefore);
    f.options.env = {};
    assert.equal((await request(f.port, 'POST', '/pre-reset/shop/purchase', f.sessions.alpha, { itemKey: 'test-grimoire' }, { 'Idempotency-Key': 'shop-kill-0001' })).body.error, 'prereset_mode_disabled');
    assert.equal((await request(f.port, 'GET', '/pre-reset/return-points/balance', f.sessions.alpha)).body.error, 'prereset_mode_disabled');
    assert.deepEqual(await currentCharacterSnapshot(f.db, f.players.alpha), activeBefore);
});

test('status PRE_RESET publica contrato de raridade mitica somente apos o gate compartilhado', async (t) => {
    const f = await fixture(t);
    const off = await request(f.port, 'GET', '/pre-reset/status', f.sessions.alpha);
    assert.equal(Object.hasOwn(off.body, 'transition'), false);
    assert.equal(Object.hasOwn(off.body, 'futureRolls'), false);

    f.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true', PRE_RESET_RETURN_ENABLED: 'true' };
    f.options.preResetPolicyRegistry = policy();
    await f.db.run(
        `INSERT INTO clover_prereset_launch_rosters
         (campaign_key,authority_mode,revision,status,roster_hash,finalized_by,finalized_at)
         VALUES ('mythic_launch_v1','admin_roster',7,'finalized','fixture-status','admin',CURRENT_TIMESTAMP)`
    );
    await f.db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status)
         VALUES ('mythic_launch_v1',?,7,'reset','pending')`,
        [f.players.alpha]
    );
    await f.db.run(
        `INSERT INTO clover_prereset_future_rolls
         (campaign_key,player_id,roll_number,kingdom,social_class,family,race,grimoire,
          magic_rarity,magic_scope,summary,roll_version,kingdom_key,social_class_key,race_key,
          grimoire_key,magic_rarity_key,roll_payload)
         VALUES ('mythic_launch_v1',?,1,'Heart','Nobre',NULL,'Elfo','Grimorio de Trevo de Quatro Folhas',
                 'Mitica','unica','roll mitico','clover_base_v2','heart','nobre','elfo','quatro_folhas','mitica','{}')`,
        [f.players.alpha]
    );

    const status = await request(f.port, 'GET', '/pre-reset/status', f.sessions.alpha);
    assert.equal(status.status, 200);
    assert.equal(status.body.transition.phase, 'pre_reset_build');
    assert.equal(status.body.transition.outcome, 'reset');
    assert.deepEqual(status.body.futureRolls, [{
        rollNumber: 1,
        kingdom: 'Heart', kingdomKey: 'heart',
        socialClass: 'Nobre', socialClassKey: 'nobre', family: null,
        race: 'Elfo', raceKey: 'elfo',
        grimoire: 'Grimorio de Trevo de Quatro Folhas', grimoireKey: 'quatro_folhas',
        grimoireRank: null, grimoireSymbol: null,
        magic_rarity: 'Mitica', magic_rarity_key: 'mitica',
        magicScope: 'unica', summary: 'roll mitico', rollVersion: 'clover_base_v2',
    }]);
    assert.equal(Object.hasOwn(status.body.futureRolls[0], 'magicRarity'), false);
});
