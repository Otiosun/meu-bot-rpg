'use strict';

const { normalizeText } = require('../textUtils');
const { getSlotConfigOption } = require('./configLoader');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');

const FUTURE_SLOT_CATEGORIES = new Set(['family', 'anomaly', 'magic', 'race', 'grimoire']);

class PreResetFutureSlotError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetFutureSlotError';
        this.code = code;
        this.details = details;
    }
}

function normalizeSlotKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function requireLimitedOption(category, optionKey) {
    if (!FUTURE_SLOT_CATEGORIES.has(category)) {
        throw new PreResetFutureSlotError('invalid_future_slot_category', `Categoria futura invalida: ${category}.`);
    }
    const key = String(optionKey || '').trim();
    const option = key ? getSlotConfigOption(category, key) : null;
    if (!option || option.capacity === null || option.capacity === undefined) return null;
    return { category, key: option.key, name: option.name || option.key, capacity:Number(option.capacity) };
}

function keepValueForCategory(row, category) {
    if (category === 'race') return { key:null, label:row?.raca };
    if (category === 'grimoire') return { key:null, label:row?.grimorio };
    if (category === 'family') return { key:row?.familia_key, label:row?.familia };
    if (category === 'magic') return { key:row?.magia_key, label:row?.magia };
    if (category === 'anomaly') return { key:row?.anomalia_key, label:row?.anomalia };
    return { key:null, label:null };
}

async function countKeepOccupancy(db, category, optionKey, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    const option = requireLimitedOption(category, optionKey);
    if (!option) return 0;
    const rows = await db.all(
        `SELECT j.raca,j.grimorio,j.familia,j.familia_key,j.magia,j.magia_key,j.anomalia,j.anomalia_key
         FROM clover_prereset_launch_players p
         JOIN jogadores j ON j.id=p.player_id
         WHERE p.campaign_key=? AND p.outcome='keep'`,
        [campaignKey]
    );
    const expectedKey = String(option.key || '').trim();
    const expectedNormalizedKey = normalizeSlotKey(option.key);
    const expectedName = normalizeSlotKey(option.name);
    return rows.filter((row) => {
        const current = keepValueForCategory(row, category);
        if (current.key && String(current.key).trim() === expectedKey) return true;
        const value = normalizeSlotKey(current.label);
        return value && (value === expectedNormalizedKey || value === expectedName);
    }).length;
}

async function countFutureHolds(db, category, optionKey, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY, options = {}) {
    const params = [campaignKey, category, String(optionKey)];
    let exclude = '';
    if (options.excludePlayerId && options.excludeRollNumber) {
        exclude = ' AND NOT (player_id=? AND roll_number=?)';
        params.push(String(options.excludePlayerId), Number(options.excludeRollNumber));
    }
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND category=? AND option_key=? AND status='held'${exclude}`,
        params
    );
    return Number(row?.total || 0);
}

async function getFutureSlotAvailability(db, category, optionKey, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY, options = {}) {
    const option = requireLimitedOption(category, optionKey);
    if (!option) return { ok:true, limited:false, capacity:null, keepUsed:0, futureHeld:0, usedCount:0, remaining:null };
    const [keepUsed, futureHeld] = await Promise.all([
        countKeepOccupancy(db, category, option.key, campaignKey),
        countFutureHolds(db, category, option.key, campaignKey, options),
    ]);
    const manualCommitted = await require('./returnPointShopManualService').countManualSlotCommitments(db,category,option.key,campaignKey,options);
    const usedCount = keepUsed + futureHeld + manualCommitted;
    return { ok:usedCount < option.capacity, limited:true, capacity:option.capacity, keepUsed, futureHeld, manualCommitted, usedCount, remaining:Math.max(option.capacity - usedCount, 0) };
}

async function holdFutureSlot(db, {
    playerId,
    rollNumber,
    category,
    optionKey,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY,
    source = 'prereset_future_roll',
} = {}) {
    const option = requireLimitedOption(category, optionKey);
    if (!option) return { ok:true, limited:false, reservation:null };
    const id = String(playerId || '').trim();
    const number = Number(rollNumber);
    if (!id || !Number.isInteger(number) || number <= 0) {
        throw new PreResetFutureSlotError('invalid_future_slot_identity', 'Player/roll futuro invalido.');
    }
    const existing = await db.get(
        `SELECT * FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=?`,
        [campaignKey,id,number,category]
    );
    if (existing?.status === 'held' && existing.option_key === option.key) return { ok:true, limited:true, duplicate:true, reservation:existing };
    if (existing && existing.status !== 'released') throw new PreResetFutureSlotError('future_slot_identity_conflict', 'Reserva futura ja existe com outro estado.', { existing });

    const availability = await getFutureSlotAvailability(db, category, option.key, campaignKey, { excludePlayerId:id, excludeRollNumber:number });
    if (!availability.ok) return { ok:false, limited:true, reason:'capacity_full', option, availability };

    if (existing) {
        await db.run(
            `UPDATE clover_prereset_future_slot_reservations
             SET option_key=?, status='held', source=?, released_at=NULL, consumed_at=NULL
             WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=? AND status='released'`,
            [option.key,String(source || 'prereset_future_roll'),campaignKey,id,number,category]
        );
    } else {
        await db.run(
            `INSERT INTO clover_prereset_future_slot_reservations
             (campaign_key,player_id,roll_number,category,option_key,status,source)
             VALUES (?,?,?,?,?,'held',?)`,
            [campaignKey,id,number,category,option.key,String(source || 'prereset_future_roll')]
        );
    }
    return {
        ok:true,
        limited:true,
        duplicate:false,
        availability,
        reservation:await db.get(
            `SELECT * FROM clover_prereset_future_slot_reservations
             WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=?`,
            [campaignKey,id,number,category]
        ),
    };
}

async function releaseFutureSlotCategory(db, playerId, rollNumber, category, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    if (!FUTURE_SLOT_CATEGORIES.has(category)) throw new PreResetFutureSlotError('invalid_future_slot_category', `Categoria futura invalida: ${category}.`);
    const result = await db.run(
        `UPDATE clover_prereset_future_slot_reservations
         SET status='released', released_at=CURRENT_TIMESTAMP
         WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=? AND status='held'`,
        [campaignKey,String(playerId),Number(rollNumber),category]
    );
    return Number(result?.changes || 0);
}

async function releaseFutureRollSlots(db, playerId, rollNumber, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    const result = await db.run(
        `UPDATE clover_prereset_future_slot_reservations
         SET status='released', released_at=CURRENT_TIMESTAMP
         WHERE campaign_key=? AND player_id=? AND roll_number=? AND status='held'`,
        [campaignKey,String(playerId),Number(rollNumber)]
    );
    return Number(result?.changes || 0);
}

async function releaseUnselectedFutureSlots(db, playerId, selectedRollNumber, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    const result = await db.run(
        `UPDATE clover_prereset_future_slot_reservations
         SET status='released', released_at=CURRENT_TIMESTAMP
         WHERE campaign_key=? AND player_id=? AND roll_number<>? AND status='held'`,
        [campaignKey,String(playerId),Number(selectedRollNumber)]
    );
    return Number(result?.changes || 0);
}

async function listFutureSlotReservations(db, playerId, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    return db.all(
        `SELECT * FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND player_id=? ORDER BY roll_number,category`,
        [campaignKey,String(playerId)]
    );
}

module.exports = {
    keepValueForCategory,
    normalizeSlotKey,
    FUTURE_SLOT_CATEGORIES,
    PreResetFutureSlotError,
    countFutureHolds,
    countKeepOccupancy,
    getFutureSlotAvailability,
    holdFutureSlot,
    listFutureSlotReservations,
    releaseFutureRollSlots,
    releaseFutureSlotCategory,
    releaseUnselectedFutureSlots,
};
