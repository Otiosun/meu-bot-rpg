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
const FINAL_FUTURE_SACRIFICE_ROLL_NUMBER = MAX_PLAYER_ROLLS + 1;

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

function normalFutureRolls(rows) {
    return (rows || []).filter((row) => {
        const number = Number(row?.roll_number ?? row?.rollNumber);
        return Number.isInteger(number) && number >= 1 && number <= MAX_PLAYER_ROLLS;
    });
}

function hasFinalFutureRoll(rows) {
    return (rows || []).some((row) =>
        Number(row?.roll_number ?? row?.rollNumber) === FINAL_FUTURE_SACRIFICE_ROLL_NUMBER
    );
}

function limitedSlot(category, roll) {
    const optionKey = category === 'race'
        ? roll?.raceKey || roll?.race_key
        : roll?.grimoireKey || roll?.grimoire_key;
    if (!optionKey) return null;
    const option = getSlotConfigOption(category, optionKey);
    if (!option?.capacity) return null;
    return { category, key:option.key, capacity:Number(option.capacity) };
}

function invalidHeartRarity(roll) {
    const kingdom = String(roll?.kingdomKey || roll?.kingdom_key || '').toLowerCase();
    const rarity = String(roll?.magicRarityKey || roll?.magic_rarity_key || '').toLowerCase();
    return kingdom === 'heart' && rarity === 'lendaria';
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
    rollOptions = {},
} = {}) {
    for (let attempt = 1; attempt <= MAX_FUTURE_ROLL_ATTEMPTS; attempt += 1) {
        const roll = generateBaseRoll(nextRollNumber, { previousRolls, ...rollOptions });
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
        if (hasFinalFutureRoll(existing)) {
            await db.exec('COMMIT');
            return { ok:false, reason:'sacrifice_used', count:1, max:MAX_PLAYER_ROLLS };
        }

        const standard = normalFutureRolls(existing);
        if (standard.length >= MAX_PLAYER_ROLLS) {
            await db.exec('COMMIT');
            return { ok:false, reason:'limit_reached', count:standard.length, max:MAX_PLAYER_ROLLS };
        }

        const used = new Set(standard.map((row) => Number(row.roll_number)));
        const next = Array.from({ length:MAX_PLAYER_ROLLS }, (_, index) => index + 1)
            .find((number) => !used.has(number));

        const roll = await generateFutureBaseRoll(db, next, { previousRolls:standard });
        await storeFutureRoll(db, playerId, roll);
        const saved = await getFutureRollByNumber(db, playerId, next);
        await db.exec('COMMIT');
        return { ok:true, roll:saved, count:standard.length + 1, max:MAX_PLAYER_ROLLS };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

function paidPurchaseTargetRollNumber(metadataJson) {
    try {
        const metadata = JSON.parse(String(metadataJson || '{}'));
        return Number(metadata?.targetRollNumber || 0);
    } catch {
        return 0;
    }
}

async function hasPaidRollBoundReturnPointPurchase(db, playerId) {
    const rows = await db.all(
        `SELECT metadata_json
         FROM clover_prereset_purchases
         WHERE player_id=? AND status='completed'
         ORDER BY id ASC`,
        [String(playerId)]
    );
    return rows.some((row) => paidPurchaseTargetRollNumber(row.metadata_json) > 0);
}

async function createAndStoreFutureSacrificeRoll(
    db,
    playerId,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY
) {
    await assertBuildPlayer(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await listFutureRolls(db, playerId, campaignKey);

        if (hasFinalFutureRoll(existing)) {
            await db.exec('COMMIT');
            return { ok:false, reason:'already_used', roll:existing.find((row) =>
                Number(row.roll_number) === FINAL_FUTURE_SACRIFICE_ROLL_NUMBER
            ) };
        }

        // Esta barreira precisa viver dentro do mesmo BEGIN IMMEDIATE que libera/deleta os rolls.
        // O pre-check do comando existe para UX, mas nao e autoridade transacional.
        if (await hasPaidRollBoundReturnPointPurchase(db, playerId)) {
            await db.exec('COMMIT');
            return { ok:false, reason:'paid_roll_purchase' };
        }

        const standard = normalFutureRolls(existing);
        const numbers = new Set(standard.map((row) => Number(row.roll_number)));
        const complete = standard.length === MAX_PLAYER_ROLLS
            && Array.from({ length:MAX_PLAYER_ROLLS }, (_, index) => index + 1)
                .every((number) => numbers.has(number));

        if (!complete) {
            await db.exec('COMMIT');
            return { ok:false, reason:'not_enough_rolls', count:standard.length, max:MAX_PLAYER_ROLLS };
        }

        // Libera as vagas dos cinco rolls dentro da MESMA transacao.
        // Se qualquer etapa falhar, o rollback restaura tudo.
        for (const row of standard) {
            await releaseFutureRollSlots(db, playerId, row.roll_number, campaignKey);
        }

        const finalRoll = await generateFutureBaseRoll(
            db,
            FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
            {
                previousRolls:standard,
                campaignKey,
                rollOptions:{ sacrifice:true, forceMercy:true },
            }
        );

        const removed = await db.run(
            `DELETE FROM clover_prereset_future_rolls
             WHERE campaign_key=? AND player_id=? AND roll_number BETWEEN 1 AND ?`,
            [campaignKey,String(playerId),MAX_PLAYER_ROLLS]
        );
        if (Number(removed?.changes || 0) !== MAX_PLAYER_ROLLS) {
            throw new PreResetFutureRollError(
                'SACRIFICE_ROLL_SET_CHANGED',
                'O conjunto de rolls mudou durante o sacrificio.',
                { removed:Number(removed?.changes || 0), expected:MAX_PLAYER_ROLLS }
            );
        }

        await storeFutureRoll(db, playerId, finalRoll, campaignKey);
        const saved = await getFutureRollByNumber(
            db,
            playerId,
            FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
            campaignKey
        );

        await db.exec('COMMIT');
        return {
            ok:true,
            roll:saved,
            sacrificedRollNumbers:Array.from({ length:MAX_PLAYER_ROLLS }, (_, index) => index + 1),
            max:MAX_PLAYER_ROLLS,
        };
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
    FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
    PreResetFutureRollError,
    assertBuildPlayer,
    candidateFitsFutureSlots,
    createAndStoreFutureRoll,
    createAndStoreFutureSacrificeRoll,
    generateFutureBaseRoll,
    getFutureRollByNumber,
    hasFinalFutureRoll,
    listFutureRolls,
    normalFutureRolls,
    reserveFutureRollSlots,
    rollbackFutureRoll,
    storeFutureRoll,
};
