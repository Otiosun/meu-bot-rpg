'use strict';

const { createHash } = require('node:crypto');
const { getReturnPointShopItem, RETURN_POINT_SHOP_CATALOG_VERSION } = require('./returnPointShopCatalog');
const { getConfigOption, getSlotConfigOption } = require('./configLoader');
const { withImmediateTransaction } = require('./sqliteImmediateTransactionService');

class ReturnPointShopManualError extends Error {
    constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new ReturnPointShopManualError(code, details); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const {canonicalEffectValue}=require('./returnShopApprovedGrimoireMapping');
const BUILD_KINDS = new Set(['kingdom','race','grimoire','social_class']);
const TRAIT_KINDS = new Set(['rare_aptitude_entitlement','rare_mark_entitlement','anomaly_entitlement']);
function text(value, field) {
    if (typeof value !== 'string' || !value.trim() || value.length > 255) fail('manual_invalid_argument', {field});
    return value.trim();
}
function metadata(row) {
    try {
        const value = JSON.parse(row.metadata_json);
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        if (row.manual_import_id && row.manifest_json) {
            const manifest = JSON.parse(row.manifest_json);
            const effect = manifest.effects.find(effect => effect.itemKey === value.itemKey);
            if (!effect || manifest.playerId !== row.player_id || manifest.campaignKey !== value.campaignKey
                || Number(row.manual_import_id) !== value.manualImportId
                || ['effectKind','effectValue','quantity','targetMode'].some(key => effect[key] !== value[key])) throw new Error();
        }
        return value;
    } catch { return fail('manual_metadata_invalid', {entitlementId:row.id}); }
}
async function hasManualSchema(db) {
    return Boolean(await db.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clover_return_shop_manual_imports'"));
}
async function manualRows(db, playerId = null) {
    if (!await hasManualSchema(db)) return [];
    return db.all(`SELECT e.*,i.manifest_json,i.player_id AS import_owner
        FROM clover_prereset_entitlements e JOIN clover_return_shop_manual_imports i ON i.id=e.manual_import_id
        ${playerId == null ? '' : 'WHERE e.player_id=?'} ORDER BY e.id`, playerId == null ? [] : [String(playerId)]);
}
async function importManualReturnShopObligation(db, request = {}) {
    const owner = text(request.playerId,'playerId');
    const operationKey = text(request.operationKey,'operationKey');
    const provenance = {
        externalReference:text(request.externalReference,'externalReference'), source:text(request.source,'source'),
        sourceRowId:text(request.sourceRowId,'sourceRowId'), acquiredAt:text(request.acquiredAt,'acquiredAt'),
    };
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(provenance.acquiredAt)
        || !Number.isFinite(Date.parse(provenance.acquiredAt))) fail('manual_invalid_acquired_at');
    if (new Date(provenance.acquiredAt).toISOString().replace('.000Z','Z') !== provenance.acquiredAt.replace('.000Z','Z')) fail('manual_invalid_acquired_at');
    const actor = text(request.actorId,'actorId');
    const campaignKey = text(request.campaignKey,'campaignKey');
    if (!Array.isArray(request.effects) || !request.effects.length || request.effects.length > 30) fail('manual_invalid_manifest');
    const seen = new Set();
    const effects = request.effects.map(effect => {
        const item = getReturnPointShopItem(text(effect?.itemKey,'itemKey'));
        if (!item?.purchasable) fail('manual_unknown_catalog_item');
        const quantity = effect.quantity ?? 1;
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > item.maxQuantityPerPurchase) fail('manual_invalid_quantity');
        if (seen.has(item.effectKind) && (BUILD_KINDS.has(item.effectKind) || TRAIT_KINDS.has(item.effectKind))) fail('manual_exclusive_effect_conflict');
        if (seen.has(item.itemKey)) fail('manual_duplicate_effect');
        seen.add(item.effectKind); seen.add(item.itemKey);
        return {itemKey:item.itemKey,effectKind:item.effectKind,effectValue:item.effectValue,quantity,targetMode:item.targetMode};
    }).sort((a,b) => a.itemKey.localeCompare(b.itemKey));
    const manifest = {playerId:owner,campaignKey,provenance,catalogVersion:RETURN_POINT_SHOP_CATALOG_VERSION,effects};
    const requestHash = hash(manifest);
    return withImmediateTransaction(db, async () => {
        const replay = await db.get('SELECT * FROM clover_return_shop_manual_imports WHERE operation_key=?',[operationKey]);
        if (replay) {
            const stored=JSON.parse(replay.manifest_json);
            const approvedReplay={...stored,effects:stored.effects.map(effect=>({...effect,effectValue:canonicalEffectValue(effect)}))};
            if ((replay.request_hash !== requestHash && (hash(stored)!==replay.request_hash || hash(approvedReplay)!==requestHash)) || replay.imported_by !== actor) fail('manual_idempotency_conflict');
            return {ok:true,duplicate:true,importId:replay.id};
        }
        if (!await db.get('SELECT id FROM jogadores WHERE id=?',[owner])) fail('manual_owner_not_found');
        if (await db.get('SELECT id FROM clover_return_shop_manual_imports WHERE external_reference=? OR (source=? AND source_row_id=?)',
            [provenance.externalReference,provenance.source,provenance.sourceRowId])) fail('manual_duplicate_obligation');
        const inserted = await db.run(`INSERT INTO clover_return_shop_manual_imports
            (player_id,operation_key,external_reference,source,source_row_id,acquired_at,imported_by,request_hash,manifest_json)
            VALUES (?,?,?,?,?,?,?,?,?)`,[owner,operationKey,provenance.externalReference,provenance.source,provenance.sourceRowId,provenance.acquiredAt,actor,requestHash,JSON.stringify(manifest)]);
        const importId = Number(inserted.lastID);
        for (const effect of effects) {
            await db.run(`INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,manual_import_id,metadata_json)
                VALUES (?,?,?,?)`,[owner,`return-shop:manual:${importId}:${effect.itemKey}`,importId,
                JSON.stringify({...effect,campaignKey,manualImportId:importId,targetRollNumber:null,catalogVersion:RETURN_POINT_SHOP_CATALOG_VERSION})]);
        }
        // Capacity is promised at import time, including obligations without a roll.
        for (const effect of effects.filter(e => ['race','grimoire'].includes(e.effectKind))) {
            const available = await require('./preResetFutureSlotService').getFutureSlotAvailability(db,effect.effectKind,effect.effectValue,campaignKey);
            if (available.limited && available.usedCount > available.capacity) fail('manual_slot_full');
        }
        return {ok:true,duplicate:false,importId};
    });
}
async function audit(db, importId, type, request, details) {
    await db.run(`INSERT INTO clover_return_shop_manual_operations
        (operation_key,manual_import_id,operation_type,request_hash,actor_id,details_json) VALUES (?,?,?,?,?,?)`,
        [request.operationKey,importId,type,hash(request),request.actorId,JSON.stringify(details)]);
}
async function replayOperation(db, importId, type, request) {
    const prior = await db.get('SELECT * FROM clover_return_shop_manual_operations WHERE operation_key=?',[request.operationKey]);
    if (!prior) return false;
    if (Number(prior.manual_import_id) !== importId || prior.operation_type !== type || prior.request_hash !== hash(request)) fail('manual_idempotency_conflict');
    return true;
}
async function ownedPackage(db, owner, importId) {
    const imported = await db.get('SELECT * FROM clover_return_shop_manual_imports WHERE id=?',[importId]);
    if (!imported || imported.player_id !== owner) fail('manual_wrong_owner');
    const rows = (await manualRows(db,owner)).filter(r => Number(r.manual_import_id) === importId);
    if (!rows.length || rows.some(r => r.import_owner !== owner)) fail('manual_package_invalid');
    const manifest = JSON.parse(imported.manifest_json);
    const itemKeys = rows.map(row => metadata(row).itemKey);
    if (rows.length !== manifest.effects.length || new Set(itemKeys).size !== rows.length
        || manifest.effects.some(effect => !itemKeys.includes(effect.itemKey))) fail('manual_package_invalid');
    return rows;
}
function operationRequest(request) {
    const importId = Number(request.importId), targetRollNumber = Number(request.targetRollNumber);
    if (!Number.isSafeInteger(importId) || importId < 1 || !Number.isSafeInteger(targetRollNumber) || targetRollNumber < 1) fail('manual_invalid_target');
    return {importId,playerId:text(request.playerId,'playerId'),campaignKey:text(request.campaignKey,'campaignKey'),targetRollNumber,
        actorId:text(request.actorId,'actorId'),operationKey:text(request.operationKey,'operationKey')};
}
async function assertMutableTarget(db, request) {
    await require('./preResetFutureRollService').assertBuildPlayer(db,request.playerId);
    const character = await db.get('SELECT status FROM clover_prereset_characters WHERE player_id=?',[request.playerId]);
    if (character && character.status !== 'draft') fail('manual_character_locked');
    const roll = await db.get('SELECT * FROM clover_prereset_future_rolls WHERE campaign_key=? AND player_id=? AND roll_number=?',
        [request.campaignKey,request.playerId,request.targetRollNumber]);
    if (!roll) fail('manual_target_not_found');
    const final = await db.get('SELECT 1 FROM clover_prereset_future_rolls WHERE campaign_key=? AND player_id=? AND roll_number=6',[request.campaignKey,request.playerId]);
    if (final && request.targetRollNumber !== 6) fail('manual_target_replaced');
    return roll;
}
async function assignManualReturnShopObligation(db, input = {}) {
    const request = operationRequest(input);
    return withImmediateTransaction(db, async () => {
        const rows = await ownedPackage(db,request.playerId,request.importId);
        if (await replayOperation(db,request.importId,'assign',request)) return {ok:true,duplicate:true};
        if (rows.some(r => r.status !== 'active' || metadata(r).buildApplied)) fail('manual_already_consumed');
        await assertMutableTarget(db,request);
        const conflicts = await db.all(`SELECT e.id,e.metadata_json FROM clover_prereset_entitlements e
            LEFT JOIN clover_prereset_purchases p ON p.id=e.purchase_id
            WHERE e.player_id=? AND (e.manual_import_id IS NOT NULL OR p.status='completed') AND e.status!='revoked'`,[request.playerId]);
        const exclusive = new Set(rows.map(metadata).filter(m => m.targetMode === 'roll').map(m => m.effectKind));
        for (const row of conflicts) {
            const m = metadata(row);
            if (!rows.some(r => r.id === row.id) && Number(m.targetRollNumber) === request.targetRollNumber
                && (!m.campaignKey || m.campaignKey === request.campaignKey) && exclusive.has(m.effectKind)) fail('manual_target_exclusive_conflict');
        }
        const before = rows.map(r => metadata(r).targetRollNumber);
        for (const row of rows) {
            const m = metadata(row);
            if (m.campaignKey !== request.campaignKey) fail('manual_campaign_mismatch');
            await db.run('UPDATE clover_prereset_entitlements SET metadata_json=? WHERE id=?',
                [JSON.stringify({...m,targetRollNumber:request.targetRollNumber}),row.id]);
        }
        for (const m of rows.map(metadata).filter(m => ['race','grimoire'].includes(m.effectKind))) {
            const available = await require('./preResetFutureSlotService').getFutureSlotAvailability(db,m.effectKind,canonicalEffectValue(m),request.campaignKey);
            if (available.limited && available.usedCount > available.capacity) fail('manual_slot_full');
        }
        await audit(db,request.importId,'assign',request,{before,after:request.targetRollNumber});
        return {ok:true,duplicate:false};
    });
}
async function fulfillManualReturnShopBuild(db, input = {}) {
    const request = operationRequest(input);
    const result = await withImmediateTransaction(db, async () => {
        const rows = await ownedPackage(db,request.playerId,request.importId);
        if (await replayOperation(db,request.importId,'fulfill',request)) return {ok:true,duplicate:true};
        const roll = await assertMutableTarget(db,request);
        if (rows.some(r => metadata(r).campaignKey !== request.campaignKey || Number(metadata(r).targetRollNumber) !== request.targetRollNumber)) fail('manual_assignment_required');
        const applicable = rows.filter(r => BUILD_KINDS.has(metadata(r).effectKind) || TRAIT_KINDS.has(metadata(r).effectKind));
        if (!applicable.length) fail('manual_no_build_effects');
        if (applicable.every(r => metadata(r).buildApplied)) return {ok:true,duplicate:true};
        if (applicable.some(r => r.status !== 'active' || metadata(r).buildApplied)) fail('manual_partial_consumption_conflict');
        const shop = require('./returnPointShopService');
        let next = roll;
        // Apply a single final patch through the modern effect writer. Kingdom,
        // race, then class avoids package input order changing bought fields.
        const order = ['kingdom','race','social_class','grimoire'];
        for (const kind of order) {
            const row = applicable.find(r => metadata(r).effectKind === kind);
            if (row) next = await shop.applyRollEffect(db,request.playerId,metadata(row),next);
        }
        const errors = require('./returnPointShopComposition').validatePurchasedRollComposition(next);
        const fields = {kingdom:'kingdom_key',race:'race_key',social_class:'social_class_key',grimoire:'grimoire_key'};
        for (const other of await manualRows(db,request.playerId)) {
            const m = metadata(other);
            if (other.status === 'revoked' || !m.buildApplied || m.campaignKey !== request.campaignKey
                || Number(m.targetRollNumber) !== request.targetRollNumber || !fields[m.effectKind]) continue;
            if (next[fields[m.effectKind]] !== canonicalEffectValue(m)) errors.push(`Purchased ${m.effectKind} would be overwritten.`);
        }
        if (errors.length) fail('manual_composition_conflict',{errors});
        for (const row of applicable) {
            const m = metadata(row);
            const consumed = BUILD_KINDS.has(m.effectKind);
            await db.run(`UPDATE clover_prereset_entitlements SET metadata_json=?,status=?,
                consumed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE consumed_at END WHERE id=? AND status='active'`,
                [JSON.stringify({...m,buildApplied:true}),consumed ? 'consumed':'active',consumed ? 1:0,row.id]);
        }
        await audit(db,request.importId,'fulfill',request,{entitlementIds:applicable.map(r => r.id),phase:'future_build'});
        return {ok:true,duplicate:false};
    }).catch(async error => {
        if (['manual_composition_conflict','roll_incompatible','invalid_catalog_effect','future_slot_full'].includes(error.code)) {
            await withImmediateTransaction(db,async () => {
                await ownedPackage(db,request.playerId,request.importId);
                const conflictRequest = {...request,operationKey:`conflict:${request.operationKey}`};
                if (!await replayOperation(db,request.importId,'conflict',conflictRequest)) await audit(db,request.importId,'conflict',conflictRequest,{code:error.code,...error.details});
            });
        }
        throw error;
    });
    return result;
}
async function countManualSlotCommitments(db, category, optionKey, campaignKey, options = {}) {
    const rows = await manualRows(db);
    let total = 0;
    for (const row of rows) {
        const m = metadata(row);
        if (row.status !== 'active' || m.effectKind !== category || canonicalEffectValue(m) !== optionKey || m.campaignKey !== campaignKey || m.buildApplied) continue;
        if (options.excludePlayerId === row.player_id && Number(options.excludeRollNumber) === Number(m.targetRollNumber)) continue;
        const option = getSlotConfigOption(category,optionKey);
        if (!option || option.capacity == null) continue;
        let represented = m.targetRollNumber && await db.get(`SELECT 1 FROM clover_prereset_future_slot_reservations
            WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=? AND option_key=? AND status IN ('held','consumed')`,
            [campaignKey,row.player_id,m.targetRollNumber,category,optionKey]);
        const keep = await db.get(`SELECT j.raca,j.grimorio FROM clover_prereset_launch_players p JOIN jogadores j ON j.id=p.player_id
            WHERE p.campaign_key=? AND p.player_id=? AND p.outcome='keep'`,[campaignKey,row.player_id]);
        if (keep) {
            const {keepValueForCategory,normalizeSlotKey} = require('./preResetFutureSlotService');
            const current = normalizeSlotKey(keepValueForCategory(keep,category).label);
            represented ||= current && [normalizeSlotKey(option.key),normalizeSlotKey(option.name)].includes(current);
        }
        if (!represented) total += m.quantity;
    }
    return total;
}
async function assertManualBuildBoundary(db, playerId, {campaignKey,rollNumber,submit=false,destructive=false} = {}) {
    for (const row of await manualRows(db,playerId)) {
        const m = metadata(row);
        if (campaignKey && m.campaignKey !== campaignKey) continue;
        if (!BUILD_KINDS.has(m.effectKind) && !TRAIT_KINDS.has(m.effectKind)) continue;
        const launch = await db.get('SELECT status FROM clover_prereset_launch_players WHERE campaign_key=? AND player_id=?',[m.campaignKey,String(playerId)]);
        if (launch && launch.status !== 'pending') continue;
        if (destructive && m.targetRollNumber && (!rollNumber || Number(m.targetRollNumber) === Number(rollNumber))) fail('manual_roll_protected');
        if (submit && row.status === 'active' && !m.buildApplied) fail('manual_build_pending');
        if (m.buildApplied && rollNumber && Number(m.targetRollNumber) !== Number(rollNumber)) fail('manual_roll_locked');
    }
}
async function assertManualLaunchReady(db, playerId, campaignKey) {
    for (const row of await manualRows(db,playerId)) {
        const m = metadata(row);
        if (m.campaignKey !== campaignKey || row.status === 'revoked') continue;
        if (m.targetMode !== 'roll') {
            if (row.status === 'active' && !require('./returnPointShopEconomicProviders').hasEconomicProvider(m.itemKey)) fail('manual_delivery_provider_pending',{entitlementId:row.id,effectKind:m.effectKind});
            continue;
        }
        const launch = await db.get('SELECT status FROM clover_prereset_launch_players WHERE campaign_key=? AND player_id=?',[campaignKey,String(playerId)]);
        if (launch && launch.status !== 'pending') continue;
        if (!m.buildApplied) fail('manual_build_pending');
        const roll = await db.get('SELECT 1 FROM clover_prereset_future_rolls WHERE campaign_key=? AND player_id=? AND roll_number=?',[campaignKey,String(playerId),m.targetRollNumber]);
        if (!roll) fail('manual_target_not_found');
    }
}
module.exports = { ReturnPointShopManualError, importManualReturnShopObligation, assignManualReturnShopObligation,
    fulfillManualReturnShopBuild, countManualSlotCommitments, assertManualBuildBoundary, assertManualLaunchReady, manualRows, metadata, hasManualSchema };
