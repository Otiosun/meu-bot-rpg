'use strict';

const DEFAULT_CAPACITY = 5;
const MAX_CAPACITY = 20;
const CAPACITY_SETTING_KEY = 'clover_spell_review_capacity';
const AUTO_FLOW_SETTING_KEY = 'clover_spell_review_auto_flow';

function boundedInteger(value, fallback = 20, maximum = 100) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

function normalizeCapacity(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_CAPACITY
        ? parsed
        : DEFAULT_CAPACITY;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set((rows || []).map((row) => row.name));
}

function selectedColumn(columns, qualifiedName, alias, fallback = 'NULL') {
    const column = qualifiedName.split('.').pop();
    return columns.has(column)
        ? `${qualifiedName} AS ${alias}`
        : `${fallback} AS ${alias}`;
}

function displayExpression(playerColumns) {
    const candidates = [];
    if (playerColumns.has('personagem_nome')) candidates.push("NULLIF(TRIM(p.personagem_nome), '')");
    if (playerColumns.has('display_name')) candidates.push("NULLIF(TRIM(p.display_name), '')");
    if (playerColumns.has('nome')) candidates.push("NULLIF(TRIM(p.nome), '')");
    return candidates.length ? `COALESCE(${candidates.join(', ')})` : 'NULL';
}

async function readSettings(db, tables) {
    if (!tables.has('clover_settings')) {
        return { capacity: DEFAULT_CAPACITY, autoFlow: true };
    }
    const rows = await db.all(
        `SELECT key, value
         FROM clover_settings
         WHERE key IN (?, ?)`,
        [CAPACITY_SETTING_KEY, AUTO_FLOW_SETTING_KEY]
    );
    const values = new Map((rows || []).map((row) => [row.key, row.value]));
    return {
        capacity: normalizeCapacity(values.get(CAPACITY_SETTING_KEY)),
        autoFlow: values.get(AUTO_FLOW_SETTING_KEY) !== '0',
    };
}

function classifyRow(row) {
    const reviewState = row.status === 'called' && row.review_state === 'pending'
        ? 'pending'
        : row.status;
    if (reviewState === 'called') {
        return {
            status: 'called',
            priority: 'high',
            summary: 'Avaliação de feitiço chamada e aguardando conclusão.',
        };
    }
    if (reviewState === 'pending') {
        return {
            status: 'pending',
            priority: 'medium',
            summary: 'Avaliação chamada está em espera e exige retomada, adiamento ou decisão.',
        };
    }
    return {
        status: 'waiting',
        priority: 'low',
        summary: 'Entrada aguarda chamada na fila de avaliação de feitiços.',
    };
}

async function getAdminSpellReviewInboxReadModel(db, options = {}) {
    const limit = boundedInteger(options.limit, 20, 100);
    if (!db || typeof db.all !== 'function' || typeof db.get !== 'function') {
        return { items: [], flow: null };
    }

    const tableRows = await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('clover_spell_review_queue', 'clover_settings', 'jogadores')"
    );
    const tables = new Set((tableRows || []).map((row) => row.name));
    if (!tables.has('clover_spell_review_queue')) {
        return { items: [], flow: null };
    }

    const queueColumns = await tableColumns(db, 'clover_spell_review_queue');
    const playerColumns = tables.has('jogadores')
        ? await tableColumns(db, 'jogadores')
        : new Set();
    const canJoinPlayers = tables.has('jogadores') && playerColumns.has('id');
    const reviewState = selectedColumn(queueColumns, 'q.review_state', 'review_state', "'active'");
    const heldAt = selectedColumn(queueColumns, 'q.held_at', 'held_at');
    const holdReason = selectedColumn(queueColumns, 'q.hold_reason', 'hold_reason');
    const characterName = canJoinPlayers ? displayExpression(playerColumns) : 'NULL';

    const rows = await db.all(
        `SELECT q.id, q.player_id, q.status, q.requested_at, q.called_at,
                ${reviewState},
                ${heldAt},
                ${holdReason},
                ${characterName} AS character_name
         FROM clover_spell_review_queue q
         ${canJoinPlayers ? 'LEFT JOIN jogadores p ON p.id = q.player_id' : ''}
         WHERE q.status IN ('called', 'waiting')
         ORDER BY
             CASE
                 WHEN q.status = 'called' AND ${queueColumns.has('review_state') ? "COALESCE(q.review_state, 'active') <> 'pending'" : '1 = 1'} THEN 0
                 WHEN q.status = 'called' THEN 1
                 ELSE 2
             END,
             COALESCE(q.called_at, q.requested_at) ASC,
             q.id ASC
         LIMIT ?`,
        [limit]
    );

    const settings = await readSettings(db, tables);
    const counts = await db.get(
        `SELECT
            SUM(CASE WHEN status = 'called' AND ${queueColumns.has('review_state') ? "COALESCE(review_state, 'active') <> 'pending'" : '1 = 1'} THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'called' AND ${queueColumns.has('review_state') ? "review_state = 'pending'" : '0 = 1'} THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting
         FROM clover_spell_review_queue
         WHERE status IN ('called', 'waiting')`
    );
    const active = Number(counts?.active || 0);
    const pending = Number(counts?.pending || 0);
    const waiting = Number(counts?.waiting || 0);

    const items = (rows || []).map((row) => {
        const classification = classifyRow(row);
        const characterName = String(row.character_name || '').trim() || 'Personagem em avaliação';
        return {
            id: `spell-review:${row.id}`,
            category: 'spell_review',
            priority: classification.priority,
            title: `${characterName} · revisão de feitiço`,
            summary: classification.summary,
            status: classification.status,
            reference: String(row.id),
            updatedAt: row.held_at || row.called_at || row.requested_at,
            actionPath: `/admin/jogadores/${encodeURIComponent(String(row.player_id || ''))}`,
            metadata: {
                queueId: Number(row.id),
                holdReason: row.hold_reason || null,
            },
        };
    });

    return {
        items,
        flow: {
            capacity: settings.capacity,
            autoFlow: settings.autoFlow,
            active,
            pending,
            waiting,
            vacancies: Math.max(0, settings.capacity - active),
        },
    };
}

module.exports = {
    AUTO_FLOW_SETTING_KEY,
    CAPACITY_SETTING_KEY,
    DEFAULT_CAPACITY,
    getAdminSpellReviewInboxReadModel,
};
