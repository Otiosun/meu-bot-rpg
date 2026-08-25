'use strict';

// Disposable-only foundation shared by the pre-reset E2E suite and the F7
// contract-evidence probes. It starts the real HTTP boundary over a fresh
// SQLite database; it never discovers or opens a configured runtime database.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const database = require('../../database');
const { createSession } = require('./siteAuthService');
const { ensureCanonicalRoleGrantSchema } = require('./canonicalRoleGrantSchema');
const { addPh } = require('./phService');
const { createPreResetPolicyRegistry } = require('./preResetPolicyRegistryService');
const { compileTestOnlyPreResetPolicyRegistry, loadPreResetProductDecisionManifest } = require('./preResetProductDecisionService');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');

const SYNTHETIC_DECISIONS = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'preResetProductDecisions.synthetic.json');

function evidenceFilename() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-api-'));
    return path.join(directory, 'fixture.sqlite');
}

function createTestOnlyPreResetPolicy({ conversion = false, shop = false } = {}) {
    if (conversion && shop) {
        return compileTestOnlyPreResetPolicyRegistry(
            loadPreResetProductDecisionManifest(SYNTHETIC_DECISIONS, { requireAllApproved: true })
        ).registry;
    }
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

function futureCharacterDraft(name = 'Futuro') {
    return { name, age: 18, gender: 'Feminino', appearance: 'Cabelo escuro e olhos verdes.', rollNumber: 1, entitlementKeys: [] };
}

function requestPreResetApi(port, method, pathname, token, body, headers = {}) {
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

async function createPreResetSiteApiEvidenceFixture(t) {
    const dbFile = evidenceFilename();
    const db = await database.criarBanco({ filename: dbFile });
    const players = { alpha: 'fixture-alpha@lid', beta: 'fixture-beta@lid', admin: 'fixture-admin@lid' };
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
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await new Promise((resolve) => server.close(resolve));
        await db.close();
        fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
    };
    if (t?.after) t.after(close);
    return Object.freeze({ db, players, sessions, options, port: server.address().port, close });
}

module.exports = { createPreResetSiteApiEvidenceFixture, createTestOnlyPreResetPolicy, futureCharacterDraft, requestPreResetApi };
