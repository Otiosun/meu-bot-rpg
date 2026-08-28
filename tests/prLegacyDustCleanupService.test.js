'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const {
    cleanupLegacyPrDust,
    rawPrBalance,
} = require('../helpers/clover/prLegacyDustCleanupService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clover-pr-dust-'));
    const db = await database.criarBanco({ filename:path.join(dir,'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
    await db.run(
        `INSERT INTO jogadores
         (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
         VALUES ('dust-player','Dust Player','aprovada','liberado','Dust','Aparencia Dust','approved')`
    );
    return db;
}

async function insertLegacy(db, amount, key) {
    const event = await db.get("SELECT id FROM clover_recruitment_events WHERE event_key='divulgacao_v1'");
    await db.run(
        `INSERT INTO clover_pr_ledger
         (player_id,event_id,amount,kind,source,reason,idempotency_key,created_by)
         VALUES ('dust-player', ?, ?, 'ajuste_admin', 'ajuste_admin', 'fixture legado fracionario', ?, 'test')`,
        [event.id, amount, key]
    );
}

test('limpa residuo IEEE-754 subnanometrico para zero exato e e idempotente', async (t) => {
    const db = await fixture(t);
    await insertLegacy(db, 0.1, 'fixture:dust:1');
    await insertLegacy(db, 0.2, 'fixture:dust:2');
    await insertLegacy(db, -0.3, 'fixture:dust:3');

    const before = await rawPrBalance(db,'dust-player');
    assert.notEqual(before, 0);
    assert.ok(Math.abs(before) < 1e-9);

    const first = await cleanupLegacyPrDust(db,'dust-player',{
        idempotencyKey:'cleanup:dust-player:v1',
        createdBy:'test',
    });
    assert.equal(first.cleaned,true);
    assert.equal(first.duplicate,false);
    assert.equal(await rawPrBalance(db,'dust-player'),0);

    const countBefore = await db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id=?',['dust-player']);
    const second = await cleanupLegacyPrDust(db,'dust-player',{
        idempotencyKey:'cleanup:dust-player:v1',
        createdBy:'test',
    });
    const countAfter = await db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id=?',['dust-player']);
    assert.equal(second.duplicate,true);
    assert.equal(await rawPrBalance(db,'dust-player'),0);
    assert.equal(Number(countAfter.total),Number(countBefore.total));
});

test('recusa apagar saldo PR material', async (t) => {
    const db = await fixture(t);
    await insertLegacy(db, 0.2, 'fixture:material:1');
    await assert.rejects(
        cleanupLegacyPrDust(db,'dust-player',{
            idempotencyKey:'cleanup:material:v1',
            createdBy:'test',
        }),
        (error)=>error?.code === 'material_pr_balance_not_dust'
    );
    assert.equal(await rawPrBalance(db,'dust-player'),0.2);
});
