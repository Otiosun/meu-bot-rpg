'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { createSession } = require('../helpers/clover/siteAuthService');
const { ensureCanonicalRoleGrantSchema } = require('../helpers/clover/canonicalRoleGrantSchema');
const { addPh } = require('../helpers/clover/phService');
const { reconcileReturnPointConversions } = require('../helpers/clover/returnPointConversionService');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const { handlePreResetSiteApi } = require('../helpers/clover/preResetSiteApiService');

function filename() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-api-'));
    return path.join(dir, 'fixture.sqlite');
}

function policy({ conversion = false, shop = false } = {}) {
    return createPreResetPolicyRegistry({ testOnly: true, policies: {
        PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'test-mode-v1' },
        SESSION_ELIGIBILITY: { status: 'ENABLED', policyVersion: 'test-eligibility-v1', eligibleReleasedSessions: true },
        ...(conversion ? { PH_RETURN_CONVERSION: {
            status: 'ENABLED', policyVersion: 'test-conversion-v1', resetCycleKey: 'test-cycle-v1', cutoff: 'test-cutoff',
            rate: { numerator: 1, denominator: 1 }, rounding: 'floor', phConsumption: 'none',
        } } : {}),
        ...(shop ? { RESET_SHOP: {
            status: 'ENABLED', policyVersion: 'test-shop-v1', catalogVersion: 'test-catalog-v1', products: [
                { itemKey: 'test-race', entitlementKey: 'future_race:test', priceReturnPoints: 5 },
                { itemKey: 'test-grimoire', entitlementKey: 'future_grimoire:test', priceReturnPoints: 100 },
                { itemKey: 'test-rollback', entitlementKey: 'future_rollback:test', priceReturnPoints: 1 },
            ],
        } } : {}),
    } });
}

function draft(name = 'Futuro') {
    return { name, age: 18, gender: 'Feminino', appearance: 'Cabelo escuro e olhos verdes.', rollNumber: 1, entitlementKeys: [] };
}

function request(port, method, pathname, token, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            ...headers,
        } }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function fixture(t) {
    const dbFile = filename();
    const db = await database.criarBanco({ filename: dbFile });
    const players = {
        alpha: 'fixture-alpha@lid', beta: 'fixture-beta@lid', admin: 'fixture-admin@lid',
    };
    for (const [name, id] of Object.entries(players)) {
        await db.run(`INSERT INTO jogadores (id, nome, raca, dinheiro, ficha_status, jogo_status)
            VALUES (?, ?, 'Humano ativo', 77, 'aprovada', 'liberado')`, [id, name]);
    }
    await ensureCanonicalRoleGrantSchema(db);
    await db.run(`INSERT INTO clover_role_grants
        (subject_id, role_key, scope_type, scope_key, status, valid_from, granted_by, origin_type, origin_ref)
        VALUES (?, 'admin', 'global', '*', 'active', '2000-01-01 00:00:00', 'fixture', 'fixture', 'prereset-api-admin')`, [players.admin]);
    await addPh(db, players.alpha, 9, 'fixture', 'PH fixture', 'fixture');
    const sessions = {};
    for (const [name, id] of Object.entries(players)) sessions[name] = (await createSession(db, id, `fixture-${name}`)).token;
    const options = { getDb: () => db, env: {}, preResetPolicyRegistry: createPreResetPolicyRegistry() };
    const server = http.createServer((req, res) => handlePreResetSiteApi(req, res, options));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await db.close();
        fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
    });
    return { db, players, sessions, options, port: server.address().port };
}

test('pre-reset HTTP usa sessao canonica, policy fail-closed e preserva ativo', async (t) => {
    const f = await fixture(t);
    const activeBefore = await f.db.get('SELECT raca, dinheiro FROM jogadores WHERE id = ?', [f.players.alpha]);
    assert.equal((await request(f.port, 'GET', '/pre-reset/status')).status, 401);
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'mode-off-0001' })).body.error, 'prereset_mode_disabled');

    f.options.env = { PRE_RESET_LAUNCH_ENABLED: 'true' };
    assert.equal((await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { playerId: f.players.beta, expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'idor-body-0001' })).body.error, 'client_authority_forbidden');
    const created = await request(f.port, 'POST', '/pre-reset/future-character', f.sessions.alpha, { expectedRevision: 0, draft: draft() }, { 'Idempotency-Key': 'future-create-0001' });
    assert.equal(created.status, 403); // mode policy is deliberately still NOT_CONFIGURED in this fixture

    f.options.preResetPolicyRegistry = policy();
    // Test-only mode + eligibility are configured by policy(); the draft path now opens.
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
    assert.equal((await request(f.port, 'POST', `/pre-reset/admin/future-characters/${encodeURIComponent(f.players.alpha)}/review`, f.sessions.beta, { action: 'approve', reason: 'fake role', expectedRevision: 3, role: 'admin' }, { 'Idempotency-Key': 'review-denied-0001' })).body.error, 'client_authority_forbidden');
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
    assert.equal((await f.db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id = ?', [f.players.alpha])).total, 0);
});
