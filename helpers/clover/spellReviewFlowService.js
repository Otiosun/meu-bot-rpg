'use strict';

const { isSameUser } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const { getSpellCapacity } = require('./spellCapacityService');
const { ensureSpellbookSchema } = require('./spellbookService');

const CAPACITY_SETTING_KEY = 'clover_spell_review_capacity';
const AUTO_FLOW_SETTING_KEY = 'clover_spell_review_auto_flow';
const DEFAULT_CAPACITY = 5;
const MAX_CAPACITY = 20;
const REVIEW_STATE_ACTIVE = 'active';
const REVIEW_STATE_PENDING = 'pending';

function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function hasUsableCharacterName(value) {
    const normalized = compact(value);
    return Boolean(normalized) && !['-', 'nenhum', 'na', 'null', 'undefined'].includes(normalized);
}

function inspectQueueRow(row) {
    const blocking = [];
    const warnings = [];

    if (!row?.player_exists_id) {
        blocking.push({ code: 'player_not_found', message: 'Cadastro do player não existe mais.' });
    } else {
        if (!hasUsableCharacterName(row.personagem_nome)) {
            blocking.push({ code: 'character_missing', message: 'Cadastro sem personagem válido.' });
        }
        if (compact(row.ficha_status) !== 'aprovada') {
            warnings.push({ code: 'profile_not_approved', message: `Ficha em ${row.ficha_status || '-'}.` });
        }
        if (compact(row.jogo_status) !== 'liberado') {
            warnings.push({ code: 'game_not_released', message: `Jogo em ${row.jogo_status || '-'}.` });
        }
    }

    const reviewState = row.status === 'called' && row.review_state === REVIEW_STATE_PENDING
        ? REVIEW_STATE_PENDING
        : row.status === 'called'
            ? REVIEW_STATE_ACTIVE
            : 'waiting';

    return {
        ...row,
        review_state: reviewState,
        occupies_slot: row.status === 'called' && reviewState === REVIEW_STATE_ACTIVE,
        integrity: {
            ok: blocking.length === 0,
            blocking,
            warnings,
        },
    };
}

async function ensureSettingsSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function ensureSpellReviewFlowSchema(db) {
    await ensureSpellbookSchema(db);
    await ensureSettingsSchema(db);

    const columns = await db.all('PRAGMA table_info(clover_spell_review_queue)');
    const names = new Set((columns || []).map((column) => column.name));

    if (!names.has('review_state')) {
        await db.exec("ALTER TABLE clover_spell_review_queue ADD COLUMN review_state TEXT NOT NULL DEFAULT 'active'");
    }
    if (!names.has('held_at')) {
        await db.exec('ALTER TABLE clover_spell_review_queue ADD COLUMN held_at TEXT DEFAULT NULL');
    }
    if (!names.has('held_by')) {
        await db.exec('ALTER TABLE clover_spell_review_queue ADD COLUMN held_by TEXT DEFAULT NULL');
    }
    if (!names.has('hold_reason')) {
        await db.exec('ALTER TABLE clover_spell_review_queue ADD COLUMN hold_reason TEXT DEFAULT NULL');
    }

    await db.run(
        `UPDATE clover_spell_review_queue
         SET review_state = 'active'
         WHERE review_state IS NULL
            OR review_state NOT IN ('active', 'pending')`
    );
}

async function readSetting(db, key) {
    await ensureSettingsSchema(db);
    const row = await db.get('SELECT value FROM clover_settings WHERE key = ?', [key]);
    return row?.value ?? null;
}

async function writeSetting(db, key, value) {
    await ensureSettingsSchema(db);
    await db.run(
        `INSERT INTO clover_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = CURRENT_TIMESTAMP`,
        [key, String(value)]
    );
}

function normalizeCapacity(value) {
    const capacity = Number(value);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
        return null;
    }
    return capacity;
}

async function getSpellReviewCapacity(db) {
    const stored = normalizeCapacity(await readSetting(db, CAPACITY_SETTING_KEY));
    return stored || DEFAULT_CAPACITY;
}

async function setSpellReviewCapacity(db, capacity) {
    const normalized = normalizeCapacity(capacity);
    if (!normalized) {
        return {
            ok: false,
            code: 'invalid_capacity',
            min: 1,
            max: MAX_CAPACITY,
        };
    }
    await writeSetting(db, CAPACITY_SETTING_KEY, normalized);
    return { ok: true, capacity: normalized };
}

async function getSpellReviewAutoFlowEnabled(db) {
    const value = await readSetting(db, AUTO_FLOW_SETTING_KEY);
    return value !== '0';
}

async function setSpellReviewAutoFlowEnabled(db, enabled) {
    await writeSetting(db, AUTO_FLOW_SETTING_KEY, enabled ? '1' : '0');
    return Boolean(enabled);
}

async function fetchFlowRowsRaw(db) {
    return db.all(
        `SELECT q.*,
                p.id AS player_exists_id,
                p.personagem_nome,
                p.nome,
                p.display_name,
                p.ficha_status,
                p.jogo_status
         FROM clover_spell_review_queue q
         LEFT JOIN jogadores p ON p.id = q.player_id
         WHERE q.status IN ('called', 'waiting')
         ORDER BY CASE
                    WHEN q.status = 'called' AND COALESCE(q.review_state, 'active') != 'pending' THEN 0
                    WHEN q.status = 'called' THEN 1
                    ELSE 2
                  END,
                  COALESCE(q.called_at, q.requested_at),
                  q.requested_at,
                  q.id`
    );
}

async function listSpellReviewFlowEntries(db) {
    await ensureSpellReviewFlowSchema(db);
    const rows = await fetchFlowRowsRaw(db);
    return rows.map((row, index) => ({
        ...inspectQueueRow(row),
        position: index + 1,
    }));
}

async function getSpellReviewFlowState(db) {
    const [capacity, autoFlow, entries] = await Promise.all([
        getSpellReviewCapacity(db),
        getSpellReviewAutoFlowEnabled(db),
        listSpellReviewFlowEntries(db),
    ]);
    const activeEntries = entries.filter((entry) => entry.occupies_slot);
    const pendingEntries = entries.filter((entry) => entry.status === 'called' && entry.review_state === REVIEW_STATE_PENDING);
    const waitingEntries = entries.filter((entry) => entry.status === 'waiting');

    return {
        capacity,
        autoFlow,
        active: activeEntries.length,
        pending: pendingEntries.length,
        waiting: waitingEntries.length,
        vacancies: Math.max(0, capacity - activeEntries.length),
        entries,
        activeEntries,
        pendingEntries,
        waitingEntries,
    };
}

async function markBrokenEntryRemoved(db, entry, actorId) {
    const reason = entry.integrity.blocking
        .map((item) => item.message)
        .join(' ')
        .slice(0, 420);
    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'removed',
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?,
             review_state = 'active',
             held_at = NULL,
             held_by = NULL,
             hold_reason = NULL
         WHERE id = ?
           AND status IN ('called', 'waiting')`,
        [actorId || 'system', `entrada inválida ignorada automaticamente: ${reason}`, entry.id]
    );
}

function matchesExcluded(playerId, excludedPlayerIds) {
    return excludedPlayerIds.some((candidate) => (
        candidate === playerId || isSameUser(candidate, playerId)
    ));
}

async function fillSpellReviewSlots(db, actorId, options = {}) {
    await ensureSpellReviewFlowSchema(db);
    const capacity = normalizeCapacity(options.capacity) || await getSpellReviewCapacity(db);
    const excludedPlayerIds = [...new Set((options.excludePlayerIds || []).filter(Boolean))];
    const allowCapacityBlocked = options.allowCapacityBlocked === true;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const rows = (await fetchFlowRowsRaw(db)).map(inspectQueueRow);
        const skipped = [];
        const blocked = [];

        for (const entry of rows.filter((row) => !row.integrity.ok)) {
            await markBrokenEntryRemoved(db, entry, actorId);
            skipped.push({ ...entry, previousStatus: entry.status });
        }

        const healthy = rows.filter((row) => row.integrity.ok);
        const activeBefore = healthy.filter((row) => row.occupies_slot).length;
        let remaining = Math.max(0, capacity - activeBefore);
        const called = [];

        for (const entry of healthy.filter((row) => row.status === 'waiting')) {
            if (remaining <= 0) break;
            if (matchesExcluded(entry.player_id, excludedPlayerIds)) continue;

            if (!allowCapacityBlocked) {
                const spellCapacity = await getSpellCapacity(db, entry.player_id);
                if (!spellCapacity.canApproveNewSpell) {
                    blocked.push({
                        ...entry,
                        blockCode: spellCapacity.overCapacity
                            ? 'legacy_over_capacity'
                            : 'no_available_spell_slot',
                        spellCapacity,
                        statusPreserved: true,
                    });
                    continue;
                }
            }

            const updated = await db.run(
                `UPDATE clover_spell_review_queue
                 SET status = 'called',
                     called_at = CURRENT_TIMESTAMP,
                     closed_at = NULL,
                     closed_by = ?,
                     reason = NULL,
                     review_state = 'active',
                     held_at = NULL,
                     held_by = NULL,
                     hold_reason = NULL
                 WHERE id = ?
                   AND status = 'waiting'`,
                [actorId || null, entry.id]
            );
            if (!Number(updated?.changes || 0)) continue;

            const row = await db.get(
                `SELECT q.*,
                        p.id AS player_exists_id,
                        p.personagem_nome,
                        p.nome,
                        p.display_name,
                        p.ficha_status,
                        p.jogo_status
                 FROM clover_spell_review_queue q
                 LEFT JOIN jogadores p ON p.id = q.player_id
                 WHERE q.id = ?`,
                [entry.id]
            );
            called.push(inspectQueueRow(row));
            remaining -= 1;
        }

        await db.exec('COMMIT');
        const state = await getSpellReviewFlowState(db);
        return {
            ok: true,
            code: called.length
                ? 'filled'
                : state.vacancies && blocked.length
                    ? 'capacity_blocked'
                    : state.vacancies
                        ? 'empty'
                        : 'capacity_full',
            capacity,
            activeBefore,
            called,
            skipped,
            blocked,
            state,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function findActiveEntryForPlayer(db, playerId) {
    await ensureSpellReviewFlowSchema(db);
    const rows = await db.all(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE status IN ('called', 'waiting')
         ORDER BY id DESC`
    );
    return rows.find((entry) => (
        entry.player_id === playerId || isSameUser(entry.player_id, playerId)
    )) || null;
}

async function holdSpellReviewEntry(db, playerId, actorId, reason = null) {
    const entry = await findActiveEntryForPlayer(db, playerId);
    if (!entry) return { ok: false, code: 'not_active' };
    if (entry.status !== 'called') return { ok: false, code: 'not_called', entry };
    if (entry.review_state === REVIEW_STATE_PENDING) {
        return { ok: false, code: 'already_pending', entry };
    }

    const updated = await db.run(
        `UPDATE clover_spell_review_queue
         SET review_state = 'pending',
             held_at = CURRENT_TIMESTAMP,
             held_by = ?,
             hold_reason = ?,
             reason = ?
         WHERE id = ?
           AND status = 'called'
           AND COALESCE(review_state, 'active') != 'pending'`,
        [actorId || null, reason || null, reason || null, entry.id]
    );
    if (!Number(updated?.changes || 0)) return { ok: false, code: 'changed' };
    return {
        ok: true,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entry.id]),
    };
}

async function resumeSpellReviewEntry(db, playerId, actorId) {
    await ensureSpellReviewFlowSchema(db);
    const capacity = await getSpellReviewCapacity(db);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const entry = await findActiveEntryForPlayer(db, playerId);
        if (!entry) {
            await db.exec('COMMIT');
            return { ok: false, code: 'not_active' };
        }
        if (entry.status !== 'called' || entry.review_state !== REVIEW_STATE_PENDING) {
            await db.exec('COMMIT');
            return { ok: false, code: 'not_pending', entry };
        }

        const row = await db.get(
            `SELECT COUNT(*) AS total
             FROM clover_spell_review_queue
             WHERE status = 'called'
               AND COALESCE(review_state, 'active') != 'pending'`
        );
        const active = Number(row?.total || 0);
        if (active >= capacity) {
            await db.exec('COMMIT');
            return { ok: false, code: 'capacity_full', capacity, active, entry };
        }

        await db.run(
            `UPDATE clover_spell_review_queue
             SET review_state = 'active',
                 held_at = NULL,
                 held_by = NULL,
                 hold_reason = NULL,
                 closed_by = ?,
                 reason = NULL
             WHERE id = ?
               AND status = 'called'
               AND review_state = 'pending'`,
            [actorId || null, entry.id]
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            capacity,
            entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entry.id]),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function concludeSpellReviewEntry(db, playerId, actorId, reason = 'feitiço aprovado') {
    const entry = await findActiveEntryForPlayer(db, playerId);
    if (!entry) return { ok: false, code: 'not_active' };
    if (!['called', 'waiting'].includes(entry.status)) return { ok: false, code: 'not_concludable', entry };

    const updated = await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'concluded',
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?,
             review_state = 'active',
             held_at = NULL,
             held_by = NULL,
             hold_reason = NULL
         WHERE id = ?
           AND status IN ('called', 'waiting')`,
        [actorId || null, reason || 'feitiço aprovado', entry.id]
    );
    if (!Number(updated?.changes || 0)) return { ok: false, code: 'changed' };
    return {
        ok: true,
        previousStatus: entry.status,
        previousReviewState: entry.review_state || REVIEW_STATE_ACTIVE,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entry.id]),
    };
}

async function deferSpellReviewEntry(db, playerId, actorId, reason = 'adiado pelo ADM') {
    const entry = await findActiveEntryForPlayer(db, playerId);
    if (!entry) return { ok: false, code: 'not_active' };

    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'waiting',
             requested_at = CURRENT_TIMESTAMP,
             called_at = NULL,
             closed_at = NULL,
             closed_by = ?,
             reason = ?,
             review_state = 'active',
             held_at = NULL,
             held_by = NULL,
             hold_reason = NULL
         WHERE id = ?
           AND status IN ('called', 'waiting')`,
        [actorId || null, reason || 'adiado pelo ADM', entry.id]
    );
    return {
        ok: true,
        previousStatus: entry.status,
        previousReviewState: entry.review_state || REVIEW_STATE_ACTIVE,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entry.id]),
    };
}

module.exports = {
    AUTO_FLOW_SETTING_KEY,
    CAPACITY_SETTING_KEY,
    DEFAULT_CAPACITY,
    MAX_CAPACITY,
    REVIEW_STATE_ACTIVE,
    REVIEW_STATE_PENDING,
    concludeSpellReviewEntry,
    deferSpellReviewEntry,
    ensureSpellReviewFlowSchema,
    fillSpellReviewSlots,
    findActiveEntryForPlayer,
    getSpellReviewAutoFlowEnabled,
    getSpellReviewCapacity,
    getSpellReviewFlowState,
    holdSpellReviewEntry,
    inspectQueueRow,
    listSpellReviewFlowEntries,
    resumeSpellReviewEntry,
    setSpellReviewAutoFlowEnabled,
    setSpellReviewCapacity,
};
