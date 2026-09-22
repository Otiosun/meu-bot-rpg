const { getSlotConfigOption } = require('./configLoader');
const { normalizeText } = require('../textUtils');

const SLOT_CATEGORIES = new Set(['family', 'anomaly', 'magic', 'race', 'grimoire']);
const ACTIVE_PENDING_CONDITION = "(status = 'pending' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP))";
const ACTIVE_STATUS_CONDITION = `(status = 'confirmed' OR ${ACTIVE_PENDING_CONDITION})`;
const CONFIRMED_PROFILE_STATUSES = new Set(['confirmada', 'aprovada']);
const DEFAULT_RESERVATION_TTL_HOURS = 24;

function normalizeCategory(category) {
    const normalized = String(category || '').trim();
    if (!SLOT_CATEGORIES.has(normalized)) {
        throw new Error(`Categoria de vaga invalida: ${category || '-'}. Use family, anomaly, magic, race ou grimoire.`);
    }
    return normalized;
}

function normalizeOptionKey(optionKey) {
    const normalized = String(optionKey || '').trim();
    if (!normalized) {
        throw new Error('option_key e obrigatoria para reservas de vaga.');
    }
    return normalized;
}

function normalizePlayerId(playerId) {
    const normalized = String(playerId || '').trim();
    if (!normalized) {
        throw new Error('player_id e obrigatorio para reservas de vaga.');
    }
    return normalized;
}

function toSqliteTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Data invalida para expires_at: ${value}`);
    }
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function buildExpiration(options = {}) {
    if (options.expiresAt) return toSqliteTimestamp(options.expiresAt);

    const ttlHours = Number(options.ttlHours ?? DEFAULT_RESERVATION_TTL_HOURS);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
        throw new Error('ttlHours precisa ser um numero positivo.');
    }

    return toSqliteTimestamp(new Date(Date.now() + ttlHours * 60 * 60 * 1000));
}

function normalizeRollNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error('roll_number precisa ser inteiro positivo quando informado.');
    }
    return number;
}

function getCapacity(category, optionKey) {
    const normalizedCategory = normalizeCategory(category);
    const normalizedOptionKey = normalizeOptionKey(optionKey);

    const option = getSlotConfigOption(normalizedCategory, normalizedOptionKey);
    if (!option && normalizedCategory === 'magic') {
        return null;
    }

    if (!option) {
        throw new Error(`Opcao de vaga nao encontrada: ${normalizedCategory}/${normalizedOptionKey}.`);
    }

    return option.capacity ?? null;
}

function normalizeSlotKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeStatus(value) {
    return normalizeText(value).trim();
}

function isConfirmedProfileStatus(value) {
    return CONFIRMED_PROFILE_STATUSES.has(normalizeStatus(value));
}

function getReservationCurrentValue(row, category) {
    if (category === 'magic') {
        return {
            key: String(row.magia_key || '').trim(),
            label: row.magia,
        };
    }
    if (category === 'race') {
        return {
            key: '',
            label: row.raca,
        };
    }
    if (category === 'grimoire') {
        return {
            key: '',
            label: row.grimorio,
        };
    }
    if (category === 'family') {
        return {
            key: String(row.familia_key || '').trim(),
            label: row.familia,
        };
    }
    if (category === 'anomaly') {
        return {
            key: String(row.anomalia_key || '').trim(),
            label: row.anomalia,
        };
    }

    return { key: '', label: '' };
}

function confirmedReservationStillMatches(row, category, optionKey) {
    if (!row.player_exists) return true;
    if (!isConfirmedProfileStatus(row.ficha_status)) return false;

    const option = getSlotConfigOption(category, optionKey);
    const normalizedOptionKey = normalizeSlotKey(optionKey);
    const normalizedOptionName = normalizeSlotKey(option?.name || optionKey);
    const current = getReservationCurrentValue(row, category);

    if (current.key && current.key === optionKey) return true;

    const currentLabel = normalizeSlotKey(current.label);
    return currentLabel === normalizedOptionKey || currentLabel === normalizedOptionName;
}

function shouldCountReservation(row, category, optionKey) {
    if (row.status === 'pending') return true;
    if (row.status !== 'confirmed') return false;
    return confirmedReservationStillMatches(row, category, optionKey);
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = ?
         LIMIT 1`,
        [tableName]
    );
    return Boolean(row);
}

async function getTableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

async function countLegacyMagicSlots(db, optionKey, activeSlotPlayerIds) {
    if (!await tableExists(db, 'jogadores')) return 0;

    const columns = await getTableColumns(db, 'jogadores');
    if (!columns.has('magia')) return 0;

    const selectMagicKey = columns.has('magia_key') ? 'magia_key' : 'NULL AS magia_key';
    const statusCondition = columns.has('ficha_status')
        ? "AND ficha_status IN ('confirmada', 'aprovada')"
        : '';
    const rows = await db.all(
        `SELECT id, magia, ${selectMagicKey}
         FROM jogadores
         WHERE magia IS NOT NULL
           AND magia <> '-'
           ${statusCondition}`
    );
    const option = getSlotConfigOption('magic', optionKey);
    const normalizedOptionName = normalizeSlotKey(option?.name || optionKey);

    return rows.filter((row) => {
        if (activeSlotPlayerIds.has(String(row.id))) return false;
        if (String(row.magia_key || '').trim() === optionKey) return true;

        const magicKey = normalizeSlotKey(row.magia);
        return magicKey === optionKey || magicKey === normalizedOptionName;
    }).length;
}

async function countLegacyProfileSlots(db, category, optionKey, activeSlotPlayerIds) {
    if (!await tableExists(db, 'jogadores')) return 0;

    const columns = await getTableColumns(db, 'jogadores');
    const columnName = category === 'race'
        ? 'raca'
        : category === 'family'
            ? 'familia'
            : 'grimorio';

    if (!columns.has(columnName)) return 0;

    const option = getSlotConfigOption(category, optionKey);
    if (!option) return 0;

    const normalizedOptionName = normalizeSlotKey(option.name || optionKey);
    const normalizedOptionKey = normalizeSlotKey(optionKey);
    const rows = await db.all(
        `SELECT id, ${columnName} AS value
         FROM jogadores
         WHERE ${columnName} IS NOT NULL
           AND ${columnName} <> '-'
           AND ficha_status IN ('confirmada', 'aprovada')`
    );

    return rows.filter((row) => {
        if (activeSlotPlayerIds.has(String(row.id))) return false;
        const normalizedValue = normalizeSlotKey(row.value);
        return normalizedValue === normalizedOptionKey || normalizedValue === normalizedOptionName;
    }).length;
}

async function expireOldReservations(db) {
    const result = await db.run(
        `UPDATE slot_reservations
         SET status = 'expired'
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND expires_at <= CURRENT_TIMESTAMP`
    );
    return Number(result?.changes || 0);
}

async function countUsedSlots(db, category, optionKey, options = {}) {
    const normalizedCategory = normalizeCategory(category);
    const normalizedOptionKey = normalizeOptionKey(optionKey);
    const excludePlayerId = options.excludePlayerId ? String(options.excludePlayerId) : null;

    if (!options.skipExpire) {
        await expireOldReservations(db);
    }

    const args = [normalizedCategory, normalizedOptionKey];
    const activeReservationCondition = "(sr.status = 'confirmed' OR (sr.status = 'pending' AND (sr.expires_at IS NULL OR sr.expires_at > CURRENT_TIMESTAMP)))";
    let query = `SELECT
            sr.player_id,
            sr.status,
            CASE WHEN j.id IS NULL THEN 0 ELSE 1 END AS player_exists,
            j.ficha_status,
            j.magia,
            j.magia_key,
            j.raca,
            j.grimorio,
            j.familia,
            j.familia_key,
            j.anomalia,
            j.anomalia_key
         FROM slot_reservations sr
         LEFT JOIN jogadores j ON j.id = sr.player_id
         WHERE sr.category = ?
           AND sr.option_key = ?
           AND ${activeReservationCondition}`;

    if (excludePlayerId) {
        query += ' AND sr.player_id <> ?';
        args.push(excludePlayerId);
    }

    const rows = (await db.all(query, args))
        .filter((row) => shouldCountReservation(row, normalizedCategory, normalizedOptionKey));

    let total = rows.length;
    const activeSlotPlayerIds = new Set(rows.map((row) => String(row.player_id)));
    if (excludePlayerId) {
        activeSlotPlayerIds.add(excludePlayerId);
    }

    if (normalizedCategory === 'magic') {
        total += await countLegacyMagicSlots(
            db,
            normalizedOptionKey,
            activeSlotPlayerIds
        );
    } else if (
        normalizedCategory === 'race'
        || normalizedCategory === 'family'
        || normalizedCategory === 'grimoire'
    ) {
        total += await countLegacyProfileSlots(
            db,
            normalizedCategory,
            normalizedOptionKey,
            activeSlotPlayerIds
        );
    }

    return total;
}

async function canReserve(db, category, optionKey, options = {}) {
    const capacity = getCapacity(category, optionKey);
    const usedCount = await countUsedSlots(db, category, optionKey, options);
    const available = capacity === null || usedCount < capacity;

    return {
        ok: available,
        available,
        capacity,
        usedCount,
        remaining: capacity === null ? null : Math.max(capacity - usedCount, 0),
    };
}

async function getActiveReservationForPlayer(db, playerId, category, optionKey) {
    return db.get(
        `SELECT *
         FROM slot_reservations
         WHERE player_id = ?
           AND category = ?
           AND option_key = ?
           AND ${ACTIVE_STATUS_CONDITION}
         ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, id DESC
         LIMIT 1`,
        [playerId, category, optionKey]
    );
}

async function releasePendingForSameSource(db, playerId, category, source) {
    if (!source || source === '-') return 0;

    const result = await db.run(
        `UPDATE slot_reservations
         SET status = 'released'
         WHERE player_id = ?
           AND category = ?
           AND source = ?
           AND status = 'pending'`,
        [playerId, category, source]
    );

    return Number(result?.changes || 0);
}

async function reserveSlot(db, playerId, category, optionKey, source = '-', rollNumber = null, options = {}) {
    const normalizedPlayerId = normalizePlayerId(playerId);
    const normalizedCategory = normalizeCategory(category);
    const normalizedOptionKey = normalizeOptionKey(optionKey);
    const normalizedSource = String(source || '-').trim() || '-';
    const normalizedRollNumber = normalizeRollNumber(rollNumber);
    const expiresAt = buildExpiration(options);

    await db.exec('BEGIN IMMEDIATE');

    try {
        await expireOldReservations(db);

        const existingReservation = await getActiveReservationForPlayer(
            db,
            normalizedPlayerId,
            normalizedCategory,
            normalizedOptionKey
        );

        if (existingReservation) {
            const capacity = getCapacity(normalizedCategory, normalizedOptionKey);
            const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });

            await db.exec('COMMIT');
            return {
                ok: true,
                reason: existingReservation.status === 'confirmed' ? 'already_confirmed' : 'already_pending',
                reservation: existingReservation,
                capacity,
                usedCount,
            };
        }

        await releasePendingForSameSource(db, normalizedPlayerId, normalizedCategory, normalizedSource);

        const capacity = getCapacity(normalizedCategory, normalizedOptionKey);
        const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });

        if (capacity !== null && usedCount >= capacity) {
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'capacity_full',
                capacity,
                usedCount,
                remaining: 0,
            };
        }

        const insert = await db.run(
            `INSERT INTO slot_reservations
             (player_id, category, option_key, status, source, roll_number, expires_at, created_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                normalizedPlayerId,
                normalizedCategory,
                normalizedOptionKey,
                normalizedSource,
                normalizedRollNumber,
                expiresAt,
            ]
        );

        const reservation = await db.get(
            'SELECT * FROM slot_reservations WHERE id = ?',
            [insert.lastID]
        );

        await db.exec('COMMIT');

        return {
            ok: true,
            reason: 'reserved',
            reservation,
            capacity,
            usedCount: usedCount + 1,
            remaining: capacity === null ? null : Math.max(capacity - usedCount - 1, 0),
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function confirmReservation(db, playerId, category, optionKey) {
    const normalizedPlayerId = normalizePlayerId(playerId);
    const normalizedCategory = normalizeCategory(category);
    const normalizedOptionKey = normalizeOptionKey(optionKey);

    await db.exec('BEGIN IMMEDIATE');

    try {
        await expireOldReservations(db);

        const reservation = await db.get(
            `SELECT *
             FROM slot_reservations
             WHERE player_id = ?
               AND category = ?
               AND option_key = ?
               AND ${ACTIVE_PENDING_CONDITION}
             ORDER BY id DESC
             LIMIT 1`,
            [normalizedPlayerId, normalizedCategory, normalizedOptionKey]
        );

        if (!reservation) {
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'missing_pending',
            };
        }

        const capacity = getCapacity(normalizedCategory, normalizedOptionKey);
        const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });

        if (capacity !== null && usedCount > capacity) {
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'capacity_overbooked',
                capacity,
                usedCount,
            };
        }

        await db.run(
            `UPDATE slot_reservations
             SET status = 'confirmed',
                 confirmed_at = CURRENT_TIMESTAMP,
                 expires_at = NULL
             WHERE id = ?`,
            [reservation.id]
        );

        const confirmed = await db.get(
            'SELECT * FROM slot_reservations WHERE id = ?',
            [reservation.id]
        );

        await db.exec('COMMIT');

        return {
            ok: true,
            reason: 'confirmed',
            reservation: confirmed,
            capacity,
            usedCount,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function releaseReservation(db, playerId, category, optionKey) {
    const normalizedPlayerId = normalizePlayerId(playerId);
    const normalizedCategory = normalizeCategory(category);
    const normalizedOptionKey = normalizeOptionKey(optionKey);

    await expireOldReservations(db);

    const result = await db.run(
        `UPDATE slot_reservations
         SET status = 'released'
         WHERE player_id = ?
           AND category = ?
           AND option_key = ?
           AND status = 'pending'`,
        [normalizedPlayerId, normalizedCategory, normalizedOptionKey]
    );

    return {
        ok: Number(result?.changes || 0) > 0,
        releasedCount: Number(result?.changes || 0),
    };
}

async function releasePlayerCategorySlotsExcept(db, playerId, category, keepOptionKey = null) {
    const normalizedPlayerId = normalizePlayerId(playerId);
    const normalizedCategory = normalizeCategory(category);
    const normalizedKeepOptionKey = keepOptionKey ? normalizeOptionKey(keepOptionKey) : null;

    await expireOldReservations(db);

    const args = [normalizedPlayerId, normalizedCategory];
    let query = `
        UPDATE slot_reservations
        SET status = 'released',
            expires_at = NULL
        WHERE player_id = ?
          AND category = ?
          AND status IN ('pending', 'confirmed')
    `;

    if (normalizedKeepOptionKey) {
        query += ' AND option_key <> ?';
        args.push(normalizedKeepOptionKey);
    }

    const result = await db.run(query, args);

    return {
        ok: Number(result?.changes || 0) > 0,
        releasedCount: Number(result?.changes || 0),
    };
}

async function occupySlotInTransaction(db, playerId, category, optionKey, source = '-', rollNumber = null) {
    const normalizedPlayerId = normalizePlayerId(playerId);
    const normalizedCategory = normalizeCategory(category);
    const normalizedOptionKey = normalizeOptionKey(optionKey);
    const normalizedSource = String(source || '-').trim() || '-';
    const normalizedRollNumber = normalizeRollNumber(rollNumber);
        await expireOldReservations(db);

        const existingReservation = await getActiveReservationForPlayer(
            db,
            normalizedPlayerId,
            normalizedCategory,
            normalizedOptionKey
        );

        if (existingReservation?.status === 'confirmed') {
            const capacity = getCapacity(normalizedCategory, normalizedOptionKey);
            const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });
            return {
                ok: true,
                reason: 'already_confirmed',
                reservation: existingReservation,
                capacity,
                usedCount,
            };
        }

        if (existingReservation?.status === 'pending') {
            const capacity = getCapacity(normalizedCategory, normalizedOptionKey);
            const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });

            await db.run(
                `UPDATE slot_reservations
                 SET status = 'confirmed',
                     source = ?,
                     roll_number = COALESCE(?, roll_number),
                     expires_at = NULL,
                     confirmed_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [normalizedSource, normalizedRollNumber, existingReservation.id]
            );

            const confirmed = await db.get(
                'SELECT * FROM slot_reservations WHERE id = ?',
                [existingReservation.id]
            );
            return {
                ok: true,
                reason: 'confirmed_existing',
                reservation: confirmed,
                capacity,
                usedCount,
            };
        }

        const capacity = getCapacity(normalizedCategory, normalizedOptionKey);
        if (capacity === null) {
            const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });
            return {
                ok: true,
                reason: 'unlimited',
                reservation: null,
                capacity,
                usedCount,
            };
        }

        const usedCount = await countUsedSlots(db, normalizedCategory, normalizedOptionKey, { skipExpire: true });
        if (usedCount >= capacity) {
            return {
                ok: false,
                reason: 'capacity_full',
                capacity,
                usedCount,
                remaining: 0,
            };
        }

        await releasePendingForSameSource(db, normalizedPlayerId, normalizedCategory, normalizedSource);

        const insert = await db.run(
            `INSERT INTO slot_reservations
             (player_id, category, option_key, status, source, roll_number, expires_at, created_at, confirmed_at)
             VALUES (?, ?, ?, 'confirmed', ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                normalizedPlayerId,
                normalizedCategory,
                normalizedOptionKey,
                normalizedSource,
                normalizedRollNumber,
            ]
        );

        const reservation = await db.get(
            'SELECT * FROM slot_reservations WHERE id = ?',
            [insert.lastID]
        );

        return {
            ok: true,
            reason: 'occupied',
            reservation,
            capacity,
            usedCount: usedCount + 1,
            remaining: Math.max(capacity - usedCount - 1, 0),
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function occupySlot(db, playerId, category, optionKey, source = '-', rollNumber = null) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await occupySlotInTransaction(
            db,
            playerId,
            category,
            optionKey,
            source,
            rollNumber
        );
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

module.exports = {
    canReserve,
    confirmReservation,
    countUsedSlots,
    expireOldReservations,
    getCapacity,
    occupySlot,
    occupySlotInTransaction,
    releasePlayerCategorySlotsExcept,
    releaseReservation,
    reserveSlot,
};
