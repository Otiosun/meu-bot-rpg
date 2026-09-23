'use strict';

const crypto = require('node:crypto');
const { addCatalogItemInTransaction, ensureInventoryV1 } = require('./inventoryService');

const CAMPAIGN_KEY = 'mythic_launch_v1';
const OPERATION_KEY = 'prereset_participant_royal_box_bonus_20260918';
const TEMPLATE_KEY = 'box_royal_v1';
const QUANTITY = 2;
const ACTOR_ID = 'owner:prereset-participant-bonus-20260918';

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function tableExists(db, name) {
    return Boolean(await db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?", [name]));
}

function historyKey(playerId) {
    return `${OPERATION_KEY}:${playerId}`;
}

async function campaignStart(db) {
    const row = await db.get(
        `SELECT MIN(completed_at) AS started_at
           FROM clover_prereset_launch_players
          WHERE campaign_key=? AND status='completed'`,
        [CAMPAIGN_KEY]
    );
    return row?.started_at || null;
}

async function participantRows(db) {
    const startedAt = await campaignStart(db);
    if (!startedAt) return { startedAt:null, rows:[] };
    const hasFutureRolls = await tableExists(db, 'clover_prereset_future_rolls');
    const hasFutureCharacters = await tableExists(db, 'clover_prereset_characters');
    const unions = [
        `SELECT player_id,'keep' AS reason
           FROM clover_prereset_launch_players
          WHERE campaign_key=? AND outcome='keep' AND status='completed'`,
        `SELECT player_id,'post_launch_roll' AS reason
           FROM player_rolls WHERE created_at>=?`,
    ];
    const params = [CAMPAIGN_KEY, startedAt];
    if (hasFutureRolls) {
        unions.push("SELECT player_id,'future_roll' AS reason FROM clover_prereset_future_rolls WHERE campaign_key=?");
        params.push(CAMPAIGN_KEY);
    }
    if (hasFutureCharacters) {
        unions.push("SELECT player_id,'future_character' AS reason FROM clover_prereset_characters");
    }
    const rows = await db.all(
        `WITH participants AS (${unions.join(' UNION ALL ')})
         SELECT p.player_id,GROUP_CONCAT(DISTINCT p.reason) AS reasons,
                j.nome,j.personagem_nome,j.ficha_status,j.jogo_status
           FROM participants p
           JOIN jogadores j ON j.id=p.player_id
          WHERE COALESCE(j.is_test_user,0)=0
            AND COALESCE(j.is_shadow,0)=0
            AND COALESCE(j.is_canonical,1)=1
            AND LOWER(COALESCE(j.lifecycle_status,'active'))<>'archived'
          GROUP BY p.player_id
          ORDER BY p.player_id`,
        params
    );
    return { startedAt, rows };
}

async function planPreresetParticipantRoyalBoxBonus(db) {
    const prerequisites = ['jogadores', 'player_rolls', 'clover_prereset_launch_players', 'clover_inventory_item_history'];
    const missingTables = [];
    for (const table of prerequisites) if (!await tableExists(db, table)) missingTables.push(table);
    if (missingTables.length) {
        return { ok:false, blockers:[{ reason:'missing_tables', tables:missingTables }], recipients:[], planHash:null };
    }
    const template = await db.get(
        'SELECT template_key,item_name,active FROM clover_item_templates WHERE template_key=?',
        [TEMPLATE_KEY]
    );
    const blockers = [];
    if (!template || Number(template.active) !== 1) blockers.push({ reason:'royal_box_template_unavailable' });
    const { startedAt, rows } = await participantRows(db);
    if (!startedAt) blockers.push({ reason:'campaign_launch_not_completed' });
    const recipients = [];
    for (const row of rows) {
        const idempotencyKey = historyKey(row.player_id);
        const receipt = await db.get(
            'SELECT id,item_id,quantity_delta FROM clover_inventory_item_history WHERE idempotency_key=?',
            [idempotencyKey]
        );
        recipients.push({
            playerId:String(row.player_id),
            name:String(row.personagem_nome || row.nome || '-'),
            reasons:String(row.reasons || '').split(',').filter(Boolean).sort(),
            idempotencyKey,
            delivered:Boolean(receipt),
            receipt:receipt || null,
        });
    }
    const hashInput = {
        campaignKey:CAMPAIGN_KEY,
        startedAt,
        templateKey:TEMPLATE_KEY,
        quantity:QUANTITY,
        recipients:recipients.map((row) => ({ playerId:row.playerId, delivered:row.delivered })),
        blockers,
    };
    return {
        ok:blockers.length === 0,
        campaignKey:CAMPAIGN_KEY,
        startedAt,
        planHash:hash(hashInput),
        summary:{
            eligible:recipients.length,
            pending:recipients.filter((row) => !row.delivered).length,
            delivered:recipients.filter((row) => row.delivered).length,
            boxesToGrant:recipients.filter((row) => !row.delivered).length * QUANTITY,
        },
        recipients,
        blockers,
    };
}

async function applyPreresetParticipantRoyalBoxBonus(db, request = {}) {
    if (request.execute !== true) throw new Error('Aplicacao real exige execute=true.');
    await ensureInventoryV1(db);
    const before = await planPreresetParticipantRoyalBoxBonus(db);
    if (!before.ok) throw new Error(`Preflight bloqueado: ${JSON.stringify(before.blockers)}`);
    if (request.expectedPlanHash && request.expectedPlanHash !== before.planHash) {
        throw new Error('Plano divergiu do preflight.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const locked = await planPreresetParticipantRoyalBoxBonus(db);
        if (locked.planHash !== before.planHash) throw new Error('Plano mudou durante a aplicacao.');
        for (const recipient of locked.recipients.filter((row) => !row.delivered)) {
            await addCatalogItemInTransaction(db, recipient.playerId, TEMPLATE_KEY, QUANTITY, {
                source:OPERATION_KEY,
                relatedId:CAMPAIGN_KEY,
                idempotencyKey:recipient.idempotencyKey,
                createdBy:ACTOR_ID,
                metadata:{
                    campaign_key:CAMPAIGN_KEY,
                    participant_reasons:recipient.reasons,
                    administrative_bonus:true,
                },
            });
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    return { ok:true, before, after:await planPreresetParticipantRoyalBoxBonus(db) };
}

module.exports = {
    ACTOR_ID,
    CAMPAIGN_KEY,
    OPERATION_KEY,
    QUANTITY,
    TEMPLATE_KEY,
    applyPreresetParticipantRoyalBoxBonus,
    historyKey,
    planPreresetParticipantRoyalBoxBonus,
};
