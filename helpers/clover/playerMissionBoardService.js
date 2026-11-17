'use strict';

const {
    getMission,
    listMissions,
} = require('./adminMissionService');

const PUBLIC_RANKS = Object.freeze(['E', 'D', 'C', 'B', 'A', 'S']);
const PRIVATE_VISIBILITIES = new Set(['private', 'invite', 'invitation', 'staff', 'hidden']);
const MAX_PAGE_SIZE = 8;

function isPublicMission(mission, now = new Date()) {
    if (!mission || mission.status !== 'published') return false;
    const visibility = String(mission.metadata?.visibility || 'public').trim().toLowerCase();
    if (PRIVATE_VISIBILITIES.has(visibility) || visibility !== 'public') return false;
    if (mission.metadata?.publicListing === false) return false;
    if (!mission.deadlineAt) return false;
    const deadline = new Date(mission.deadlineAt);
    return Number.isFinite(deadline.getTime()) && deadline.getTime() > now.getTime();
}

function toPublicMission(mission) {
    if (!mission) return null;
    const reward = mission.reward || {};
    const boundedRange = (value) => Array.isArray(value)
        && value.length === 2
        && value.every((number) => Number.isSafeInteger(number) && number >= 0)
        ? [...value] : null;
    return {
        missionKey: mission.missionKey,
        title: mission.title,
        rank: mission.rank,
        mode: mission.mode,
        missionType: mission.missionType,
        location: mission.location,
        risk: mission.risk,
        slots: mission.slots,
        deadlineAt: mission.deadlineAt,
        description: mission.description,
        specialConditions: mission.specialConditions,
        failureConsequence: mission.failureConsequence,
        reward: {
            ph: boundedRange(reward.ph),
            stars: boundedRange(reward.stars),
            yulls: boundedRange(reward.yulls),
            extra: reward.extra || null,
        },
    };
}

async function listPublicMissions(db, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const rank = options.rank ? String(options.rank).trim().toUpperCase() : null;
    if (rank && !PUBLIC_RANKS.includes(rank)) {
        const error = new Error('Rank inválido. Escolha E, D, C, B, A ou S.');
        error.code = 'invalid_mission_rank';
        throw error;
    }
    const page = Number(options.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
        const error = new Error('Página inválida.');
        error.code = 'invalid_mission_page';
        throw error;
    }
    const rows = await listMissions(db, { status: 'published', ...(rank ? { rank } : {}) });
    const visible = rows.filter((mission) => isPublicMission(mission, now));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(options.limit || 6)));
    return {
        missions: visible.slice((page - 1) * limit, page * limit).map(toPublicMission),
        total: visible.length,
        rank,
        page,
        pages: Math.max(1, Math.ceil(visible.length / limit)),
    };
}

async function getPublicMission(db, missionKey, options = {}) {
    const key = String(missionKey || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{2,119}$/.test(key)) return null;
    const mission = await getMission(db, key);
    return isPublicMission(mission, options.now instanceof Date ? options.now : new Date())
        ? toPublicMission(mission)
        : null;
}

module.exports = {
    MAX_PAGE_SIZE,
    PUBLIC_RANKS,
    getPublicMission,
    isPublicMission,
    listPublicMissions,
    toPublicMission,
};
