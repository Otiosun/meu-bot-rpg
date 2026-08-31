'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const {
    authenticateReturnShopSession,
    createReturnShopLoginCode,
    loginWithReturnShopCode,
} = require('../helpers/clover/returnPointShopAuthService');
const { authenticateSiteSession } = require('../helpers/clover/siteAuthService');
const {
    inspectReturnPointShopAuthSchemaState,
} = require('../helpers/clover/returnPointShopAuthMigration');

const CAMPAIGN = 'mythic_launch_v1';
const PLAYER_ID = '5511999990001@s.whatsapp.net';
const PHONE = '5511999990001';

function temporaryFilename() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-return-shop-auth-'));
    return path.join(dir, 'database.sqlite');
}

async function openFixture(t) {
    const filename = temporaryFilename();
    const db = await database.criarBanco({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive:true, force:true });
    });
    return db;
}

async function seedEligiblePlayer(db) {
    await db.run(
        `INSERT INTO jogadores (
            id,nome,ficha_status,jogo_status,personagem_nome,personagem_idade,personagem_genero,
            personagem_aparencia,personagem_aparencia_status,reino,classe,raca,grimorio,familia,familia_key,
            magia,magia_key,numero_roll_escolhido
        ) VALUES (?,?,'aprovada','liberado','Auth Fixture',20,'Masculino','Fixture','approved',
                  'Clover','Nobre','Humano','Tres Folhas','Silva','silva','Vento','vento',1)`,
        [PLAYER_ID, 'Auth Fixture']
    );
    await db.run(
        `INSERT INTO clover_return_point_shop_gate
         (campaign_key,status,required_keep_count,roster_revision,roster_hash,keep_count_at_open,opened_by,opened_at)
         VALUES (?,'open',14,1,'auth-fixture-hash',14,'fixture',CURRENT_TIMESTAMP)`,
        [CAMPAIGN]
    );
    await db.run(
        `INSERT INTO clover_return_point_shop_eligible
         (campaign_key,player_id,roster_revision,roster_hash,outcome,captured_by)
         VALUES (?,?,1,'auth-fixture-hash','reset','fixture')`,
        [CAMPAIGN, PLAYER_ID]
    );
}

test('0043 cria schema exato de auth scoped da Loja de Retorno', async (t) => {
    const db = await openFixture(t);
    const state = await inspectReturnPointShopAuthSchemaState(db);
    assert.equal(state.kind, 'exact');
});

test('codigo da Loja gera apenas sessao return_shop e e one-time', async (t) => {
    const db = await openFixture(t);
    await seedEligiblePlayer(db);

    const issued = await createReturnShopLoginCode(db, PLAYER_ID, { ttlMs:60_000 });
    assert.equal(issued.ok, true);
    assert.equal(issued.scope, 'return_shop');
    assert.match(issued.code, /^\d{6}$/);
    assert.equal(issued.phoneDigits, PHONE);

    const wrong = await loginWithReturnShopCode(db, { phone:PHONE, code:'000000' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'invalid_credentials');

    const login = await loginWithReturnShopCode(db, { phone:PHONE, code:issued.code });
    assert.equal(login.ok, true);
    assert.equal(login.scope, 'return_shop');
    assert.match(login.token, /^clv_rs_/);
    assert.equal(login.player.id, PLAYER_ID);

    const scoped = await authenticateReturnShopSession(db, login.token);
    assert.equal(scoped.ok, true);
    assert.equal(scoped.scope, 'return_shop');
    assert.equal(scoped.player.id, PLAYER_ID);

    const generalSite = await authenticateSiteSession(db, login.token);
    assert.equal(generalSite.ok, false);

    const replay = await loginWithReturnShopCode(db, { phone:PHONE, code:issued.code });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'invalid_credentials');
});

test('fechar a loja invalida a sessao scoped imediatamente', async (t) => {
    const db = await openFixture(t);
    await seedEligiblePlayer(db);
    const issued = await createReturnShopLoginCode(db, PLAYER_ID);
    const login = await loginWithReturnShopCode(db, { phone:PHONE, code:issued.code });
    assert.equal(login.ok, true);

    await db.run(
        `UPDATE clover_return_point_shop_gate
         SET status='closed',closed_by='fixture',closed_at=CURRENT_TIMESTAMP
         WHERE campaign_key=?`,
        [CAMPAIGN]
    );

    const auth = await authenticateReturnShopSession(db, login.token);
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'return_shop_closed');

    const row = await db.get(
        'SELECT revoked_at FROM clover_return_shop_sessions WHERE player_id=?',
        [PLAYER_ID]
    );
    assert.ok(row.revoked_at);
});
