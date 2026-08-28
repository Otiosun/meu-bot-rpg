'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    configurePrPvPolicy,
    finalizeRoster,
    replaceKeepRoster,
} = require('../helpers/clover/preResetLaunchService');
const { creditPv, getPvBalance } = require('../helpers/clover/pvService');
const { adminAdjustPr, getPrBalance } = require('../helpers/clover/prService');
const { addCatalogItem, ensureInventoryV1 } = require('../helpers/clover/inventoryService');
const { seedSeasonalEventTemplates } = require('../helpers/clover/seasonalEventCatalog');
const { buildPreResetLaunchPreviewReadOnly } = require('../scripts/previewPreResetLaunchReadOnly');

function policyRegistry() {
    return createPreResetPolicyRegistry({ testOnly:true, policies:{
        PRE_RESET_MODE:{ status:'ENABLED', policyVersion:'preview-mode-v1' },
        SESSION_ELIGIBILITY:{ status:'ENABLED', policyVersion:'preview-session-v1', eligibleReleasedSessions:true },
    }});
}

function adminContext() {
    return {
        actorId:'admin-preview',
        env:{ PRE_RESET_LAUNCH_ENABLED:'true', PRE_RESET_RETURN_ENABLED:'true', PRE_RESET:'OFF' },
        policyRegistry:policyRegistry(),
        capabilities:['prereset.review','player.manage','operation.apply'],
    };
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clover-preview-'));
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

async function inventoryCount(db, playerId, templateKey) {
    return Number((await db.get(
        'SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id=? AND template_key=?',
        [playerId,templateKey]
    ))?.total || 0);
}

test('preview pre-reset read-only expõe personagem, economia, caixas e plano KEEP/RESET sem aplicar nada', async (t) => {
    const db = await fixture(t);
    await player(db,'preview-keep','Keep Hero');
    await player(db,'preview-reset','Reset Hero');
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await addCatalogItem(db,'preview-reset','box_simple_v1',1,{ source:'preview_fixture', createdBy:'admin-preview' });
    await addCatalogItem(db,'preview-reset','pocao_cura_basica',1,{ source:'preview_fixture', createdBy:'admin-preview' });
    await creditPv(db,'preview-reset',7,{
        operationKey:'preview:pv:0001', source:'fixture_existing_pv', reason:'PV existente', createdBy:'admin-preview',
    });
    await adminAdjustPr(db,'preview-reset',10,'PR legado fixture','admin-preview',{ idempotencyKey:'preview:pr:0001' });

    const ctx = adminContext();
    await replaceKeepRoster(db,ctx,{
        operationKey:'preview:roster:replace:0001', expectedRevision:0, keepPlayerIds:['preview-keep'],
    });
    await finalizeRoster(db,ctx,{
        operationKey:'preview:roster:finalize:0001', expectedRevision:1,
    });

    const before = {
        pv:await getPvBalance(db,'preview-reset'),
        pr:await getPrBalance(db,'preview-reset'),
        box:await inventoryCount(db,'preview-reset','box_simple_v1'),
        potion:await inventoryCount(db,'preview-reset','pocao_cura_basica'),
        character:(await db.get("SELECT personagem_nome FROM jogadores WHERE id='preview-reset'")).personagem_nome,
    };

    const pending = await buildPreResetLaunchPreviewReadOnly(db);
    assert.equal(pending.roster.source,'launch_players');
    assert.equal(pending.roster.status,'finalized');
    assert.equal(pending.blockedByConversionPolicy,true);
    assert.deepEqual(pending.counts,{ players:2, keep:1, reset:1, boxesPreserved:1 });

    const keep = pending.players.find((row) => row.playerId === 'preview-keep');
    assert.equal(keep.outcome,'keep');
    assert.equal(keep.characterName,'Keep Hero');
    assert.equal(keep.deletionPlan.willResetCharacter,false);
    assert.deepEqual(keep.preservationPlan.discarded,[]);

    const reset = pending.players.find((row) => row.playerId === 'preview-reset');
    assert.equal(reset.outcome,'reset');
    assert.equal(reset.characterName,'Reset Hero');
    assert.equal(reset.currentPv,7);
    assert.equal(reset.legacyPr,10);
    assert.equal(reset.conversion.status,'policy_pending');
    assert.equal(reset.resultingPv,null);
    assert.equal(reset.boxesPreserved.length,1);
    assert.equal(reset.boxesPreserved[0].templateKey,'box_simple_v1');
    assert.equal(reset.deletionPlan.willResetCharacter,true);
    assert.equal(reset.deletionPlan.nonBoxInventoryItems,1);
    assert.ok(reset.preservationPlan.preserved.includes('owned_boxes'));
    assert.ok(reset.preservationPlan.discarded.includes('non_box_inventory'));

    await configurePrPvPolicy(db,ctx,{
        operationKey:'preview:policy:0001', policyVersion:'TEST_ONLY_1_TO_1',
        numerator:1, denominator:1, rounding:'floor',
    });
    const ready = await buildPreResetLaunchPreviewReadOnly(db);
    const readyReset = ready.players.find((row) => row.playerId === 'preview-reset');
    assert.equal(ready.blockedByConversionPolicy,false);
    assert.equal(ready.conversionPolicy.policyVersion,'TEST_ONLY_1_TO_1');
    assert.equal(ready.conversionPolicy.numerator,1);
    assert.equal(ready.conversionPolicy.denominator,1);
    assert.equal(readyReset.conversion.convertedPv,10);
    assert.equal(readyReset.resultingPv,17);

    const after = {
        pv:await getPvBalance(db,'preview-reset'),
        pr:await getPrBalance(db,'preview-reset'),
        box:await inventoryCount(db,'preview-reset','box_simple_v1'),
        potion:await inventoryCount(db,'preview-reset','pocao_cura_basica'),
        character:(await db.get("SELECT personagem_nome FROM jogadores WHERE id='preview-reset'")).personagem_nome,
    };
    assert.deepEqual(after,before);
});
