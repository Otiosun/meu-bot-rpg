'use strict';

const { MAX_PLAYER_ROLLS } = require('../../config/bot');
const { getSlotConfigOption } = require('./configLoader');
const { generateBaseRoll } = require('./rollEngine');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');
const { getAssignedPreResetState, isPreResetBuildState } = require('./preResetRosterStateService');
const {
    getFutureSlotAvailability,
    holdFutureSlot,
    releaseFutureRollSlots,
} = require('./preResetFutureSlotService');

const MAX_FUTURE_ROLL_ATTEMPTS = 250;

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
    return { category, key:option.key, capacity:Number(option.capacity) };
}

function invalidHeartRarity(roll) {
    if (String(roll?.kingdomKey || '').toLowerCase() !== 'heart') return false;
    return ['lendaria', 'mitica'].includes(String(roll?.magicRarityKey || '').toLowerCase());
}

async function candidateFitsFutureSlots(db, roll, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    for (const category of ['race', 'grimoire']) {
        const slot = limitedSlot(category, roll);
        if (!slot) continue;
        const availability = await getFutureSlotAvailability(db, category, slot.key, campaignKey);
        if (!availability.ok) return false;
    }
    return true;
}

async function generateFutureBaseRoll(db, nextRollNumber, {
    previousRolls = [],
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY,
} = {}) {
    for (let attempt = 1; attempt <= MAX_FUTURE_ROLL_ATTEMPTS; attempt += 1) {
        const roll = generateBaseRoll(nextRollNumber, { previousRolls });
        if (invalidHeartRarity(roll)) continue;
        if (!await candidateFitsFutureSlots(db, roll, campaignKey)) continue;
        return roll;
    }
    throw new PreResetFutureRollError(
        'NO_AVAILABLE_FUTURE_BASE_ROLL',
        'Nao encontrei combinacao futura com vagas depois de varias tentativas.',
        { attempts:MAX_FUTURE_ROLL_ATTEMPTS }
    );
}

async function reserveFutureRollSlots(db, playerId, roll, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    const slots = [limitedSlot('race', roll), limitedSlot('grimoire', roll)].filter(Boolean);
    for (const slot of slots) {
        const held = await holdFutureSlot(db, {
            playerId,
            rollNumber:roll.rollNumber,
            category:slot.category,
            optionKey:slot.key,
            campaignKey,
        });
        if (!held.ok) {
            throw new PreResetFutureRollError('SLOT_FULL', `slot_full:${slot.category}:${slot.key}`, {
                slot,
                availability:held.availability || null,
            });
        }
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
    await reserveFutureRollSlots(db, playerId, roll, campaignKey);
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
        const roll = await generateFutureBaseRoll(db, next, { previousRolls:existing });
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
        const releasedReservations = await releaseFutureRollSlots(db, playerId, rollNumber, campaignKey);
        await db.exec('COMMIT');
        return { removed:Number(removed?.changes || 0), releasedReservations };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PreResetFutureRollError,
    assertBuildPlayer,
    candidateFitsFutureSlots,
    createAndStoreFutureRoll,
    generateFutureBaseRoll,
    getFutureRollByNumber,
    listFutureRolls,
    rollbackFutureRoll,
};