'use strict';

const { equivalentPlayerIds } = require('./playerIdentityEquivalenceService');
const { requiresRollAssignment } = require('./preresetReturnShopAssignmentService');

class ReturnShopBuildError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ReturnShopBuildError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new ReturnShopBuildError(code, message);
}

async function getReturnShopBuildState(db, playerId, campaignKey = 'mythic_launch_v1') {
    const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('clover_prereset_entitlements','clover_prereset_purchases')`);
    if (tables.length !== 2) return [];
    const ids = [...new Set([playerId, ...await equivalentPlayerIds(db, playerId)])];
    const rows = await db.all(`SELECT e.id,e.status,e.metadata_json,p.metadata_json purchase_metadata
        FROM clover_prereset_entitlements e JOIN clover_prereset_purchases p ON p.id=e.purchase_id
        WHERE e.player_id IN (${ids.map(() => '?').join(',')}) AND e.status IN ('active','consumed')
        AND p.status='completed' AND p.catalog_item_key LIKE 'return_shop_%'`, ids);
    return rows.map(row => {
        const metadata = { ...JSON.parse(row.purchase_metadata || '{}'), ...JSON.parse(row.metadata_json || '{}') };
        const fulfilled = metadata.roll_fulfillment_status === 'fulfilled' || metadata.fulfillment_status === 'fulfilled';
        const stageableCharacterDelivery = metadata.fulfillment_status === 'pending_character_fulfillment'
            && !requiresRollAssignment(metadata);
        return { id: row.id, status: row.status, metadata, fulfilled, stageableCharacterDelivery,
            rollNumber: Number(metadata.roll_fulfilled_roll_number || metadata.fulfilled_roll_number || metadata.target_roll_number || 0),
            needsRoll: !fulfilled && requiresRollAssignment(metadata) };
    }).filter(row => (row.metadata.target_campaign_key || row.metadata.reset_cycle_key || 'mythic_launch_v1') === campaignKey);
}

async function assertReturnShopCharacterReady(db, playerId, rollNumber, options = {}) {
    const entries = await getReturnShopBuildState(db, playerId, options.campaignKey);
    if (options.forSubmit && entries.some(e => e.status === 'active' && e.needsRoll)) {
        fail('return_shop_build_pending', 'Escolha o roll das compras em .#pr compras e confirme com .#pr finalizar compras antes de enviar a ficha.');
    }
    if (entries.some(e => e.fulfilled && e.rollNumber && e.rollNumber !== Number(rollNumber))) {
        fail('return_shop_roll_locked', 'As compras ja foram aplicadas em outro roll. A equipe precisa revisar antes de trocar o personagem.');
    }
}

async function assertReturnShopSacrificeAllowed(db, playerId, campaignKey, onlyRollNumber) {
    const entries = await getReturnShopBuildState(db, playerId, campaignKey);
    if (entries.some(e => e.rollNumber && (e.needsRoll || e.fulfilled)
        && (onlyRollNumber === undefined || e.rollNumber === Number(onlyRollNumber)))) {
        fail('return_shop_roll_protected', 'Ha compras vinculadas aos seus rolls. O sacrificio precisa de revisao para nao perder suas compras.');
    }
}

async function assertReturnShopLaunchReady(db, playerId, campaignKey) {
    const entries = await getReturnShopBuildState(db, playerId, campaignKey);
    if (entries.some(e => e.status === 'active' && !e.fulfilled && !e.stageableCharacterDelivery)) {
        fail('return_shop_delivery_pending', 'Existem compras pendentes de aplicacao ou entrega. O reset deste jogador nao pode ser executado ainda.');
    }
}

module.exports = { ReturnShopBuildError, getReturnShopBuildState, assertReturnShopCharacterReady, assertReturnShopSacrificeAllowed, assertReturnShopLaunchReady };
