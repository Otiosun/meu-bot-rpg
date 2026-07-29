'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { isSameUser, normalizeJid } = require('../groupAccess');
const { getAccessContext } = require('./accessControlService');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
    roleGrantsIntegratedPermission,
} = require('./accessIntegrationService');
const { readCaptainProfile } = require('./captainPersonaService');
const { normalizeSquadKey } = require('./cavalierService');
const {
    CATEGORY_DEFINITIONS,
    raidMonthKey,
} = require('./raidCategoryCatalog');
const { readMonthlyProgress } = require('./raidMonthlyProgressService');
const { ensureRaidV2Schema } = require('./raidV2Schema');
const { getIntegratedSquadState } = require('./squadStateIntegrationService');
const { resolveSquad } = require('./squadStateService');
const { readSquadNativeStars } = require('./squadSeasonStarService');
const { serializeSquadState } = require('./siteAccessPayloadService');

const ACTIVE_MONTHLY_STATUSES = Object.freeze([
    'lobby', 'in_progress', 'finalization', 'completed',
]);

function safeInteger(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.trunc(number));
}

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function displayName(player = {}, fallback = null) {
    return filled(player.personagem_nome)
        || filled(player.display_name)
        || filled(player.nome)
        || filled(fallback)
        || 'Não registrado';
}

function assignmentMatchesSquad(assignment, squadKey) {
    return assignment?.scope_type === 'global'
        || assignment?.scope_key === squadKey;
}

function contextCanForSquad(context, permission, squadKey) {
    if (context?.owner || context?.permissions?.includes('*')) return true;
    return (context?.assignments || []).some((assignment) => (
        assignmentMatchesSquad(assignment, squadKey)
        && roleGrantsIntegratedPermission(assignment.role_key, permission)
    ));
}

function assignedLeadershipRole(context, squadKey) {
    const assignment = (context?.assignments || []).find((item) => (
        assignmentMatchesSquad(item, squadKey)
        && ['captain', 'vice_captain'].includes(item.role_key)
    ));
    return assignment?.role_key || null;
}

function actorRole({ actorId, squad, context }) {
    if (context?.owner || context?.permissions?.includes('*')) {
        return {
            key: 'administrator',
            label: 'Administração do Reino',
            isLeadership: true,
        };
    }

    if (isSameUser(actorId, squad.captain_player_id)) {
        return { key: 'captain', label: 'Capitão', isLeadership: true };
    }
    if (isSameUser(actorId, squad.vice_captain_player_id)) {
        return { key: 'vice_captain', label: 'Vice-Capitão', isLeadership: true };
    }

    const assigned = assignedLeadershipRole(context, squad.squad_key);
    if (assigned === 'captain') return { key: 'captain', label: 'Capitão', isLeadership: true };
    if (assigned === 'vice_captain') return { key: 'vice_captain', label: 'Vice-Capitão', isLeadership: true };
    return { key: 'member', label: 'Membro', isLeadership: false };
}

async function readLeader(db, playerId, fallbackName = null, options = {}) {
    if (options.squadKey) {
        const profile = await readCaptainProfile(db, {
            accountPlayerId: playerId,
            squadKey: options.squadKey,
        }).catch(() => null);
        if (profile) {
            return {
                name: profile.characterName,
                rank: profile.rank || 'Capitão',
                magic: profile.magic,
                grimoire: profile.grimoire,
                image: profile.image,
            };
        }
    }

    const normalized = normalizeJid(playerId);
    if (!normalized) {
        const name = filled(fallbackName);
        return name ? { name, rank: null, magic: null, grimoire: null, image: null } : null;
    }
    const player = await db.get(
        `SELECT personagem_nome, display_name, nome, patente, magia, grimorio,
                site_profile_image_data
         FROM jogadores WHERE id = ?`,
        [normalized]
    ).catch(() => null);
    if (!player && !filled(fallbackName)) return null;
    return {
        name: displayName(player || {}, fallbackName),
        rank: filled(player?.patente),
        magic: filled(player?.magia),
        grimoire: filled(player?.grimorio),
        image: filled(player?.site_profile_image_data),
    };
}

function statusBreakdown(row = {}) {
    return {
        lobby: safeInteger(row.lobby),
        inProgress: safeInteger(row.in_progress),
        finalization: safeInteger(row.finalization),
        completed: safeInteger(row.completed),
        cancelled: safeInteger(row.cancelled),
    };
}

async function readMonthlyCategory(db, definition, squadKey, monthKey) {
    const [progress, statusRow] = await Promise.all([
        readMonthlyProgress(db, {
            categoryKey: definition.key,
            monthKey,
            scopeType: 'squad',
            scopeKey: squadKey,
        }),
        db.get(
            `SELECT
                COALESCE(SUM(CASE WHEN status = 'lobby' THEN 1 ELSE 0 END), 0) AS lobby,
                COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
                COALESCE(SUM(CASE WHEN status = 'finalization' THEN 1 ELSE 0 END), 0) AS finalization,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
             FROM clover_raids
             WHERE category_key = ?
               AND scope_squad_key = ?
               AND month_key = ?`,
            [definition.key, squadKey, monthKey]
        ).catch(() => ({})),
    ]);

    return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        monthKey,
        countsMonthly: progress.countsMonthly,
        limit: progress.limit,
        completed: progress.completed,
        reserved: progress.reserved,
        used: progress.used,
        remaining: progress.remaining,
        exhausted: progress.exhausted,
        breakdown: statusBreakdown(statusRow),
    };
}

async function readMonthlyUsage(db, squadKey, monthKey) {
    const categories = CATEGORY_DEFINITIONS.filter((definition) => (
        definition.scopeType === 'squad' && definition.countsMonthly
    ));
    return Promise.all(categories.map((definition) => (
        readMonthlyCategory(db, definition, squadKey, monthKey)
    )));
}

function serializeRaid(row = {}) {
    return {
        key: row.raid_key,
        name: row.name,
        category: row.category_key || row.category,
        categoryLabel: row.category_label || null,
        status: row.status,
        maxPlayers: safeInteger(row.max_players),
        participantCount: safeInteger(row.participant_count),
        createdAt: row.created_at || null,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        cancellationReason: row.cancellation_reason || null,
    };
}

async function readRecentRaids(db, squadKey) {
    const rows = await db.all(
        `SELECT r.*,
                (SELECT COUNT(*)
                 FROM clover_raid_participants p
                 WHERE p.raid_id = r.id
                   AND p.status IN ('joined', 'active', 'completed')) AS participant_count
         FROM clover_raids r
         WHERE r.scope_squad_key = ?
         ORDER BY datetime(r.created_at) DESC, r.id DESC
         LIMIT 8`,
        [squadKey]
    ).catch(() => []);
    return rows.map(serializeRaid);
}

function serializeStarEvent(row = {}) {
    return {
        id: safeInteger(row.id),
        amount: Number(row.amount || 0),
        kind: filled(row.kind),
        source: filled(row.source),
        reason: filled(row.reason),
        playerName: row.player_id ? displayName(row, 'Membro') : null,
        createdAt: row.created_at || null,
    };
}

async function readStarHistory(db, squadKey) {
    const rows = await db.all(
        `SELECT ledger.id, ledger.amount, ledger.kind, ledger.source, ledger.reason,
                ledger.player_id, ledger.created_at,
                player.personagem_nome, player.display_name, player.nome
         FROM clover_squad_star_ledger ledger
         LEFT JOIN jogadores player ON player.id = ledger.player_id
         WHERE ledger.squad_key = ?
         ORDER BY datetime(ledger.created_at) DESC, ledger.id DESC
         LIMIT 12`,
        [squadKey]
    ).catch(() => []);
    return rows.map(serializeStarEvent);
}

async function squadMemberIds(db, squadKey) {
    const rows = await db.all('SELECT id, esquadrao FROM jogadores').catch(() => []);
    return rows
        .filter((player) => normalizeSquadKey(player.esquadrao) === squadKey)
        .map((player) => player.id);
}

async function readParticipation(db, squadKey, monthKey) {
    const ids = await squadMemberIds(db, squadKey);
    if (!ids.length) {
        return { total: 0, completed: 0, thisMonth: 0, active: 0 };
    }
    const placeholders = ids.map(() => '?').join(', ');
    const row = await db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN status IN ('joined', 'active') THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN substr(joined_at, 1, 7) = ? THEN 1 ELSE 0 END), 0) AS this_month
         FROM clover_raid_participants
         WHERE player_id IN (${placeholders})`,
        [monthKey, ...ids]
    ).catch(() => ({}));
    return {
        total: safeInteger(row.total),
        completed: safeInteger(row.completed),
        thisMonth: safeInteger(row.this_month),
        active: safeInteger(row.active),
    };
}

async function getSquadOperations(db, {
    actorId,
    squadInput,
    referenceDate = new Date(),
} = {}) {
    await ensureCloverSquadSchema(db);
    await ensureRaidV2Schema(db);

    const squad = typeof squadInput === 'object' && squadInput?.squad_key
        ? squadInput
        : await resolveSquad(db, { squadName: squadInput });
    if (!squad) return { ok: false, code: 'squad_not_found' };

    const access = await authorizeSquadAccess(db, {
        actorId,
        squad,
        permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
        allowMemberRead: true,
    });
    if (!access.ok) {
        return { ok: false, code: 'forbidden', squadKey: squad.squad_key };
    }

    const context = access.context || await getAccessContext(db, actorId);
    const role = actorRole({ actorId, squad, context });
    const monthKey = raidMonthKey(referenceDate);
    const [state, captain, vice, monthly, recentRaids, starHistory, participation, nativeStars] = await Promise.all([
        getIntegratedSquadState(db, squad),
        readLeader(db, squad.captain_player_id, squad.captain_name, { squadKey: squad.squad_key }),
        readLeader(db, squad.vice_captain_player_id),
        readMonthlyUsage(db, squad.squad_key, monthKey),
        readRecentRaids(db, squad.squad_key),
        readStarHistory(db, squad.squad_key),
        readParticipation(db, squad.squad_key, monthKey),
        readSquadNativeStars(db, squad.squad_key),
    ]);

    const canManageUpgrades = contextCanForSquad(
        context,
        ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
        squad.squad_key
    ) || role.key === 'captain' || role.key === 'vice_captain';
    const canCreateRaid = contextCanForSquad(
        context,
        ACCESS_PERMISSIONS.RAID_CREATE,
        squad.squad_key
    );
    const canManageMembers = contextCanForSquad(
        context,
        ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE,
        squad.squad_key
    );

    return {
        ok: true,
        access: access.code,
        actor: {
            role: role.key,
            roleLabel: role.label,
            isLeadership: role.isLeadership,
            canOrganize: Boolean(role.isLeadership || canCreateRaid || canManageUpgrades || canManageMembers),
            canCreateRaid,
            canManageUpgrades,
            canManageMembers,
        },
        squad: {
            key: squad.squad_key,
            name: filled(squad.name) || squad.squad_key,
            phrase: filled(squad.phrase),
            stars: {
                current: safeInteger(squad.current_stars),
                historical: safeInteger(squad.historical_stars),
                black: safeInteger(squad.black_stars),
                balance: nativeStars?.balance ?? safeInteger(squad.current_stars),
                season: nativeStars?.season ?? 0,
                lifetime: nativeStars?.lifetime ?? safeInteger(squad.historical_stars),
                seasonId: nativeStars?.seasonId || null,
                seasonName: nativeStars?.seasonName || null,
            },
            leadership: { captain, vice },
        },
        state: serializeSquadState(state),
        monthKey,
        monthly,
        recentRaids,
        starHistory,
        participation,
    };
}

module.exports = {
    ACTIVE_MONTHLY_STATUSES,
    actorRole,
    contextCanForSquad,
    getSquadOperations,
    readLeader,
    readMonthlyCategory,
    readMonthlyUsage,
    readParticipation,
    readRecentRaids,
    readStarHistory,
    serializeRaid,
    serializeStarEvent,
};
