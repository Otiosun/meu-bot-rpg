'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationPlan');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    applyLaunch,
    configurePrPvPolicy,
    finalizeRoster,
    previewLaunchEconomy,
    previewRoster,
    replaceKeepRoster,
} = require('../helpers/clover/preResetLaunchService');
const { creditPv, getPvBalance } = require('../helpers/clover/pvService');
const { adminAdjustPr, getPrBalance } = require('../helpers/clover/prService');
const { addCatalogItem, ensureInventoryV1 } = require('../helpers/clover/inventoryService');
const { seedSeasonalEventTemplates } = require('../helpers/clover/seasonalEventCatalog');

function policyRegistry() {
    return createPreResetPolicyRegistry({ testOnly:true, policies:{
        PRE_RESET_MODE:{ status:'ENABLED', policyVersion:'f10-mode-v1' },
        SESSION_ELIGIBILITY:{ status:'ENABLED', policyVersion:'f10-session-v1', eligibleReleasedSessions:true },
    }});
}
function adminContext(preReset = 'OFF') {
    return {
        actorId:'admin-f10',
        env:{ PRE_RESET_LAUNCH_ENABLED:'true', PRE_RESET_RETURN_ENABLED:'true', PRE_RESET:preReset },
        policyRegistry:policyRegistry(),
        capabilities:['prereset.review','player.manage','operation.apply'],
    };
}
async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clover-f10-'));
    const db = await database.criarBanco({ filename:path.join(dir,'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
    return db;
}
async function player(db,id,name) {
    await db.run(
        `INSERT INTO jogadores
         (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
         VALUES (?,?,'aprovada','liberado',?,?,'approved')`,
        [id,`Player ${id}`,name,`Aparencia ${name}`]
    );
}
test('F10: migration 0038 fecha a cadeia depois de 0037', () => {
    assert.deepEqual(CURRENT_SCHEMA_MIGRATIONS.slice(-4).map((m)=>m.version), [35,36,37,38]);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.at(-1).key, '0038_prereset_future_rolls');
});

test('F10: whitelist ADM e autoridade unica; ausente vira reset e roster finalizado congela', async (t) => {
    const db = await fixture(t);
    await player(db,'f10-keep','Keep');
    await player(db,'f10-reset','Reset');
    const ctx = adminContext();
    const replaced = await replaceKeepRoster(db,ctx,{
        operationKey:'f10:roster:replace:0001', expectedRevision:0, keepPlayerIds:['f10-keep'],
    });
    assert.deepEqual(replaced.counts,{ eligible:2, keep:1, reset:1 });
    assert.equal((await previewRoster(db)).players.find((p)=>p.playerId==='f10-keep').outcome,'keep');
    assert.equal((await previewRoster(db)).players.find((p)=>p.playerId==='f10-reset').outcome,'reset');
    await assert.rejects(
        replaceKeepRoster(db,ctx,{ operationKey:'f10:roster:stale:0001', expectedRevision:0, keepPlayerIds:[] }),
        (error)=>error?.code === 'roster_revision_conflict'
    );
    await finalizeRoster(db,ctx,{
        operationKey:'f10:roster:finalize:0001', expectedRevision:1,
    });
    await assert.rejects(
        replaceKeepRoster(db,ctx,{ operationKey:'f10:roster:late:0001', expectedRevision:1, keepPlayerIds:[] }),
        (error)=>error?.code === 'roster_finalized'
    );
});

test('F10: preserva PV e caixas, converte PR uma vez e reseta somente fora da whitelist', async (t) => {
    const db = await fixture(t);
    await player(db,'f10-k','Keep K');
    await player(db,'f10-r','Reset R');
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await addCatalogItem(db,'f10-r','box_simple_v1',1,{ source:'f10_fixture', createdBy:'admin-f10' });
    await addCatalogItem(db,'f10-r','pocao_cura_basica',1,{ source:'f10_fixture', createdBy:'admin-f10' });
    await creditPv(db,'f10-r',7,{
        operationKey:'f10:pv:legacy:0001', source:'fixture_existing_pv', reason:'PV preexistente', createdBy:'admin-f10',
    });
    await adminAdjustPr(db,'f10-r',10,'PR legado fixture','admin-f10',{ idempotencyKey:'f10:legacy-pr:0001' });

    const ctxOff = adminContext('OFF');
    await replaceKeepRoster(db,ctxOff,{ operationKey:'f10:roster:replace:0002', expectedRevision:0, keepPlayerIds:['f10-k'] });
    await finalizeRoster(db,ctxOff,{ operationKey:'f10:roster:finalize:0002', expectedRevision:1 });
    const economyBefore = await previewLaunchEconomy(db);
    assert.equal(economyBefore.blockedByConversionPolicy,true);
    await assert.rejects(applyLaunch(db,ctxOff,{ operationKey:'f10:apply:0001' }), (error)=>error?.code === 'prereset_real_apply_disabled');

    await configurePrPvPolicy(db,ctxOff,{
        operationKey:'f10:policy:fixture:0001', policyVersion:'TEST_ONLY_1_TO_1', numerator:1, denominator:1, rounding:'floor',
    });
    assert.equal((await previewLaunchEconomy(db)).blockedByConversionPolicy,false);

    const applied = await applyLaunch(db,adminContext('ON'),{ operationKey:'f10:apply:0001' });
    assert.equal(applied.completed,true);
    assert.equal((await db.get("SELECT personagem_nome FROM jogadores WHERE id='f10-k'")).personagem_nome,'Keep K');
    const resetPlayer = await db.get("SELECT personagem_nome,ficha_status,jogo_status FROM jogadores WHERE id='f10-r'");
    assert.deepEqual(resetPlayer,{ personagem_nome:'-', ficha_status:'incompleta', jogo_status:'bloqueado' });
    assert.equal(await getPvBalance(db,'f10-r'),17);
    assert.equal(await getPrBalance(db,'f10-r'),0);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id='f10-r' AND template_key='box_simple_v1'")).total,1);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id='f10-r' AND template_key='pocao_cura_basica'")).total,0);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_prereset_pr_pv_claims WHERE player_id='f10-r'")).total,1);
    const replay = await applyLaunch(db,adminContext('ON'),{ operationKey:'f10:apply:0001' });
    assert.equal(replay.duplicate,true);
    assert.equal(await getPvBalance(db,'f10-r'),17);
});
