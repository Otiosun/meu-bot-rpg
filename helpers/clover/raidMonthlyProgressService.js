'use strict';

const {
    configuredRaidMonthlyLimit,
    raidMonthKey,
    resolveRaidCategory,
} = require('./raidCategoryCatalog');

const PROGRESS_SCOPE_TYPES = new Set(['player', 'squad']);

class RaidMonthlyProgressError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'RaidMonthlyProgressError';
        this.code = code;
        this.details = details;
    }
}

function safeJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function categoryDefinitionForRaid(raid = {}) {
    const raw = raid.category_key || raid.categoryKey || raid.category || 'evento_especial';
    try {
        return resolveRaidCategory(raw);
    } catch {
        return null;
    }
}

function canonicalCategoryKey(value) {
    return resolveRaidCategory(value).key;
}

function progressScopeForRaid(raid = {}, definition = categoryDefinitionForRaid(raid)) {
    if (!definition?.countsMonthly) return null;
    if (definition.scopeType === 'player') {
        const scopeKey = String(raid.scope_player_id || raid.scope?.playerId || '').trim();
        return scopeKey ? { type: 'player', key: scopeKey } : null;
    }
    if (definition.scopeType === 'squad') {
        const scopeKey = String(raid.scope_squad_key || raid.scope?.squadKey || '').trim();
        return scopeKey ? { type: 'squad', key: scopeKey } : null;
    }
    return null;
}

async function ensureRaidMonthlyProgressSchema(db) {
    void db;
}

function validateScope(scopeType, scopeKey) {
    const normalizedType = String(scopeType || '').trim();
    const normalizedKey = String(scopeKey || '').trim();
    if (!PROGRESS_SCOPE_TYPES.has(normalizedType) || !normalizedKey) {
        throw new RaidMonthlyProgressError(
            'invalid_raid_progress_scope',
            'O escopo mensal da raid é inválido.',
            { scopeType: normalizedType, scopeKey: normalizedKey || null }
        );
    }
    return { type: normalizedType, key: normalizedKey };
}

async function readMonthlyProgress(db, input = {}) {
    await ensureRaidMonthlyProgressSchema(db);
    const definition = resolveRaidCategory(input.categoryKey || input.category || 'evento_especial');
    const monthKey = String(input.monthKey || raidMonthKey()).trim();
    const limit = configuredRaidMonthlyLimit(definition);

    if (!definition.countsMonthly || !limit) {
        return {
            categoryKey: definition.key,
            categoryLabel: definition.label,
            countsMonthly: false,
            monthKey,
            limit: null,
            completed: 0,
            reserved: 0,
            used: 0,
            remaining: null,
            exhausted: false,
        };
    }

    const scope = validateScope(input.scopeType || definition.scopeType, input.scopeKey);
    const completedRow = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM clover_raid_monthly_ledger
         WHERE category_key = ? AND month_key = ?
           AND scope_type = ? AND scope_key = ?`,
        [definition.key, monthKey, scope.type, scope.key]
    );
    const reservationParams = [definition.key, monthKey, scope.type, scope.key];
    let reservationSql = `SELECT COUNT(*) AS total
                          FROM clover_raid_monthly_reservations
                          WHERE category_key = ? AND month_key = ?
                            AND scope_type = ? AND scope_key = ?
                            AND status = 'active'`;
    if (input.excludeRaidId) {
        reservationSql += ' AND raid_id <> ?';
        reservationParams.push(Number(input.excludeRaidId));
    }
    const reservedRow = await db.get(reservationSql, reservationParams);
    const completed = Math.max(0, Number(completedRow?.total || 0));
    const reserved = Math.max(0, Number(reservedRow?.total || 0));
    const used = completed + reserved;

    return {
        categoryKey: definition.key,
        categoryLabel: definition.label,
        countsMonthly: true,
        monthKey,
        limit,
        completed,
        reserved,
        used,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
    };
}

function limitReached(definition, scope, usage) {
    return new RaidMonthlyProgressError(
        'raid_monthly_limit_reached',
        `${definition.label}: o limite mensal já foi atingido.`,
        {
            category: definition.key,
            scope: { type: scope.type, key: scope.key },
            usage,
        }
    );
}

async function reserveMonthlyScopeInTransaction(db, input = {}) {
    const definition = resolveRaidCategory(input.categoryKey || input.category);
    if (!definition.countsMonthly) {
        return { reserved: false, creditEligible: false, reason: 'unlimited_category' };
    }
    const scope = validateScope(input.scopeType || definition.scopeType, input.scopeKey);
    const raidId = Number(input.raidId);
    if (!Number.isInteger(raidId) || raidId <= 0) {
        throw new RaidMonthlyProgressError('invalid_raid_id', 'A raid não possui identificador válido.');
    }
    const monthKey = String(input.monthKey || raidMonthKey()).trim();
    const existing = await db.get(
        `SELECT * FROM clover_raid_monthly_reservations
         WHERE raid_id = ? AND category_key = ? AND month_key = ?
           AND scope_type = ? AND scope_key = ?`,
        [raidId, definition.key, monthKey, scope.type, scope.key]
    );

    if (existing?.status === 'active') {
        if (input.participantId && Number(existing.participant_id || 0) !== Number(input.participantId)) {
            await db.run(
                `UPDATE clover_raid_monthly_reservations
                 SET participant_id = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [Number(input.participantId), existing.id]
            );
        }
        return { reserved: true, creditEligible: true, duplicate: true, reservationId: existing.id };
    }
    if (existing?.status === 'consumed') {
        return { reserved: false, creditEligible: false, duplicate: true, reason: 'already_consumed' };
    }

    const usage = await readMonthlyProgress(db, {
        categoryKey: definition.key,
        monthKey,
        scopeType: scope.type,
        scopeKey: scope.key,
        excludeRaidId: raidId,
    });

    if (usage.completed >= usage.limit && input.allowWithoutCredit === true) {
        return { reserved: false, creditEligible: false, reason: 'already_completed', usage };
    }
    if (usage.exhausted) throw limitReached(definition, scope, usage);

    if (existing) {
        await db.run(
            `UPDATE clover_raid_monthly_reservations
             SET status = 'active', participant_id = ?, created_by = ?,
                 updated_at = CURRENT_TIMESTAMP, released_at = NULL,
                 consumed_at = NULL, release_reason = NULL, metadata_json = ?
             WHERE id = ?`,
            [
                input.participantId ? Number(input.participantId) : null,
                input.actorId || null,
                JSON.stringify(input.metadata || {}),
                existing.id,
            ]
        );
        return { reserved: true, creditEligible: true, duplicate: false, reservationId: existing.id };
    }

    const inserted = await db.run(
        `INSERT INTO clover_raid_monthly_reservations
         (raid_id, category_key, month_key, scope_type, scope_key, participant_id,
          status, created_by, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [
            raidId,
            definition.key,
            monthKey,
            scope.type,
            scope.key,
            input.participantId ? Number(input.participantId) : null,
            input.actorId || null,
            JSON.stringify(input.metadata || {}),
        ]
    );
    return { reserved: true, creditEligible: true, duplicate: false, reservationId: inserted.lastID };
}

async function reserveRaidScopeInTransaction(db, raid, actorId) {
    const definition = categoryDefinitionForRaid(raid);
    const scope = progressScopeForRaid(raid, definition);
    if (!definition?.countsMonthly || !scope) {
        return { reserved: false, creditEligible: false, reason: 'not_applicable' };
    }
    return reserveMonthlyScopeInTransaction(db, {
        raidId: raid.id,
        categoryKey: definition.key,
        monthKey: raid.month_key || raidMonthKey(raid.created_at),
        scopeType: scope.type,
        scopeKey: scope.key,
        actorId,
        allowWithoutCredit: false,
        metadata: { source: 'raid_created', raid_key: raid.raid_key },
    });
}

async function reserveParticipantInTransaction(db, raid, participant, actorId) {
    const definition = categoryDefinitionForRaid(raid);
    if (!definition?.countsMonthly || definition.scopeType !== 'player') {
        return { reserved: false, creditEligible: false, reason: 'not_player_scoped' };
    }
    return reserveMonthlyScopeInTransaction(db, {
        raidId: raid.id,
        categoryKey: definition.key,
        monthKey: raid.month_key || raidMonthKey(raid.created_at),
        scopeType: 'player',
        scopeKey: participant.player_id,
        participantId: participant.id,
        actorId,
        allowWithoutCredit: true,
        metadata: { source: 'participant_joined', raid_key: raid.raid_key },
    });
}

async function releaseParticipantProgressInTransaction(db, raid, playerId, actorId, reason) {
    const definition = categoryDefinitionForRaid(raid);
    if (!definition?.countsMonthly || definition.scopeType !== 'player') return { released: 0 };
    const result = await db.run(
        `UPDATE clover_raid_monthly_reservations
         SET status = 'released', released_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP, release_reason = ?,
             metadata_json = ?
         WHERE raid_id = ? AND category_key = ? AND month_key = ?
           AND scope_type = 'player' AND scope_key = ? AND status = 'active'`,
        [
            String(reason || 'participant_removed'),
            JSON.stringify({ released_by: actorId || null }),
            raid.id,
            definition.key,
            raid.month_key || raidMonthKey(raid.created_at),
            String(playerId),
        ]
    );
    return { released: Number(result.changes || 0) };
}

async function releaseRaidProgressInTransaction(db, raid, actorId, reason) {
    const result = await db.run(
        `UPDATE clover_raid_monthly_reservations
         SET status = 'released', released_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP, release_reason = ?,
             metadata_json = ?
         WHERE raid_id = ? AND status = 'active'`,
        [
            String(reason || 'raid_cancelled'),
            JSON.stringify({ released_by: actorId || null }),
            raid.id,
        ]
    );
    return { released: Number(result.changes || 0) };
}

async function insertCompletionInTransaction(db, input = {}) {
    const entryKey = String(input.entryKey || '').trim();
    if (!entryKey) throw new RaidMonthlyProgressError('missing_progress_entry_key', 'A conclusão não possui chave idempotente.');
    const existing = await db.get(
        'SELECT * FROM clover_raid_monthly_ledger WHERE entry_key = ?',
        [entryKey]
    );
    if (existing) return { inserted: false, entry: existing };
    const inserted = await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (entry_key, raid_id, category_key, month_key, scope_type, scope_key,
          participant_id, amount, kind, reason, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'completion', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            entryKey,
            Number(input.raidId),
            input.categoryKey,
            input.monthKey,
            input.scopeType,
            input.scopeKey,
            input.participantId ? Number(input.participantId) : null,
            input.reason || null,
            input.actorId || null,
            JSON.stringify(input.metadata || {}),
        ]
    );
    const entry = await db.get('SELECT * FROM clover_raid_monthly_ledger WHERE id = ?', [inserted.lastID]);
    return { inserted: true, entry };
}

async function completeRaidProgressInTransaction(db, raid, participants = [], actorId) {
    const definition = categoryDefinitionForRaid(raid);
    if (!definition?.countsMonthly) {
        return { completed: 0, skipped: participants.length, reason: 'unlimited_category' };
    }
    const monthKey = raid.month_key || raidMonthKey(raid.created_at);
    let completed = 0;

    if (definition.scopeType === 'player') {
        const activePlayers = new Set(participants.map((participant) => String(participant.player_id)));
        for (const participant of participants) {
            const reservation = await db.get(
                `SELECT * FROM clover_raid_monthly_reservations
                 WHERE raid_id = ? AND category_key = ? AND month_key = ?
                   AND scope_type = 'player' AND scope_key = ? AND status = 'active'`,
                [raid.id, definition.key, monthKey, participant.player_id]
            );
            if (!reservation) continue;
            const result = await insertCompletionInTransaction(db, {
                entryKey: `raid-completion:${raid.id}:${definition.key}:player:${participant.player_id}`,
                raidId: raid.id,
                categoryKey: definition.key,
                monthKey,
                scopeType: 'player',
                scopeKey: participant.player_id,
                participantId: participant.id,
                actorId,
                reason: `Conclusão da raid ${raid.name}`,
                metadata: { raid_key: raid.raid_key, participant_status: participant.status },
            });
            if (result.inserted) completed += 1;
            await db.run(
                `UPDATE clover_raid_monthly_reservations
                 SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP, participant_id = ?
                 WHERE id = ? AND status = 'active'`,
                [participant.id, reservation.id]
            );
        }
        const remaining = await db.all(
            `SELECT * FROM clover_raid_monthly_reservations
             WHERE raid_id = ? AND category_key = ? AND month_key = ?
               AND scope_type = 'player' AND status = 'active'`,
            [raid.id, definition.key, monthKey]
        );
        for (const reservation of remaining) {
            if (activePlayers.has(String(reservation.scope_key))) continue;
            await db.run(
                `UPDATE clover_raid_monthly_reservations
                 SET status = 'released', released_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP,
                     release_reason = 'participant_not_active_at_completion'
                 WHERE id = ? AND status = 'active'`,
                [reservation.id]
            );
        }
        return { completed, skipped: participants.length - completed };
    }

    const scope = progressScopeForRaid(raid, definition);
    if (!scope) return { completed: 0, skipped: 1, reason: 'missing_squad_scope' };
    const reservation = await db.get(
        `SELECT * FROM clover_raid_monthly_reservations
         WHERE raid_id = ? AND category_key = ? AND month_key = ?
           AND scope_type = 'squad' AND scope_key = ? AND status = 'active'`,
        [raid.id, definition.key, monthKey, scope.key]
    );
    if (!reservation) return { completed: 0, skipped: 1, reason: 'reservation_not_found' };
    const result = await insertCompletionInTransaction(db, {
        entryKey: `raid-completion:${raid.id}:${definition.key}:squad:${scope.key}`,
        raidId: raid.id,
        categoryKey: definition.key,
        monthKey,
        scopeType: 'squad',
        scopeKey: scope.key,
        actorId,
        reason: `Conclusão da raid ${raid.name}`,
        metadata: { raid_key: raid.raid_key, participants: participants.length },
    });
    if (result.inserted) completed = 1;
    await db.run(
        `UPDATE clover_raid_monthly_reservations
         SET status = 'consumed', consumed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'active'`,
        [reservation.id]
    );
    return { completed, skipped: result.inserted ? 0 : 1 };
}

async function readPlayerRaidChecklist(db, playerId, options = {}) {
    await ensureRaidMonthlyProgressSchema(db);
    const player = await db.get(
        'SELECT id, esquadrao FROM jogadores WHERE id = ?',
        [String(playerId)]
    );
    if (!player) {
        throw new RaidMonthlyProgressError('player_not_found', 'Jogador não encontrado.');
    }
    const monthKey = String(options.monthKey || raidMonthKey()).trim();
    const saga = await readMonthlyProgress(db, {
        categoryKey: 'saga_pessoal',
        monthKey,
        scopeType: 'player',
        scopeKey: player.id,
    });
    const squadName = String(player.esquadrao || '').trim();
    let mission = null;
    let training = null;
    let squadKey = null;
    if (squadName && squadName !== '-') {
        const squad = await db.get(
            `SELECT squad_key, name FROM clover_squads
             WHERE LOWER(name) = LOWER(?) OR squad_key = ? LIMIT 1`,
            [squadName, squadName]
        );
        if (squad) {
            squadKey = squad.squad_key;
            mission = await readMonthlyProgress(db, {
                categoryKey: 'missao_esquadrao',
                monthKey,
                scopeType: 'squad',
                scopeKey: squadKey,
            });
            training = await readMonthlyProgress(db, {
                categoryKey: 'treino_esquadrao',
                monthKey,
                scopeType: 'squad',
                scopeKey: squadKey,
            });
        }
    }
    return {
        monthKey,
        playerId: player.id,
        squadKey,
        saga,
        squadMission: mission,
        squadTraining: training,
        eventSpecial: {
            categoryKey: 'evento_especial',
            categoryLabel: 'Evento especial',
            countsMonthly: false,
            limit: null,
        },
    };
}

function serializeReservation(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        raidId: Number(row.raid_id),
        categoryKey: row.category_key,
        monthKey: row.month_key,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        participantId: row.participant_id === null ? null : Number(row.participant_id),
        status: row.status,
        releaseReason: row.release_reason || null,
        metadata: safeJson(row.metadata_json, {}),
    };
}

module.exports = {
    RaidMonthlyProgressError,
    canonicalCategoryKey,
    categoryDefinitionForRaid,
    completeRaidProgressInTransaction,
    ensureRaidMonthlyProgressSchema,
    progressScopeForRaid,
    readMonthlyProgress,
    readPlayerRaidChecklist,
    releaseParticipantProgressInTransaction,
    releaseRaidProgressInTransaction,
    reserveMonthlyScopeInTransaction,
    reserveParticipantInTransaction,
    reserveRaidScopeInTransaction,
    serializeReservation,
};