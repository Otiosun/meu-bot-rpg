'use strict';

const { normalizeSquadKey } = require('./cavalierService');
const {
    configuredRaidMonthlyLimit,
    resolveRaidCategory,
} = require('./raidCategoryCatalog');
const {
    ensureRaidMonthlyProgressSchema,
    readMonthlyProgress,
} = require('./raidMonthlyProgressService');

class AdminRaidProgressError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminRaidProgressError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function requireText(value, field) {
    const text = String(value || '').trim();
    if (!text) {
        throw new AdminRaidProgressError('missing_raid_progress_field', `${field} é obrigatório.`, 400, { field });
    }
    return text;
}

function normalizeMonthKey(value) {
    const monthKey = requireText(value, 'monthKey');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
        throw new AdminRaidProgressError('invalid_month_key', 'Mês inválido. Use YYYY-MM.', 400, { monthKey });
    }
    return monthKey;
}

function normalizeAdjustment(value) {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10) {
        throw new AdminRaidProgressError(
            'invalid_raid_progress_amount',
            'O ajuste precisa ser um inteiro entre -10 e 10, diferente de zero.',
            400,
            { amount: value }
        );
    }
    return amount;
}

async function resolveProgressScope(db, action, target) {
    const payload = action.payload || {};
    const definition = resolveRaidCategory(payload.categoryKey || payload.category);
    if (!definition.countsMonthly) {
        throw new AdminRaidProgressError(
            'unlimited_raid_category',
            'Evento especial não possui contador mensal para ajuste.',
            409,
            { categoryKey: definition.key }
        );
    }
    const monthKey = normalizeMonthKey(payload.monthKey || payload.month_key);
    const requestedScopeType = String(payload.scopeType || payload.scope_type || definition.scopeType).trim().toLowerCase();
    if (requestedScopeType !== definition.scopeType) {
        throw new AdminRaidProgressError(
            'raid_progress_scope_mismatch',
            'A categoria não pertence ao escopo informado.',
            409,
            { categoryKey: definition.key, expected: definition.scopeType, received: requestedScopeType }
        );
    }

    if (definition.scopeType === 'player') {
        const scopeKey = String(payload.scopeKey || payload.scope_key || target.playerId || '').trim();
        if (!scopeKey || scopeKey !== String(target.playerId || '').trim()) {
            throw new AdminRaidProgressError(
                'raid_progress_player_mismatch',
                'O jogador alvo não corresponde ao contador individual informado.',
                409,
                { scopeKey: scopeKey || null }
            );
        }
        return {
            definition,
            monthKey,
            scopeType: 'player',
            scopeKey,
            scopeLabel: target.characterName || 'Jogador',
        };
    }

    const requestedSquad = requireText(payload.scopeKey || payload.scope_key || payload.squadKey, 'scopeKey');
    const squadKey = normalizeSquadKey(requestedSquad);
    const player = await db.get(
        'SELECT id, personagem_nome, esquadrao FROM jogadores WHERE id = ?',
        [target.playerId]
    );
    if (!player) {
        throw new AdminRaidProgressError('player_not_found', 'Jogador âncora não encontrado.', 404);
    }
    if (normalizeSquadKey(player.esquadrao) !== squadKey) {
        throw new AdminRaidProgressError(
            'raid_progress_squad_anchor_mismatch',
            'O jogador âncora não pertence ao esquadrão informado.',
            409,
            { squadKey, playerSquad: normalizeSquadKey(player.esquadrao) || null }
        );
    }
    const squad = await db.get(
        'SELECT squad_key, name FROM clover_squads WHERE squad_key = ? LIMIT 1',
        [squadKey]
    );
    if (!squad) {
        throw new AdminRaidProgressError('squad_not_found', 'Esquadrão não encontrado.', 404, { squadKey });
    }
    return {
        definition,
        monthKey,
        scopeType: 'squad',
        scopeKey: squad.squad_key,
        scopeLabel: squad.name,
    };
}

async function progressSnapshot(db, scope) {
    return readMonthlyProgress(db, {
        categoryKey: scope.definition.key,
        monthKey: scope.monthKey,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
    });
}

function assertAdjustmentAllowed(operation, action, before, amount) {
    const completed = before.completed + amount;
    if (completed < 0) {
        throw new AdminRaidProgressError(
            'raid_progress_negative',
            'O ajuste deixaria a conclusão mensal abaixo de zero.',
            409,
            { before: before.completed, amount }
        );
    }
    const used = completed + before.reserved;
    const override = action.payload?.overrideLimit === true || action.payload?.override_limit === true;
    const ownerOverride = operation.actor?.role === 'owner' && override;
    if (before.limit !== null && used > before.limit && !ownerOverride) {
        throw new AdminRaidProgressError(
            'raid_progress_limit_exceeded',
            'O ajuste ultrapassaria o limite mensal. Libere reservas conflitantes ou use override de Owner.',
            409,
            {
                completed,
                reserved: before.reserved,
                limit: before.limit,
                ownerOverrideRequired: true,
            }
        );
    }
    return { completed, used, ownerOverride };
}

async function insertAdjustment(db, input) {
    const existing = await db.get(
        'SELECT * FROM clover_raid_monthly_ledger WHERE entry_key = ?',
        [input.entryKey]
    );
    if (existing) return { inserted: false, row: existing };
    const result = await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (entry_key, raid_id, category_key, month_key, scope_type, scope_key,
          participant_id, amount, kind, reason, operation_code, reversed_entry_id,
          created_by, created_at, metadata_json)
         VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            input.entryKey,
            input.categoryKey,
            input.monthKey,
            input.scopeType,
            input.scopeKey,
            input.amount,
            input.kind,
            input.reason,
            input.operationCode,
            input.reversedEntryId || null,
            input.actorId,
            JSON.stringify(input.metadata || {}),
        ]
    );
    return {
        inserted: true,
        row: await db.get('SELECT * FROM clover_raid_monthly_ledger WHERE id = ?', [result.lastID]),
    };
}

function mapReservation(row) {
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
        metadata: parseJson(row.metadata_json, {}),
    };
}

async function reservationById(db, reservationId) {
    await ensureRaidMonthlyProgressSchema(db);
    const id = Number(reservationId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new AdminRaidProgressError('invalid_raid_reservation', 'Reserva mensal inválida.', 400);
    }
    const row = await db.get(
        'SELECT * FROM clover_raid_monthly_reservations WHERE id = ?',
        [id]
    );
    if (!row) {
        throw new AdminRaidProgressError('raid_reservation_not_found', 'Reserva mensal não encontrada.', 404, { reservationId: id });
    }
    return row;
}

async function assertReservationAnchor(db, reservation, target) {
    if (reservation.scope_type === 'player') {
        if (String(target.playerId) !== String(reservation.scope_key)) {
            throw new AdminRaidProgressError(
                'raid_reservation_player_mismatch',
                'O jogador alvo não corresponde à reserva mensal.',
                409
            );
        }
        return;
    }
    const player = await db.get('SELECT esquadrao FROM jogadores WHERE id = ?', [target.playerId]);
    if (!player || normalizeSquadKey(player.esquado || player.esquadrao) !== reservation.scope_key) {
        throw new AdminRaidProgressError(
            'raid_reservation_squad_mismatch',
            'O jogador âncora não pertence ao esquadrão da reserva.',
            409
        );
    }
}

function createRaidProgressExecutors() {
    return {
        'raid.progress.adjust': {
            async preview({ db, operation, action, target }) {
                await ensureRaidMonthlyProgressSchema(db);
                const scope = await resolveProgressScope(db, action, target);
                const amount = normalizeAdjustment(action.payload?.amount);
                const before = await progressSnapshot(db, scope);
                const allowed = assertAdjustmentAllowed(operation, action, before, amount);
                const after = {
                    ...before,
                    completed: allowed.completed,
                    used: allowed.used,
                    remaining: before.limit === null ? null : Math.max(0, before.limit - allowed.used),
                    exhausted: before.limit !== null && allowed.used >= before.limit,
                };
                return {
                    summary: `${scope.scopeLabel}: ajustar ${scope.definition.label} em ${amount > 0 ? '+' : ''}${amount}`,
                    before,
                    after,
                    metadata: {
                        scope: {
                            categoryKey: scope.definition.key,
                            monthKey: scope.monthKey,
                            scopeType: scope.scopeType,
                            scopeKey: scope.scopeKey,
                        },
                        amount,
                        ownerOverride: allowed.ownerOverride,
                    },
                };
            },
            async apply({ db, operation, unit, before, after }) {
                const scope = unit.metadata?.scope;
                const amount = Number(unit.metadata?.amount);
                if (!scope || !Number.isInteger(amount)) {
                    throw new AdminRaidProgressError('missing_raid_progress_snapshot', 'Snapshot do ajuste mensal está incompleto.', 409);
                }
                const current = await readMonthlyProgress(db, scope);
                if (current.completed !== before.completed || current.reserved !== before.reserved) {
                    throw new AdminRaidProgressError(
                        'raid_progress_changed_since_preview',
                        'O progresso mensal mudou depois da simulação. Simule uma nova operação.',
                        409,
                        { expected: before, current }
                    );
                }
                const entryKey = `admin-adjust:${operation.code}:${unit.id}`;
                const inserted = await insertAdjustment(db, {
                    entryKey,
                    categoryKey: scope.categoryKey,
                    monthKey: scope.monthKey,
                    scopeType: scope.scopeType,
                    scopeKey: scope.scopeKey,
                    amount,
                    kind: 'adjustment',
                    reason: operation.reason,
                    operationCode: operation.code,
                    actorId: operation.actor.id,
                    metadata: {
                        unit_id: unit.id,
                        owner_override: unit.metadata?.ownerOverride === true,
                        target: unit.metadata?.target || null,
                    },
                });
                const actualAfter = await readMonthlyProgress(db, scope);
                return {
                    before,
                    after: { ...actualAfter, entryId: Number(inserted.row.id), entryKey },
                    summary: `Progresso mensal ajustado por ${amount > 0 ? '+' : ''}${amount}.`,
                    metadata: { entryId: Number(inserted.row.id), entryKey },
                };
            },
            async undo({ db, operation, unit, before, after }) {
                const scope = unit.metadata?.scope;
                const amount = Number(unit.metadata?.amount);
                const entryId = Number(after?.entryId || unit.metadata?.entryId);
                if (!scope || !Number.isInteger(amount) || !Number.isInteger(entryId)) {
                    throw new AdminRaidProgressError('missing_raid_progress_snapshot', 'Snapshot do ajuste aplicado está incompleto.', 409);
                }
                const current = await readMonthlyProgress(db, scope);
                if (current.completed !== after.completed || current.reserved !== after.reserved) {
                    throw new AdminRaidProgressError(
                        'raid_progress_changed_since_apply',
                        'O progresso mensal mudou após esta operação e não pode ser desfeito automaticamente.',
                        409,
                        { expected: after, current }
                    );
                }
                await insertAdjustment(db, {
                    entryKey: `admin-reversal:${operation.code}:${unit.id}`,
                    categoryKey: scope.categoryKey,
                    monthKey: scope.monthKey,
                    scopeType: scope.scopeType,
                    scopeKey: scope.scopeKey,
                    amount: -amount,
                    kind: 'reversal',
                    reason: `Desfazer ${operation.code}: ${operation.reason}`,
                    operationCode: operation.code,
                    reversedEntryId: entryId,
                    actorId: operation.actor.id,
                    metadata: { unit_id: unit.id, restored_snapshot: before },
                });
                const restored = await readMonthlyProgress(db, scope);
                if (restored.completed !== before.completed || restored.reserved !== before.reserved) {
                    throw new AdminRaidProgressError(
                        'raid_progress_undo_mismatch',
                        'O desfazer não restaurou o snapshot mensal esperado.',
                        409,
                        { expected: before, restored }
                    );
                }
            },
        },
        'raid.reservation.release': {
            async preview({ db, action, target }) {
                const row = await reservationById(db, action.payload?.reservationId || action.payload?.reservation_id);
                await assertReservationAnchor(db, row, target);
                if (row.status !== 'active') {
                    throw new AdminRaidProgressError(
                        'raid_reservation_not_active',
                        'A reserva mensal não está ativa.',
                        409,
                        { reservationId: row.id, status: row.status }
                    );
                }
                const before = mapReservation(row);
                return {
                    summary: `Liberar reserva mensal #${before.id}`,
                    before,
                    after: { ...before, status: 'released' },
                    metadata: { reservationId: before.id },
                };
            },
            async apply({ db, operation, target, unit, before, after }) {
                const row = await reservationById(db, before.id);
                await assertReservationAnchor(db, row, target);
                if (row.status !== 'active') {
                    throw new AdminRaidProgressError('raid_reservation_changed_since_preview', 'A reserva mudou após a simulação.', 409);
                }
                const metadata = {
                    ...parseJson(row.metadata_json, {}),
                    admin_release: {
                        operation_code: operation.code,
                        actor_id: operation.actor.id,
                        unit_id: unit.id,
                    },
                };
                const result = await db.run(
                    `UPDATE clover_raid_monthly_reservations
                     SET status = 'released', released_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP, release_reason = ?, metadata_json = ?
                     WHERE id = ? AND status = 'active'`,
                    [operation.reason, JSON.stringify(metadata), row.id]
                );
                if (Number(result.changes || 0) !== 1) {
                    throw new AdminRaidProgressError('raid_reservation_release_conflict', 'A reserva não pôde ser liberada.', 409);
                }
                return {
                    before,
                    after: mapReservation(await reservationById(db, row.id)),
                    summary: `Reserva mensal #${row.id} liberada.`,
                };
            },
            async undo({ db, operation, target, before, after }) {
                const row = await reservationById(db, before.id);
                await assertReservationAnchor(db, row, target);
                const release = parseJson(row.metadata_json, {}).admin_release;
                if (row.status !== 'released' || release?.operation_code !== operation.code) {
                    throw new AdminRaidProgressError(
                        'raid_reservation_changed_since_release',
                        'A reserva foi alterada depois da operação e não pode ser restaurada automaticamente.',
                        409
                    );
                }
                const usage = await readMonthlyProgress(db, {
                    categoryKey: row.category_key,
                    monthKey: row.month_key,
                    scopeType: row.scope_type,
                    scopeKey: row.scope_key,
                    excludeRaidId: row.raid_id,
                });
                if (usage.exhausted) {
                    throw new AdminRaidProgressError(
                        'raid_reservation_restore_limit',
                        'A reserva não pode ser restaurada porque o limite mensal já está ocupado.',
                        409,
                        { usage }
                    );
                }
                const metadata = { ...parseJson(row.metadata_json, {}) };
                delete metadata.admin_release;
                await db.run(
                    `UPDATE clover_raid_monthly_reservations
                     SET status = 'active', released_at = NULL, release_reason = NULL,
                         updated_at = CURRENT_TIMESTAMP, metadata_json = ?
                     WHERE id = ? AND status = 'released'`,
                    [JSON.stringify(metadata), row.id]
                );
            },
        },
    };
}

module.exports = {
    AdminRaidProgressError,
    createRaidProgressExecutors,
    mapReservation,
    normalizeAdjustment,
    normalizeMonthKey,
    resolveProgressScope,
};