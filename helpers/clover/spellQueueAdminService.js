const { normalizeText } = require('../textUtils');
const { ensureSpellbookSchema } = require('./spellbookService');

const ACTIVE_QUEUE_STATUSES = new Set(['waiting', 'called']);
const CLOSE_QUEUE_STATUSES = new Set(['concluded', 'removed', 'cancelled']);

function normalizeStatus(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function hasUsableCharacterName(value) {
    const normalized = normalizeStatus(value);
    return Boolean(normalized) && !['-', 'nenhum', 'na', 'null', 'undefined'].includes(normalized);
}

function issue(code, message) {
    return { code, message };
}

function inspectQueueRow(row) {
    const blocking = [];
    const warnings = [];

    if (!row?.player_exists_id) {
        blocking.push(issue('player_not_found', 'Cadastro do player não existe mais no banco.'));
    } else {
        if (!hasUsableCharacterName(row.personagem_nome)) {
            blocking.push(issue('character_missing', 'Cadastro existe, mas não possui personagem válido.'));
        }

        if (normalizeStatus(row.ficha_status) !== 'aprovada') {
            warnings.push(issue('profile_not_approved', `Ficha está como ${row.ficha_status || '-'}.`));
        }

        if (normalizeStatus(row.jogo_status) !== 'liberado') {
            warnings.push(issue('game_not_released', `Jogo está como ${row.jogo_status || '-'}.`));
        }
    }

    return {
        ...row,
        integrity: {
            ok: blocking.length === 0,
            blocking,
            warnings,
        },
    };
}

async function fetchActiveQueueRows(db) {
    await ensureSpellbookSchema(db);
    const rows = await db.all(
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
         ORDER BY CASE q.status WHEN 'called' THEN 0 ELSE 1 END,
                  q.requested_at,
                  q.id`
    );

    return (rows || []).map((row, index) => ({
        ...inspectQueueRow(row),
        position: index + 1,
    }));
}

async function diagnoseSpellReviewQueue(db) {
    const entries = await fetchActiveQueueRows(db);
    const blocking = entries.filter((entry) => !entry.integrity.ok);
    const warnings = entries.filter((entry) => entry.integrity.ok && entry.integrity.warnings.length > 0);

    return {
        entries,
        total: entries.length,
        healthy: entries.length - blocking.length,
        blocking,
        warnings,
        called: entries.filter((entry) => entry.status === 'called').length,
        waiting: entries.filter((entry) => entry.status === 'waiting').length,
    };
}

async function getQueueEntryByPosition(db, position) {
    const number = Number(position);
    if (!Number.isInteger(number) || number < 1) {
        return { ok: false, code: 'invalid_position' };
    }

    const entries = await fetchActiveQueueRows(db);
    const entry = entries[number - 1] || null;
    if (!entry) {
        return { ok: false, code: 'position_not_found', total: entries.length };
    }

    return { ok: true, entry, total: entries.length };
}

async function closeQueueEntryById(db, entryId, status, closedBy, reason = null) {
    await ensureSpellbookSchema(db);
    if (!CLOSE_QUEUE_STATUSES.has(status)) {
        return { ok: false, code: 'invalid_status' };
    }

    const result = await db.run(
        `UPDATE clover_spell_review_queue
         SET status = ?,
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?
         WHERE id = ?
           AND status IN ('waiting', 'called')`,
        [status, closedBy || null, reason || null, entryId]
    );

    if (!Number(result?.changes || 0)) {
        return { ok: false, code: 'not_active' };
    }

    return {
        ok: true,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entryId]),
    };
}

async function requeueQueueEntryById(db, entryId, closedBy, reason = null) {
    await ensureSpellbookSchema(db);
    const before = await db.get(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE id = ? AND status IN ('waiting', 'called')`,
        [entryId]
    );
    if (!before) return { ok: false, code: 'not_active' };

    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'waiting',
             requested_at = CURRENT_TIMESTAMP,
             called_at = NULL,
             closed_at = NULL,
             closed_by = ?,
             reason = ?
         WHERE id = ?`,
        [closedBy || null, reason || null, entryId]
    );

    return {
        ok: true,
        previousStatus: before.status,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entryId]),
    };
}

function automaticRemovalReason(entry) {
    const details = entry.integrity.blocking.map((item) => item.message).join(' ');
    return `entrada órfã ignorada automaticamente: ${details}`.slice(0, 500);
}

async function markBrokenEntryRemoved(db, entry, adminId) {
    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'removed',
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?
         WHERE id = ?
           AND status IN ('waiting', 'called')`,
        [adminId || 'system', automaticRemovalReason(entry), entry.id]
    );
}

async function callNextHealthyQueueEntry(db, adminId, options = {}) {
    await ensureSpellbookSchema(db);
    const excludedPlayerId = options.excludePlayerId || null;
    const skipped = [];

    await db.exec('BEGIN IMMEDIATE');
    try {
        const rows = await fetchActiveQueueRows(db);
        const calledEntries = rows.filter((entry) => entry.status === 'called');

        for (const entry of calledEntries) {
            if (entry.integrity.ok) {
                await db.exec('COMMIT');
                return { ok: false, code: 'already_called', entry, skipped };
            }

            await markBrokenEntryRemoved(db, entry, adminId);
            skipped.push({ ...entry, previousStatus: 'called' });
        }

        const waitingEntries = rows.filter((entry) => entry.status === 'waiting');
        let next = null;

        for (const entry of waitingEntries) {
            if (!entry.integrity.ok) {
                await markBrokenEntryRemoved(db, entry, adminId);
                skipped.push({ ...entry, previousStatus: 'waiting' });
                continue;
            }

            if (excludedPlayerId && entry.player_id === excludedPlayerId) continue;
            next = entry;
            break;
        }

        if (!next) {
            await db.exec('COMMIT');
            return { ok: false, code: 'empty', skipped };
        }

        const updated = await db.run(
            `UPDATE clover_spell_review_queue
             SET status = 'called',
                 called_at = CURRENT_TIMESTAMP,
                 closed_by = ?
             WHERE id = ?
               AND status = 'waiting'`,
            [adminId || null, next.id]
        );

        if (!Number(updated?.changes || 0)) {
            throw new Error('A entrada mudou durante a chamada do próximo player.');
        }

        const called = await db.get(
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
            [next.id]
        );

        await db.exec('COMMIT');
        return { ok: true, entry: inspectQueueRow(called), skipped };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ACTIVE_QUEUE_STATUSES,
    callNextHealthyQueueEntry,
    closeQueueEntryById,
    diagnoseSpellReviewQueue,
    fetchActiveQueueRows,
    getQueueEntryByPosition,
    hasUsableCharacterName,
    inspectQueueRow,
    requeueQueueEntryById,
};
