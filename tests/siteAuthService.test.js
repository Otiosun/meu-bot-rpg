'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSiteAuthSchema } = require('../database');
const {
    LOGIN_ATTEMPT_LIMIT,
    authenticateSiteSession,
    createSiteLoginCode,
    loginWithSiteCode,
    parseDatabaseDate,
    revokeSiteSession,
} = require('../helpers/clover/siteAuthService');

let phoneCounter = 0;

async function createTestDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT
        )
    `);
    await ensureCloverSiteAuthSchema(db);
    return db;
}

function nextPhone() {
    phoneCounter += 1;
    return `55119999${String(phoneCounter).padStart(5, '0')}`;
}

async function addPlayer(db, phone = nextPhone(), domain = 's.whatsapp.net') {
    const id = `${phone}@${domain}`;
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status,
          historia_status, personagem_aparencia_status, jogo_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'Jogador', 'Jogador', 'Asta', 'aprovada', 'aprovada', 'approved', 'liberado']
    );
    return { id, phone };
}

test('login exige o número completo vinculado ao WhatsApp', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);
    const issued = await createSiteLoginCode(db, player.id);

    const partial = await loginWithSiteCode(db, {
        phone: player.phone.slice(-4),
        code: issued.code,
    });

    assert.equal(partial.ok, false);
    assert.equal(partial.reason, 'invalid_credentials');
});

test('código é consumido uma vez e a sessão aponta para o player autenticado', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);
    const issued = await createSiteLoginCode(db, player.id);

    const login = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });
    assert.equal(login.ok, true);
    assert.match(login.token, /^clv_[A-Za-z0-9_-]+$/);

    const auth = await authenticateSiteSession(db, login.token);
    assert.equal(auth.ok, true);
    assert.equal(auth.player.id, player.id);

    const reused = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });
    assert.equal(reused.ok, false);
    assert.equal(reused.reason, 'invalid_credentials');
});

test('novo login revoga a sessão anterior do mesmo player', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);

    const firstCode = await createSiteLoginCode(db, player.id);
    const firstLogin = await loginWithSiteCode(db, { phone: player.phone, code: firstCode.code });
    assert.equal(firstLogin.ok, true);

    const secondCode = await createSiteLoginCode(db, player.id);
    const secondLogin = await loginWithSiteCode(db, { phone: player.phone, code: secondCode.code });
    assert.equal(secondLogin.ok, true);

    const oldAuth = await authenticateSiteSession(db, firstLogin.token);
    const newAuth = await authenticateSiteSession(db, secondLogin.token);
    assert.equal(oldAuth.ok, false);
    assert.equal(oldAuth.reason, 'invalid_token');
    assert.equal(newAuth.ok, true);
    assert.equal(newAuth.player.id, player.id);
});

test('tentativas repetidas para o mesmo número são limitadas', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);
    const issued = await createSiteLoginCode(db, player.id);

    for (let index = 0; index < LOGIN_ATTEMPT_LIMIT; index += 1) {
        const result = await loginWithSiteCode(db, {
            phone: player.phone,
            code: issued.code === '000000' ? '111111' : '000000',
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'invalid_credentials');
    }

    const blocked = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'rate_limited');
    assert.ok(blocked.retryAfterMs > 0);
});

test('não gera código quando o cadastro não pode ser ligado a um telefone', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db, '777777777', 'lid');

    const result = await createSiteLoginCode(db, player.id);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_phone');
});

test('validade personalizada positiva é respeitada e valor inválido usa fallback', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);

    const start = Date.now();
    const custom = await createSiteLoginCode(db, player.id, { ttlMs: 60_000 });
    const customDelta = Date.parse(custom.expiresAt) - start;
    assert.ok(customDelta >= 55_000 && customDelta <= 65_000);

    const fallback = await createSiteLoginCode(db, player.id, { ttlMs: -1 });
    assert.ok(Date.parse(fallback.expiresAt) - Date.now() > 10 * 60 * 1000);
});

test('last_seen_at só é regravado quando a atividade está antiga', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);
    const issued = await createSiteLoginCode(db, player.id);
    const login = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });
    assert.equal(login.ok, true);

    const before = await db.get(
        `SELECT last_seen_at FROM clover_site_sessions WHERE player_id = ? AND revoked_at IS NULL`,
        [player.id]
    );
    await authenticateSiteSession(db, login.token);
    const immediate = await db.get(
        `SELECT last_seen_at FROM clover_site_sessions WHERE player_id = ? AND revoked_at IS NULL`,
        [player.id]
    );
    assert.equal(immediate.last_seen_at, before.last_seen_at);

    await db.run(
        `UPDATE clover_site_sessions SET last_seen_at = datetime('now', '-10 minutes') WHERE player_id = ?`,
        [player.id]
    );
    const old = await db.get(
        `SELECT last_seen_at FROM clover_site_sessions WHERE player_id = ? AND revoked_at IS NULL`,
        [player.id]
    );
    await authenticateSiteSession(db, login.token);
    const refreshed = await db.get(
        `SELECT last_seen_at FROM clover_site_sessions WHERE player_id = ? AND revoked_at IS NULL`,
        [player.id]
    );
    assert.ok(parseDatabaseDate(refreshed.last_seen_at) > parseDatabaseDate(old.last_seen_at));
});

test('logout revoga a sessão e token vazio é idempotente', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);
    const issued = await createSiteLoginCode(db, player.id);
    const login = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });

    assert.deepEqual(await revokeSiteSession(db, ''), { ok: true });
    assert.deepEqual(await revokeSiteSession(db, login.token), { ok: true });
    const auth = await authenticateSiteSession(db, login.token);
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'invalid_token');
});
