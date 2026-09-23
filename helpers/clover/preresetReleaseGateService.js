'use strict';

const { auditPreresetCharacterStates } = require('./preresetCharacterStateAuditService');
const { requiresRollAssignment } = require('./preresetReturnShopAssignmentService');

function safeJson(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
}

async function tableExists(db, name) {
    return Boolean((await db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?", [name]))?.ok);
}

async function auditShop(db, relevantPlayerIds = null) {
    if (!await tableExists(db, 'clover_prereset_entitlements')
        || !await tableExists(db, 'clover_prereset_purchases')) {
        return { total: 0, blockers: [{ code: 'return_shop_tables_missing' }], stageable: 0, fulfilled: 0 };
    }
    const rows = await db.all(`SELECT e.id,e.player_id,e.status,e.metadata_json,p.metadata_json purchase_metadata
        FROM clover_prereset_entitlements e
        JOIN clover_prereset_purchases p ON p.id=e.purchase_id
        WHERE p.status='completed' AND p.catalog_item_key LIKE 'return_shop_%'
          AND e.status IN ('active','consumed')`);
    let stageable = 0;
    let fulfilled = 0;
    let deferredPlayers = 0;
    const blockers = [];
    for (const row of rows) {
        if (relevantPlayerIds && !relevantPlayerIds.has(String(row.player_id))) {
            deferredPlayers += 1;
            continue;
        }
        const metadata = { ...safeJson(row.purchase_metadata), ...safeJson(row.metadata_json) };
        const done = metadata.fulfillment_status === 'fulfilled' || metadata.roll_fulfillment_status === 'fulfilled';
        const characterStage = metadata.fulfillment_status === 'pending_character_fulfillment'
            && !requiresRollAssignment(metadata);
        if (done) fulfilled += 1;
        else if (characterStage) stageable += 1;
        else if (row.status === 'active') blockers.push({
            code: 'return_shop_not_ready', entitlementId: row.id, playerId: row.player_id,
            fulfillmentStatus: metadata.fulfillment_status || 'pending',
        });
    }
    return { total: rows.length, blockers, stageable, fulfilled, deferredPlayers };
}

async function auditPreresetReleaseGate(db, options = {}) {
    const campaignKey = options.campaignKey || 'mythic_launch_v1';
    const integrityRow = await db.get('PRAGMA integrity_check');
    const integrity = integrityRow?.integrity_check || Object.values(integrityRow || {})[0] || null;
    const characters = await auditPreresetCharacterStates(db, { campaignKey });
    const launchStatuses = new Set(['submitted', 'approved', 'locked']);
    const relevantPlayerIds = new Set(characters.records
        .filter(record => launchStatuses.has(record.status))
        .map(record => record.playerId));
    const shop = await auditShop(db, relevantPlayerIds);
    const blockers = [];
    if (integrity !== 'ok') blockers.push({ code: 'sqlite_integrity_failed', value: integrity });
    for (const record of characters.records) {
        if (record.status === 'submitted') blockers.push({ code: 'sheet_waiting_review', playerId: record.playerId, name: record.characterName });
        if (['approved', 'locked'].includes(record.status) && record.issues.includes('selected_roll_missing')) {
            blockers.push({ code: 'approved_sheet_roll_missing', playerId: record.playerId, name: record.characterName });
        }
    }
    blockers.push(...shop.blockers);
    return {
        ok: blockers.length === 0,
        verdict: blockers.length === 0 ? 'READY_FOR_CONTROLLED_LAUNCH' : 'BLOCKED',
        campaignKey,
        integrity,
        counts: characters.counts,
        draftsWaitingPlayers: Number(characters.counts.draft || 0),
        shop: { total: shop.total, stageableAtLaunch: shop.stageable, fulfilled: shop.fulfilled, deferredWithDrafts: shop.deferredPlayers },
        blockers,
    };
}

module.exports = { auditPreresetReleaseGate, auditShop };
