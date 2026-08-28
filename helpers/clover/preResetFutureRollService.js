'use strict';

const { MAX_PLAYER_ROLLS } = require('../../config/bot');
const { getSlotConfigOption } = require('./configLoader');
const { countUsedSlots } = require('./slotManager');
const { generateAvailableBaseRoll } = require('./rollEngine');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');
const { getAssignedPreResetState, isPreResetBuildState } = require('./preResetRosterStateService');

class PreResetFutureRollError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetFutureRollError';
        this.code = code;
        this.details = details;
    }
}

async function assertBuildPlayer(db, playerId) {
    const state = await getAssignedPreResetState(db, playerId);
    if (!isPreResetBuildState(state)) {
        throw new PreResetFutureRollError(
            state?.kind === 'keep' ? 'keep_player_cannot_roll' : 'prereset_build_not_available',
            state?.kind === 'keep'
                ? 'Personagem marcado como MANTER nao participa dos novos sorteios.'
                : 'PRE_RESET de criacao ainda nao esta disponivel para este jogador.',
            { state: state?.kind || null }
        );
    }
    return state;
}

async function listFutureRolls(db, playerId, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    return db.all(
        `SELECT * FROM clover_prereset_future_rolls
         WHERE campaign_key=? AND player_id=?
         ORDER BY roll_number ASC`,
        [campaignKey, String(playerId)]
    );
}

async function getFutureRollByNumber(db, playerId, rollNumber, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    return db.get(
        `SELECT * FROM clover_prereset_future_rolls
         WHERE campaign_key=? AND player_id=? AND roll_number=?`,
        [campaignKey, String(playerId), Number(rollNumber)]
    );
}

function limitedSlot(category, roll) {
    const optionKey = category === 'race' ? roll?.raceKey : roll?.grimoireKey;
    if (!optionKey) return null;
    const option = getSlotConfigOption(category, optionKey);
    if (!option?.capacity) return null;
    return { category, key:option.key, capacity:option.capacity };
}

async function reserveFutureRollSlots(db, playerId, roll) {
    const slots = [limitedSlot('race', roll), limitedSlot('grimoire', roll)].filter(Boolean);
    for (const slot of slots) {
        const source = `prereset_roll_${slot.category}`;
        const usedCount = await countUsedSlots(db, slot.category, slot.key, { skipExpire:true });
        if (usedCount >= slot.capacity) {
            throw new PreResetFutureRollError('SLOT_FULL', `slot_full:${slot.category}:${slot.key}`, { slot });
        }
        await db.run(
            `INSERT INTO slot_reservations
             (player_id,category,option_key,status,source,roll_number,expires_at,created_at)
             VALUES (?, ?, ?, 'pending', ?, ?, datetime('now', '+24 hours'), CURRENT_TIMESTAMP)`,
            [String(playerId), slot.category, slot.key, source, Number(roll.rollNumber)]
        );
    }
}

async function storeFutureRoll(db, playerId, roll, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    await db.run(
        `INSERT INTO clover_prereset_future_rolls
         (campaign_key,player_id,roll_number,kingdom,social_class,family,race,grimoire,grimoire_rank,grimoire_symbol,
          magic_rarity,magic_scope,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_payload)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            campaignKey,String(playerId),Number(roll.rollNumber),roll.kingdom,roll.socialClass,roll.family || null,
            roll.race,roll.grimoire,roll.grimoireRank || null,roll.grimoireSymbol || null,roll.magicRarity,
            roll.magicScope || null,roll.summary,roll.rollVersion || 'clover_base_v2',roll.kingdomKey || null,
            roll.socialClassKey || null,roll.raceKey || null,roll.grimoireKey || null,roll.magicRarityKey || null,
            JSON.stringify(roll.payload || {}),
        ]
    );
    await reserveFutureRollSlots(db, playerId, roll);
}

async function createAndStoreFutureRoll(db, playerId) {
    await assertBuildPlayer(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await listFutureRolls(db, playerId);
        if (existing.length >= MAX_PLAYER_ROLLS) {
            await db.exec('COMMIT');
            return { ok:false, reason:'limit_reached', count:existing.length, max:MAX_PLAYER_ROLLS };
        }
        const used = new Set(existing.map((row) => Number(row.roll_number)));
        const next = Array.from({ length:MAX_PLAYER_ROLLS }, (_, index) => index + 1)
            .find((number) => !used.has(number));
        const roll = await generateAvailableBaseRoll(db, next, { previousRolls:existing });
        await storeFutureRoll(db, playerId, roll);
        const saved = await getFutureRollByNumber(db, playerId, next);
        await db.exec('COMMIT');
        return { ok:true, roll:saved, count:existing.length + 1, max:MAX_PLAYER_ROLLS };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function rollbackFutureRoll(db, playerId, rollNumber, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const removed = await db.run(
            `DELETE FROM clover_prereset_future_rolls
             WHERE campaign_key=? AND player_id=? AND roll_number=?`,
            [campaignKey,String(playerId),Number(rollNumber)]
        );
        const released = await db.run(
            `UPDATE slot_reservations SET status='released'
             WHERE player_id=? AND roll_number=?
               AND source IN ('prereset_roll_race','prereset_roll_grimoire')
               AND status='pending'`,
            [String(playerId),Number(rollNumber)]
        );
        await db.exec('COMMIT');
        return { removed:Number(removed?.changes || 0), releasedReservations:Number(released?.changes || 0) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PreResetFutureRollError,
    assertBuildPlayer,
    createAndStoreFutureRoll,
    getFutureRollByNumber,
    listFutureRolls,
    rollbackFutureRoll,
};
