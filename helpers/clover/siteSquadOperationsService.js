'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('./accessIntegrationService');
const { getAccessContext } = require('./accessControlService');
const { getRaidCategoryCatalog, raidMonthKey } = require('./raidService');
const { ensureRaidV2Schema } = require('./raidV2Schema');
const { resolveSquad } = require('./squadStateService');

const ACTIVE_MONTHLY_STATUSES = Object.freeze([
    'lobby', 'in_progress', 'finalization', 'completed',
]);
const SQUAD_MONTHLY_CATEGORIES = Object.freeze([
    'missao_esquadrao',
    'treino_esquadrao',
]);

function safeNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
}

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function displayName(player = {}) {
    return filled(player.personagem_nome)
        || filled(player.display_name)
        || filled(player.nome)
        || null;
}

async function playerIdentity(db, playerId) {
    if (!playerId) return null;
    const player = await db.get(
        `SELECT id, personagem_nome, display_name, nome, patente, magia, grimorio
         FROM jogadores WHERE id = ?`,
        [playerId]
    ).catch(() => null);
    if (!player) return { id: playerId, name: null };
    return {
        id: player.id,
        name: displayName(player),
        rank: filled(player.patente),
        magic: filled(player.magia),
        grimoire: filled(player.grimorio),
    };
}

function leadershipRole(actorId, squad) {
    if (isSameUser(actorId, squad.captain_player_id)) return 'captain';
    if (isSameUser(actorId, squad.vice_captain_player_id)) return 'vice_captain';
    return 'member';
}

function leadershipLabel(role) {
    if (role === 'captain') return 'Capitão';
    if (role === 'vice_captain') return 'Vice-Capitão';
    return 'Membro';
}

function statusBreakdown(rows) {
    const breakdown = {
        lobby: 0,
        inProgress: 0,
        finalization: 0,
        completed: 0,
        cancelled: 0,
    };
    for (const row of rows || []) {
        const amount = safeNumber(row.total);
        if (row.status === 'lobby') breakdown.lobby += amount;
        else if (row.status === 'in_progress') breakdown.inProgress += amount;
        else if (row.status === 'finalization') breakdown.finalization += amount;
        else if (row.status === 'completed') breakdown.completed += amount;
        else if (row.status === 'cancelled') breakdown.cancelled += amount;
    }
    return breakdown;
}

async function readMonthlyCategory(db, squadKey, category, monthKey) {
    const rows = await db.all(
        `SELECT status, COUNT(*) AS total
         FROM clover_raids
         WHERE scope_squad_key = ?
           AND category_key = ?
           AND month_key = ?
         GROUP BY status`,
        [squadKey, category.key, monthKey]
    ).catch(() => []);
    const breakdown = statusBreakdown(rows);
    const used = breakdown.lobby
        + breakdown.inProgress
        + breakdown.finalization
        + breakdown.completed;
    const limit = Number.isInteger(Number(category.monthlyLimit))
        ? Number(category.monthlyLimit)
        : null;
    return {
        key: category.key,
        label: category.label,
        description: category.description,
        monthKey,
        countsMonthly: Boolean(category.countsMonthly),
        limit,
        used,
        remaining: limit === null ? null : Math.max(0, limit - used),
        exhausted: limit !== null && used >= limit,
        breakdown,
    };
}

function serializeRaid(row = {}) {
    return {
        id: safeNumber(row.id),
        key: row.raid_key,
        name: row.name,
        category: row.category_key || row.category,
        categoryLabel: row.category_label || null,
        status: row.status,
        maxPlayers: safeNumber(row.max_players),
        participantCount: safeNumber(row.participant_count),
        createdAt: row.created_at || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        cancellationReason: row.cancellation_reason || null,
    };
}

function serializeStarEvent(row = {}) {
    return {
        id: safeNumber(row.id),
        amount: safeNumber(row.amount),
        kind: row.kind || null,
        source: row.source || null,
        reason: row.reason || null,
        playerId: row.player_id || null,
        playerName: row.player_name || null,
        createdBy: row.created_by || null,
        createdAt: row.created_at || null,
    };
}

async function getSquadOperations(db, {
    actorId,
    squadInput,
    recentLimit = 8,
    starLimit = 12,
} = {}) {
    await ensureRaidV2Schema(db);
    const actor = normalizeJid(actorId);
    const squad = typeof squadInput === 'object' && squadInput?.squad_key
        ? squadInput
        : await resolveSquad(db, { squadName: squadInput });
    if (!squad) return { ok: false, code: 'squad_not_found' };

    const access = await authorizeSquadAccess(db, {
        actorId: actor,
        squad,
        permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
        allowMemberRead: true,
    });
    if (!access.ok) {
        return {
            ok: false,
            code: 'forbidden',
            squadKey: squad.squad_key,
        };
    }

    const context = access.context || await getAccessContext(db, actor);
    const memberRole = leadershipRole(actor, squad);
    const elevated = Boolean(
        access.code === 'owner'
        || access.code === 'global_role'
        || context.owner
        || context.roleKeys.includes('admin')
    );
    const canCreateRaid = Boolean(
        context.owner
        || context.roleKeys.includes('admin')
        || context.roleKeys.includes('narrator')
    );
    const monthKey = raidMonthKey();
    const catalog = getRaidCategoryCatalog();
    const categories = catalog.filter((category) => (
        SQUAD_MONTHLY_CATEGORIES.includes(category.key)
    ));

    const [monthly, recentRows, starRows, participation, captain, vice] = await Promise.all([
        Promise.all(categories.map((category) => (
            readMonthlyCategory(db, squad.squad_key, category, monthKey)
        ))),
        db.all(
            `SELECT r.*,
                    COUNT(CASE WHEN p.status IN ('joined', 'active', 'completed') THEN 1 END) AS participant_count
             FROM clover_raids r
             LEFT JOIN clover_raid_participants p ON p.raid_id = r.id
             WHERE r.scope_squad_key = ?
             GROUP BY r.id
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT ?`,
            [squad.squad_key, Math.max(1, Math.min(20, Number(recentLimit) || 8))]
        ).catch(() => []),
        db.all(
            `SELECT l.*,
                    COALESCE(NULLIF(j.personagem_nome, '-'), NULLIF(j.display_name, '-'), NULLIF(j.nome, '-')) AS player_name
             FROM clover_squad_star_ledger l
             LEFT JOIN jogadores j ON j.id = l.player_id
             WHERE l.squad_key = ?
             ORDER BY l.created_at DESC, l.id DESC
             LIMIT ?`,
            [squad.squad_key, Math.max(1, Math.min(30, Number(starLimit) || 12))]
        ).catch(() => []),
        db.get(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN r.month_key = ? THEN 1 ELSE 0 END) AS this_month
             FROM clover_raid_participants p
             JOIN clover_raids r ON r.id = p.raid_id
             WHERE p.player_id = ?
               AND r.scope_squad_key = ?
               AND p.status IN ('joined', 'active', 'completed', 'withdrawn')`,
            [monthKey, actor, squad.squad_key]
        ).catch(() => null),
        playerIdentity(db, squad.captain_player_id),
        playerIdentity(db, squad.vice_captain_player_id),
    ]);

    return {
        ok: true,
        access: access.code,
        actor: {
            id: actor,
            role: elevated ? 'administrator' : memberRole,
            roleLabel: elevated ? 'Administração' : leadershipLabel(memberRole),
            isLeadership: ['captain', 'vice_captain'].includes(memberRole),
            canOrganize: elevated || ['captain', 'vice_captain'].includes(memberRole),
            canCreateRaid,
        },
        squad: {
            key: squad.squad_key,
            name: filled(squad.name) || squad.squad_key,
            phrase: filled(squad.phrase),
            stars: {
                current: safeNumber(squad.current_stars),
                historical: safeNumber(squad.historical_stars),
                black: safeNumber(squad.black_stars),
            },
            leadership: { captain, vice },
        },
        monthKey,
        monthly,
        recentRaids: recentRows.map(serializeRaid),
        starHistory: starRows.map(serializeStarEvent),
        participation: {
            total: safeNumber(participation?.total),
            completed: safeNumber(participation?.completed),
            thisMonth: safeNumber(participation?.this_month),
        },
    };
}

module.exports = {
    ACTIVE_MONTHLY_STATUSES,
    SQUAD_MONTHLY_CATEGORIES,
    getSquadOperations,
    leadershipLabel,
    leadershipRole,
    readMonthlyCategory,
    serializeRaid,
    serializeStarEvent,
};
