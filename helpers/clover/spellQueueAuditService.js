'use strict';

const { pseudonymizePlayerId } = require('./traitDescriptionAuditPrivacy');

const DEFAULT_THRESHOLDS = Object.freeze({
    waitingReviewDays: 30,
    waitingCriticalDays: 90,
    calledCriticalDays: 7,
});

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

function parseDatabaseDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
}

function ageInDays(value, now = new Date()) {
    const date = parseDatabaseDate(value);
    if (!date) return null;
    return Math.max(0, Math.floor((new Date(now).getTime() - date.getTime()) / 86400000));
}

function increment(map, playerId, amount = 1) {
    if (!playerId) return;
    map.set(playerId, Number(map.get(playerId) || 0) + Number(amount || 0));
}

function classifyEntry(row, context = {}, options = {}) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    const now = options.now || new Date();
    const active = ['waiting', 'called'].includes(row.status);
    const requestedAgeDays = ageInDays(row.requested_at, now);
    const calledAgeDays = ageInDays(row.called_at, now);
    const flags = [];

    if (!context.playerExists) flags.push('orphan_player');
    if (active && Number(context.activeCount || 0) > 1) flags.push('duplicate_active_entries');
    if (!row.requested_at) flags.push('missing_requested_at');
    if (row.status === 'called' && !row.called_at) flags.push('called_missing_called_at');
    if (row.status === 'waiting' && row.called_at) flags.push('waiting_has_called_at');
    if (active && row.closed_at) flags.push('active_has_closed_at');
    if (!active && !row.closed_at) flags.push('closed_status_missing_closed_at');

    if (row.status === 'waiting' && requestedAgeDays !== null) {
        if (requestedAgeDays >= thresholds.waitingCriticalDays) flags.push('waiting_stale_critical');
        else if (requestedAgeDays >= thresholds.waitingReviewDays) flags.push('waiting_stale_review');
    }
    if (row.status === 'called' && calledAgeDays !== null && calledAgeDays >= thresholds.calledCriticalDays) {
        flags.push('called_stale_critical');
    }

    const totalSlots = Number(context.totalSlots || 1);
    const occupiedSlots = Number(context.occupiedSlots || 0);
    const capacityDebt = Math.max(0, occupiedSlots - totalSlots);
    const availableSlots = Math.max(0, totalSlots - occupiedSlots);
    if (active && capacityDebt > 0) flags.push('legacy_over_capacity');
    else if (active && availableSlots === 0) flags.push('no_available_spell_slot');

    let severity = 'ok';
    if (flags.some((flag) => [
        'orphan_player',
        'duplicate_active_entries',
        'called_missing_called_at',
        'active_has_closed_at',
        'waiting_stale_critical',
        'called_stale_critical',
        'legacy_over_capacity',
    ].includes(flag))) severity = 'critical_review';
    else if (flags.length) severity = 'manual_review';

    let recommendedAction = 'keep';
    if (flags.includes('orphan_player')) recommendedAction = 'review_identity_before_any_change';
    else if (flags.includes('duplicate_active_entries')) recommendedAction = 'review_duplicate_entries';
    else if (flags.includes('called_missing_called_at') || flags.includes('called_stale_critical')) recommendedAction = 'review_called_entry';
    else if (flags.includes('legacy_over_capacity')) recommendedAction = 'preserve_entry_block_approval_until_capacity_regularized';
    else if (flags.includes('no_available_spell_slot')) recommendedAction = 'preserve_entry_block_approval_until_slot_available';
    else if (flags.includes('waiting_stale_critical')) recommendedAction = 'confirm_interest_before_requeue_or_cancel';
    else if (flags.includes('waiting_stale_review')) recommendedAction = 'review_age_without_automatic_cleanup';
    else if (flags.length) recommendedAction = 'manual_review';

    return {
        status: row.status,
        requestedAt: row.requested_at || null,
        calledAt: row.called_at || null,
        closedAt: row.closed_at || null,
        requestedAgeDays,
        calledAgeDays,
        active,
        severity,
        flags,
        recommendedAction,
        capacity: {
            baseSlots: 1,
            additionalSlots: Math.max(0, totalSlots - 1),
            totalSlots,
            occupiedSlots,
            availableSlots,
            capacityDebt,
            canApproveNewSpell: availableSlots > 0,
            queueCountsAsCapacity: false,
        },
    };
}

async function groupedCounts(db, tableName, sql) {
    if (!await tableExists(db, tableName)) return new Map();
    const rows = await db.all(sql);
    return new Map(rows.map((row) => [row.player_id, Number(row.total || 0)]));
}

async function auditSpellReviewQueue(db, options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    const queueExists = await tableExists(db, 'clover_spell_review_queue');
    if (!queueExists) {
        return {
            generatedAt: now.toISOString(),
            readOnly: true,
            available: false,
            reason: 'queue_table_missing',
            thresholds,
            summary: { totalRows: 0, activeRows: 0 },
            activeEntries: [],
            historicalAnomalies: [],
        };
    }

    const queueRows = await db.all(
        `SELECT id, player_id, status, requested_at, called_at, closed_at, closed_by, reason
         FROM clover_spell_review_queue
         ORDER BY requested_at ASC, id ASC`
    );

    const playerIds = [...new Set(queueRows.map((row) => row.player_id).filter(Boolean))];
    const players = new Map();
    if (playerIds.length && await tableExists(db, 'jogadores')) {
        const placeholders = playerIds.map(() => '?').join(', ');
        const rows = await db.all(
            `SELECT id, personagem_nome, nome, display_name
             FROM jogadores WHERE id IN (${placeholders})`,
            playerIds
        );
        rows.forEach((row) => players.set(row.id, {
            exists: true,
            characterName: row.personagem_nome || row.nome || row.display_name || null,
        }));
    }

    const directUses = await groupedCounts(
        db,
        'clover_consumable_uses',
        `SELECT player_id, COUNT(*) AS total
         FROM clover_consumable_uses
         WHERE template_key = 'ticket_feitico' AND result = 'used'
         GROUP BY player_id`
    );
    const legacyApproved = await groupedCounts(
        db,
        'clover_item_redemptions',
        `SELECT player_id, COUNT(*) AS total
         FROM clover_item_redemptions
         WHERE template_key = 'ticket_feitico' AND status = 'approved'
         GROUP BY player_id`
    );
    const approvedSpells = await groupedCounts(
        db,
        'clover_spellbook_spells',
        `SELECT player_id, COUNT(DISTINCT normalized_name) AS total
         FROM clover_spellbook_spells
         WHERE status = 'approved' AND removed_at IS NULL
         GROUP BY player_id`
    );

    const activeCounts = new Map();
    queueRows
        .filter((row) => ['waiting', 'called'].includes(row.status))
        .forEach((row) => increment(activeCounts, row.player_id));

    const decorated = queueRows.map((row) => {
        const direct = Number(directUses.get(row.player_id) || 0);
        const legacy = Number(legacyApproved.get(row.player_id) || 0);
        const totalSlots = 1 + direct + legacy;
        const occupiedSlots = Number(approvedSpells.get(row.player_id) || 0);
        const player = players.get(row.player_id) || { exists: false, characterName: null };
        const classified = classifyEntry(row, {
            playerExists: player.exists,
            activeCount: activeCounts.get(row.player_id) || 0,
            totalSlots,
            occupiedSlots,
        }, { now, thresholds });
        return {
            queueEntryKey: `Q-${String(row.id).padStart(6, '0')}`,
            playerKey: pseudonymizePlayerId(row.player_id),
            characterName: player.characterName,
            ...classified,
        };
    });

    const activeEntries = decorated.filter((entry) => entry.active);
    const historicalAnomalies = decorated.filter((entry) => !entry.active && entry.flags.length > 0);
    const duplicatePlayerKeys = [...activeCounts.entries()]
        .filter(([, total]) => total > 1)
        .map(([playerId, total]) => ({
            playerKey: pseudonymizePlayerId(playerId),
            characterName: players.get(playerId)?.characterName || null,
            activeEntries: total,
        }));

    const countFlag = (flag) => activeEntries.filter((entry) => entry.flags.includes(flag)).length;
    const uniqueActivePlayers = new Set(activeEntries.map((entry) => entry.playerKey));
    const waitingAges = activeEntries.filter((entry) => entry.status === 'waiting').map((entry) => entry.requestedAgeDays).filter(Number.isFinite);
    const calledAges = activeEntries.filter((entry) => entry.status === 'called').map((entry) => entry.calledAgeDays).filter(Number.isFinite);

    return {
        generatedAt: now.toISOString(),
        readOnly: true,
        available: true,
        privacy: {
            rawPlayerIdsIncluded: false,
            phoneNumbersIncluded: false,
            playerIds: 'sha256-prefix',
        },
        policy: {
            queueCreatesCapacity: false,
            queueReservesCapacity: false,
            automaticCleanup: false,
            staleEntriesRequireManualReview: true,
            entriesWithoutCapacityArePreservedButCannotBeApproved: true,
        },
        thresholds,
        summary: {
            totalRows: decorated.length,
            activeRows: activeEntries.length,
            activePlayers: uniqueActivePlayers.size,
            waitingRows: activeEntries.filter((entry) => entry.status === 'waiting').length,
            calledRows: activeEntries.filter((entry) => entry.status === 'called').length,
            duplicateActivePlayers: duplicatePlayerKeys.length,
            orphanActiveRows: countFlag('orphan_player'),
            waitingReviewRows: countFlag('waiting_stale_review'),
            waitingCriticalRows: countFlag('waiting_stale_critical'),
            calledCriticalRows: countFlag('called_stale_critical'),
            missingCalledAtRows: countFlag('called_missing_called_at'),
            activeClosedRows: countFlag('active_has_closed_at'),
            capacityBlockedRows: activeEntries.filter((entry) => !entry.capacity.canApproveNewSpell).length,
            legacyOverCapacityRows: countFlag('legacy_over_capacity'),
            fullCapacityRows: countFlag('no_available_spell_slot'),
            historicalAnomalies: historicalAnomalies.length,
            oldestWaitingDays: waitingAges.length ? Math.max(...waitingAges) : null,
            oldestCalledDays: calledAges.length ? Math.max(...calledAges) : null,
        },
        duplicateActivePlayers: duplicatePlayerKeys,
        activeEntries,
        historicalAnomalies,
    };
}

module.exports = {
    DEFAULT_THRESHOLDS,
    ageInDays,
    auditSpellReviewQueue,
    classifyEntry,
    parseDatabaseDate,
};
