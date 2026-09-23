'use strict';

const crypto = require('node:crypto');
const { ensurePreresetManualPurchaseSchema } = require('./prManualPurchaseImportService');
const { addCatalogItemInTransaction, ensureInventoryV1 } = require('./inventoryService');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { buildFulfilledRoll } = require('./preresetReturnShopFulfillmentService');

const CAMPAIGN_KEY = 'mythic_launch_v1';
const SOURCE = 'return_shop_owner_correction_20260918';
const ACTOR_ID = 'owner:return-shop-correction-20260918';
const FAKE_ID = '129403438817389@lid';
const MALTH_ID = '149701705904226@lid';
const FAKE_OPERATION_KEY = `${SOURCE}:fake:nobreza-humano`;
const FAKE_FAMILY_OPERATION_KEY = `${SOURCE}:fake:family-snyle`;
const MALTH_OPERATION_KEY = `${SOURCE}:malth:ticket-4-royal-60-ph`;

function stableHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function draftHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function parseJson(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
}

async function ensureSchema(db) {
    await ensurePreresetManualPurchaseSchema(db);
    await ensureInventoryV1(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_return_shop_owner_corrections (
            operation_key TEXT PRIMARY KEY,
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            correction_kind TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

async function returnPointBalance(db, playerId) {
    const row = await db.get(
        'SELECT COALESCE(SUM(amount),0) AS balance FROM clover_return_points_ledger WHERE player_id=?',
        [playerId]
    );
    return Number(row?.balance || 0);
}

async function receipt(db, operationKey) {
    return db.get('SELECT * FROM clover_return_shop_owner_corrections WHERE operation_key=?', [operationKey]);
}

async function playerSnapshot(db, playerId) {
    return db.get(
        `SELECT id,nome,nome_real,personagem_nome,reino,classe,familia,raca,grimorio,
                numero_roll_escolhido,ficha_status,jogo_status
           FROM jogadores WHERE id=?`,
        [playerId]
    );
}

async function fakePlan(db, blockers) {
    const player = await playerSnapshot(db, FAKE_ID);
    const character = await db.get(
        'SELECT status,draft_json FROM clover_prereset_characters WHERE player_id=?',
        [FAKE_ID]
    );
    const draft = parseJson(character?.draft_json);
    const rollNumber = Number(draft.rollNumber || player?.numero_roll_escolhido || 0);
    const futureRoll = rollNumber ? await db.get(
        `SELECT * FROM clover_prereset_future_rolls
          WHERE campaign_key=? AND player_id=? AND roll_number=?`,
        [CAMPAIGN_KEY, FAKE_ID, rollNumber]
    ) : null;
    const canonicalRoll = rollNumber ? await db.get(
        'SELECT * FROM player_rolls WHERE player_id=? AND roll_number=?',
        [FAKE_ID, rollNumber]
    ) : null;
    const purchases = await db.all(
        'SELECT id,idempotency_key,price_return_points,metadata_json FROM clover_prereset_purchases WHERE player_id=? ORDER BY id',
        [FAKE_ID]
    );
    const dwarfPurchases = purchases.filter((row) => {
        const metadata = parseJson(row.metadata_json);
        return (metadata.items || []).some((item) => ['dwarf', 'anao'].includes(String(item.key || '').toLowerCase()));
    });
    const balance = await returnPointBalance(db, FAKE_ID);
    const applied = Boolean(await receipt(db, FAKE_OPERATION_KEY));
    if (!player) blockers.push({ operationKey:FAKE_OPERATION_KEY, reason:'player_missing' });
    if (!character || !['approved', 'locked'].includes(character.status)) {
        blockers.push({ operationKey:FAKE_OPERATION_KEY, reason:'future_character_not_final', status:character?.status || null });
    }
    if (!rollNumber || !futureRoll || !canonicalRoll) {
        blockers.push({ operationKey:FAKE_OPERATION_KEY, reason:'selected_roll_missing', rollNumber });
    }
    if (!applied && balance < 400) blockers.push({ operationKey:FAKE_OPERATION_KEY, reason:'insufficient_pr', balance, required:400 });
    if (dwarfPurchases.length) blockers.push({ operationKey:FAKE_OPERATION_KEY, reason:'unexpected_dwarf_purchase', purchases:dwarfPurchases.map((row) => row.id) });
    return {
        operationKey:FAKE_OPERATION_KEY,
        playerId:FAKE_ID,
        player,
        characterStatus:character?.status || null,
        rollNumber,
        futureRoll,
        canonicalRoll,
        balance,
        dwarfPurchases:dwarfPurchases.map((row) => row.id),
        applied,
        pending:!applied,
    };
}

async function malthPlan(db, blockers) {
    const player = await playerSnapshot(db, MALTH_ID);
    const balance = await returnPointBalance(db, MALTH_ID);
    const applied = Boolean(await receipt(db, MALTH_OPERATION_KEY));
    const nobreza = await db.get(
        `SELECT id FROM clover_prereset_purchases
          WHERE player_id=? AND status='completed'
            AND LOWER(COALESCE(metadata_json,'')) LIKE '%nobreza%'
          ORDER BY id LIMIT 1`,
        [MALTH_ID]
    );
    if (!player) blockers.push({ operationKey:MALTH_OPERATION_KEY, reason:'player_missing' });
    if (!nobreza) blockers.push({ operationKey:MALTH_OPERATION_KEY, reason:'nobreza_purchase_missing' });
    if (!applied && balance < 450) blockers.push({ operationKey:MALTH_OPERATION_KEY, reason:'insufficient_pr', balance, required:450 });
    return {
        operationKey:MALTH_OPERATION_KEY,
        playerId:MALTH_ID,
        player,
        balance,
        nobrezaPurchaseId:nobreza?.id || null,
        applied,
        pending:!applied,
    };
}

async function fakeFamilyPlan(db, blockers) {
    const applied = Boolean(await receipt(db, FAKE_FAMILY_OPERATION_KEY));
    const character = await db.get(
        'SELECT status,draft_json,revision FROM clover_prereset_characters WHERE player_id=?',
        [FAKE_ID]
    );
    const draft = parseJson(character?.draft_json);
    const rollNumber = Number(draft.rollNumber || 0);
    const futureRoll = rollNumber ? await db.get(
        `SELECT * FROM clover_prereset_future_rolls
          WHERE campaign_key=? AND player_id=? AND roll_number=?`,
        [CAMPAIGN_KEY,FAKE_ID,rollNumber]
    ) : null;
    const canonicalRoll = rollNumber ? await db.get(
        'SELECT * FROM player_rolls WHERE player_id=? AND roll_number=?',
        [FAKE_ID,rollNumber]
    ) : null;
    const occupancy = Number((await db.get(
        `SELECT COUNT(*) AS total FROM clover_prereset_future_slot_reservations
          WHERE campaign_key=? AND category='family' AND option_key='snyle'
            AND status IN ('held','consumed') AND player_id<>?`,
        [CAMPAIGN_KEY,FAKE_ID]
    ))?.total || 0);
    if (!applied && (!character || !['approved','locked'].includes(character.status))) {
        blockers.push({ operationKey:FAKE_FAMILY_OPERATION_KEY,reason:'future_character_not_final',status:character?.status || null });
    }
    if (!applied && (!rollNumber || !futureRoll || !canonicalRoll)) {
        blockers.push({ operationKey:FAKE_FAMILY_OPERATION_KEY,reason:'selected_roll_missing',rollNumber });
    }
    if (!applied && occupancy >= 6) {
        blockers.push({ operationKey:FAKE_FAMILY_OPERATION_KEY,reason:'snyle_capacity_full',occupancy,capacity:6 });
    }
    return {
        operationKey:FAKE_FAMILY_OPERATION_KEY,
        playerId:FAKE_ID,
        character,
        draft,
        rollNumber,
        futureRoll,
        canonicalRoll,
        occupancy,
        capacity:6,
        applied,
        pending:!applied,
    };
}

async function planReturnShopOwnerCorrection(db) {
    await ensureSchema(db);
    const blockers = [];
    const fake = await fakePlan(db, blockers);
    const fakeFamily = await fakeFamilyPlan(db, blockers);
    const malth = await malthPlan(db, blockers);
    const hashInput = {
        fake:{ pending:fake.pending, balance:fake.balance, rollNumber:fake.rollNumber, race:fake.futureRoll?.race_key, socialClass:fake.futureRoll?.social_class_key, dwarfPurchases:fake.dwarfPurchases },
        fakeFamily:{ pending:fakeFamily.pending,rollNumber:fakeFamily.rollNumber,currentFamily:fakeFamily.futureRoll?.family,occupancy:fakeFamily.occupancy },
        malth:{ pending:malth.pending, balance:malth.balance, nobrezaPurchaseId:malth.nobrezaPurchaseId },
        blockers,
    };
    return {
        ok:blockers.length === 0,
        planHash:stableHash(hashInput),
        summary:{ pending:Number(fake.pending) + Number(fakeFamily.pending) + Number(malth.pending), fakeApplied:fake.applied, fakeFamilyApplied:fakeFamily.applied, malthApplied:malth.applied },
        fake,
        fakeFamily,
        malth,
        blockers,
    };
}

async function debitReturnPoints(db, playerId, amount, operationKey, reason, metadata) {
    const existing = await db.get('SELECT * FROM clover_return_points_ledger WHERE operation_key=?', [operationKey]);
    if (existing) return { duplicate:true, ledgerId:Number(existing.id) };
    const inserted = await db.run(
        `INSERT INTO clover_return_points_ledger
         (player_id,amount,entry_kind,operation_key,source,reason,policy_version,reset_cycle_key,
          related_id,correlation_id,created_by,metadata_json)
         VALUES (?,?,'debit',?,?,?,?,?,?,?,?,?)`,
        [playerId,-Math.abs(amount),operationKey,SOURCE,reason,SOURCE,CAMPAIGN_KEY,
            operationKey,operationKey,ACTOR_ID,JSON.stringify(metadata)]
    );
    return { duplicate:false, ledgerId:Number(inserted.lastID) };
}

async function createPurchase(db, { playerId, operationKey, amount, ledgerId, items, targetRollNumber = null }) {
    const existing = await db.get('SELECT * FROM clover_prereset_purchases WHERE idempotency_key=?', [operationKey]);
    if (existing) {
        const entitlement = await db.get('SELECT * FROM clover_prereset_entitlements WHERE purchase_id=?', [existing.id]);
        return { purchase:existing, entitlement, duplicate:true };
    }
    const metadata = {
        manual:true,
        source:SOURCE,
        owner_confirmed:true,
        reset_cycle_key:CAMPAIGN_KEY,
        target_campaign_key:CAMPAIGN_KEY,
        target_player_id:playerId,
        target_roll_number:targetRollNumber,
        requires_roll_assignment:false,
        fulfillment_status:'pending_character_fulfillment',
        items,
        created_by:ACTOR_ID,
    };
    const entitlementKey = `return_shop_package:${operationKey}`;
    const purchaseResult = await db.run(
        `INSERT INTO clover_prereset_purchases
         (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,
          return_points_ledger_id,status,metadata_json)
         VALUES (?,?, 'return_shop_normal_package',?,?,?,'completed',?)`,
        [playerId,operationKey,entitlementKey,amount,ledgerId,JSON.stringify(metadata)]
    );
    const entitlementResult = await db.run(
        `INSERT INTO clover_prereset_entitlements
         (player_id,entitlement_key,purchase_id,status,metadata_json)
         VALUES (?,?,?,'active',?)`,
        [playerId,entitlementKey,purchaseResult.lastID,JSON.stringify(metadata)]
    );
    return {
        purchase:{ id:Number(purchaseResult.lastID), metadata_json:JSON.stringify(metadata) },
        entitlement:{ id:Number(entitlementResult.lastID), metadata_json:JSON.stringify(metadata) },
        duplicate:false,
    };
}

async function completeEntitlement(db, purchase, entitlement, fulfillment) {
    const base = parseJson(entitlement.metadata_json || purchase.metadata_json);
    const metadata = {
        ...base,
        fulfillment_status:'fulfilled',
        fulfilled_at:fulfillment.fulfilledAt,
        fulfilled_by:ACTOR_ID,
        fulfillment_result:fulfillment.result,
    };
    await db.run(
        `UPDATE clover_prereset_purchases SET metadata_json=? WHERE id=?`,
        [JSON.stringify(metadata), purchase.id]
    );
    await db.run(
        `UPDATE clover_prereset_entitlements
            SET status='consumed',consumed_at=CURRENT_TIMESTAMP,metadata_json=? WHERE id=?`,
        [JSON.stringify(metadata), entitlement.id]
    );
    return metadata;
}

async function recordCorrection(db, operationKey, playerId, kind, before, after) {
    await db.run(
        `INSERT INTO clover_return_shop_owner_corrections
         (operation_key,campaign_key,player_id,correction_kind,before_json,after_json,created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [operationKey,CAMPAIGN_KEY,playerId,kind,JSON.stringify(before),JSON.stringify(after),ACTOR_ID]
    );
}

async function applyMalth(db, plan) {
    if (!plan.pending) return { duplicate:true };
    const items = [
        { key:'spellTicket', label:'Ticket de Feitico', quantity:1, unit_price_return_points:150, total_price_return_points:150, scope:'normal' },
        { key:'royalBox', label:'Caixa Real', quantity:4, unit_price_return_points:60, total_price_return_points:240, scope:'normal' },
        { key:'ph', label:'PH para novo personagem', quantity:60, unit_price_return_points:1, total_price_return_points:60, scope:'normal' },
    ];
    const debit = await debitReturnPoints(db,MALTH_ID,450,`${MALTH_OPERATION_KEY}:debit`,
        'Loja de Retorno confirmada: Ticket de Feitico + 4 Caixas Reais + 60 PH',{ items });
    const created = await createPurchase(db,{ playerId:MALTH_ID,operationKey:MALTH_OPERATION_KEY,amount:450,ledgerId:debit.ledgerId,items });
    const ticket = await addCatalogItemInTransaction(db,MALTH_ID,'ticket_feitico',1,{
        source:SOURCE,relatedId:MALTH_OPERATION_KEY,idempotencyKey:`${MALTH_OPERATION_KEY}:ticket`,createdBy:ACTOR_ID,forceSeparate:true,
        metadata:{ campaign_key:CAMPAIGN_KEY,purchase_id:created.purchase.id,entitlement_id:created.entitlement.id },
    });
    const boxes = await addCatalogItemInTransaction(db,MALTH_ID,'box_royal_v1',4,{
        source:SOURCE,relatedId:MALTH_OPERATION_KEY,idempotencyKey:`${MALTH_OPERATION_KEY}:royal-boxes`,createdBy:ACTOR_ID,forceSeparate:true,
        metadata:{ campaign_key:CAMPAIGN_KEY,purchase_id:created.purchase.id,entitlement_id:created.entitlement.id },
    });
    const ph = await addPhInTransaction(db,MALTH_ID,60,SOURCE,'Compra confirmada da Loja de Retorno',ACTOR_ID,
        { campaign_key:CAMPAIGN_KEY,purchase_id:created.purchase.id,entitlement_id:created.entitlement.id },`${MALTH_OPERATION_KEY}:ph`);
    const afterBalance = await returnPointBalance(db,MALTH_ID);
    const result = { ticketItemIds:ticket.items.map((item) => item.id),royalBoxItemIds:boxes.items.map((item) => item.id),phLedgerId:ph.ledgerId,returnPointsBalance:afterBalance };
    await completeEntitlement(db,created.purchase,created.entitlement,{ fulfilledAt:new Date().toISOString(),result });
    await recordCorrection(db,MALTH_OPERATION_KEY,MALTH_ID,'confirmed_missing_purchase',
        { returnPointsBalance:plan.balance },result);
    return { duplicate:false,...result };
}

async function updateRoll(db, table, roll) {
    await db.run(
        `UPDATE ${table}
            SET social_class=?,social_class_key=?,race=?,race_key=?,summary=?,roll_payload=?
          WHERE player_id=? AND roll_number=?${table === 'clover_prereset_future_rolls' ? ' AND campaign_key=?' : ''}`,
        [roll.social_class,roll.social_class_key,roll.race,roll.race_key,roll.summary,roll.roll_payload,
            roll.player_id,roll.roll_number,...(table === 'clover_prereset_future_rolls' ? [CAMPAIGN_KEY] : [])]
    );
}

async function applyFake(db, plan) {
    if (!plan.pending) return { duplicate:true };
    const items = [
        { key:'nobreza', label:'Nobreza', quantity:1, unit_price_return_points:400, total_price_return_points:400, scope:'normal', exclusive_category:'classe_social' },
        { key:'human', label:'Humano', quantity:1, unit_price_return_points:0, total_price_return_points:0, scope:'normal', exclusive_category:'raca' },
    ];
    const debit = await debitReturnPoints(db,FAKE_ID,400,`${FAKE_OPERATION_KEY}:debit`,
        'Loja de Retorno confirmada: Nobreza + Humano',{ items, no_dwarf_purchase:true });
    const created = await createPurchase(db,{ playerId:FAKE_ID,operationKey:FAKE_OPERATION_KEY,amount:400,ledgerId:debit.ledgerId,items,targetRollNumber:plan.rollNumber });
    const entry = {
        entitlementId:created.entitlement.id,
        purchaseId:created.purchase.id,
        playerId:FAKE_ID,
        label:'Nobreza + Humano',
        targetRollNumber:plan.rollNumber,
        metadata:{ ...parseJson(created.entitlement.metadata_json),items },
    };
    const built = buildFulfilledRoll(entry,plan.futureRoll,{ actorId:ACTOR_ID });
    await updateRoll(db,'clover_prereset_future_rolls',built.roll);
    await updateRoll(db,'player_rolls',built.roll);
    await db.run(
        `UPDATE jogadores SET classe=?,raca=? WHERE id=?`,
        [built.roll.social_class,built.roll.race,FAKE_ID]
    );
    await db.run(
        `UPDATE clover_prereset_future_slot_reservations
            SET status='released',released_at=COALESCE(released_at,CURRENT_TIMESTAMP)
          WHERE campaign_key=? AND player_id=? AND roll_number=?
            AND category='race' AND option_key='anao' AND status IN ('held','consumed')`,
        [CAMPAIGN_KEY,FAKE_ID,plan.rollNumber]
    );
    const afterBalance = await returnPointBalance(db,FAKE_ID);
    const result = {
        rollNumber:plan.rollNumber,
        socialClassKey:built.roll.social_class_key,
        raceKey:built.roll.race_key,
        appliedItems:built.appliedItems,
        returnPointsBalance:afterBalance,
        dwarfPurchaseRefund:0,
    };
    await completeEntitlement(db,created.purchase,created.entitlement,{ fulfilledAt:built.fulfilledAt,result });
    await recordCorrection(db,FAKE_OPERATION_KEY,FAKE_ID,'confirmed_build_purchase',{
        returnPointsBalance:plan.balance,
        socialClassKey:plan.futureRoll.social_class_key,
        raceKey:plan.futureRoll.race_key,
        dwarfPurchases:plan.dwarfPurchases,
    },result);
    return { duplicate:false,...result };
}

async function applyFakeFamily(db, plan) {
    if (!plan.pending) return { duplicate:true };
    const before = {
        playerFamily:(await playerSnapshot(db,FAKE_ID))?.familia || null,
        draftFamilyKey:plan.draft.familyKey || null,
        futureRollFamily:plan.futureRoll.family || null,
        canonicalRollFamily:plan.canonicalRoll.family || null,
        occupancy:plan.occupancy,
    };
    const draft = { ...plan.draft,familyKey:'snyle' };
    await db.run(
        `UPDATE clover_prereset_characters
            SET draft_json=?,draft_hash=?,revision=revision+1,updated_by=?,updated_at=CURRENT_TIMESTAMP
          WHERE player_id=?`,
        [JSON.stringify(draft),draftHash(draft),ACTOR_ID,FAKE_ID]
    );
    await db.run(
        `UPDATE clover_prereset_future_rolls SET family='Snyle'
          WHERE campaign_key=? AND player_id=? AND roll_number=?`,
        [CAMPAIGN_KEY,FAKE_ID,plan.rollNumber]
    );
    await db.run(
        `UPDATE player_rolls SET family='Snyle' WHERE player_id=? AND roll_number=?`,
        [FAKE_ID,plan.rollNumber]
    );
    await db.run(
        `UPDATE jogadores SET familia='Snyle',familia_key='snyle' WHERE id=?`,
        [FAKE_ID]
    );
    await db.run(
        `INSERT INTO clover_prereset_future_slot_reservations
         (campaign_key,player_id,roll_number,category,option_key,status,source,consumed_at)
         VALUES (?,?,?,'family','snyle','consumed',?,CURRENT_TIMESTAMP)
         ON CONFLICT(campaign_key,player_id,roll_number,category) DO UPDATE SET
            option_key='snyle',status='consumed',source=excluded.source,
            released_at=NULL,consumed_at=CURRENT_TIMESTAMP`,
        [CAMPAIGN_KEY,FAKE_ID,plan.rollNumber,SOURCE]
    );
    const after = { family:'Snyle',familyKey:'snyle',rollNumber:plan.rollNumber,occupancyAfter:plan.occupancy + 1 };
    await recordCorrection(db,FAKE_FAMILY_OPERATION_KEY,FAKE_ID,'confirmed_family',before,after);
    return { duplicate:false,...after };
}

async function applyReturnShopOwnerCorrection(db, options = {}) {
    if (options.execute !== true) throw new Error('Aplicacao real exige execute=true.');
    await ensureSchema(db);
    const before = await planReturnShopOwnerCorrection(db);
    if (!before.ok) throw new Error(`Preflight bloqueado: ${JSON.stringify(before.blockers)}`);
    if (options.expectedPlanHash && options.expectedPlanHash !== before.planHash) throw new Error('Plano divergiu do preflight.');
    await ensurePhState(db,MALTH_ID);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const gate = await db.get(
            'SELECT status FROM clover_return_point_shop_gate WHERE campaign_key=?',
            [CAMPAIGN_KEY]
        );
        if (!gate) throw new Error('Gate da Loja de Retorno nao encontrada.');
        if (gate.status !== 'open') {
            await db.run(
                `UPDATE clover_return_point_shop_gate
                    SET status='open',updated_at=CURRENT_TIMESTAMP
                  WHERE campaign_key=?`,
                [CAMPAIGN_KEY]
            );
        }
        const malth = await applyMalth(db,before.malth);
        const fake = await applyFake(db,before.fake);
        const fakeFamily = await applyFakeFamily(db,before.fakeFamily);
        if (gate.status !== 'open') {
            await db.run(
                `UPDATE clover_return_point_shop_gate
                    SET status=?,updated_at=CURRENT_TIMESTAMP
                  WHERE campaign_key=?`,
                [gate.status,CAMPAIGN_KEY]
            );
        }
        await db.exec('COMMIT');
        const after = await planReturnShopOwnerCorrection(db);
        return { ok:true,applied:true,before:{ planHash:before.planHash,summary:before.summary },malth,fake,fakeFamily,after };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ACTOR_ID,
    CAMPAIGN_KEY,
    FAKE_ID,
    FAKE_FAMILY_OPERATION_KEY,
    FAKE_OPERATION_KEY,
    MALTH_ID,
    MALTH_OPERATION_KEY,
    SOURCE,
    applyReturnShopOwnerCorrection,
    planReturnShopOwnerCorrection,
};
