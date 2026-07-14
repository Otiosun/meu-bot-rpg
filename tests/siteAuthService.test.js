const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSiteAuthSchema } = require('../database');
const {
    authenticateSiteSession,
    createSiteLoginCode,
    loginWithSiteCode,
} = require('../helpers/clover/siteAuthService');

async function createTestDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
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

async function addPlayer(db, phone = '5511999999999') {
    const id = `${phone}@s.whatsapp.net`;
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, historia_status, personagem_aparencia_status, jogo_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, 'Jogador', 'Asta', 'aprovada', 'aprovada', 'approved', 'liberado']
    );
    return { id, phone };
}

test('login exige o numero completo vinculado ao WhatsApp', async (t) => {
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

test('codigo e consumido uma vez e a sessao aponta para o player autenticado', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const player = await addPlayer(db);
    const issued = await createSiteLoginCode(db, player.id);

    const login = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });
    assert.equal(login.ok, true);
    assert.ok(login.token.startsWith('clv_'));

    const auth = await authenticateSiteSession(db, login.token);
    assert.equal(auth.ok, true);
    assert.equal(auth.player.id, player.id);

    const reused = await loginWithSiteCode(db, { phone: player.phone, code: issued.code });
    assert.equal(reused.ok, false);
    assert.equal(reused.reason, 'invalid_credentials');
});

test('novo login revoga a sessao anterior do mesmo player', async (t) => {
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
    assert.equal(newAuth.ok, true);
    assert.equal(newAuth.player.id, player.id);
});
