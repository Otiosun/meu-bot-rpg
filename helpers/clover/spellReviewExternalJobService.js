'use strict';

const MAX_ATTEMPTS = 8;
const STALE_RUNNING_MINUTES = 5;

async function ensureSpellReviewExternalJobSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_spell_review_external_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_key TEXT NOT NULL UNIQUE,
            job_type TEXT NOT NULL,
            player_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            claimed_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CHECK (job_type IN ('remove_participant', 'fill_capacity')),
            CHECK (status IN ('pending', 'running', 'failed', 'done', 'cancelled'))
        );
        CREATE INDEX IF NOT EXISTS idx_clover_spell_review_external_jobs_open
            ON clover_spell_review_external_jobs(status, available_at, id);
        CREATE INDEX IF NOT EXISTS idx_clover_spell_review_external_jobs_player
            ON clover_spell_review_external_jobs(player_id, status, id);
    `);
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function mapJob(row) {
    if (!row) return null;
    return {
        id: Number(row.id || 0),
        key: row.job_key,
        type: row.job_type,
        playerId: row.player_id || null,
        status: row.status,
        attempts: Number(row.attempts || 0),
        availableAt: row.available_at || null,
        claimedAt: row.claimed_at || null,
        completedAt: row.completed_at || null,
        lastError: row.last_error || null,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

function normalizeJob(input = {}) {
    const key = String(input.key || input.jobKey || '').trim().slice(0, 240);
    const type = String(input.type || input.jobType || '').trim().toLowerCase();
    const playerId = String(input.playerId || '').trim() || null;
    if (!key) {
        const error = new Error('Job externo sem chave idempotente.');
        error.code = 'external_job_key_required';
        throw error;
    }
    if (!['remove_participant', 'fill_capacity'].includes(type)) {
        const error = new Error('Tipo de job externo inválido.');
        error.code = 'invalid_external_job_type';
        throw error;
    }
    if (type === 'remove_participant' && !playerId) {
        const error = new Error('Remoção externa exige jogador.');
        error.code = 'external_job_player_required';
        throw error;
    }
    return {
        key,
        type,
        playerId,
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
}

async function enqueueSpellReviewExternalJob(db, input = {}) {
    await ensureSpellReviewExternalJobSchema(db);
    const job = normalizeJob(input);
    await db.run(
        `INSERT INTO clover_spell_review_external_jobs
         (job_key, job_type, player_id, status, attempts, available_at, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(job_key) DO NOTHING`,
        [job.key, job.type, job.playerId, JSON.stringify(job.metadata)]
    );
    return mapJob(await db.get(
        'SELECT * FROM clover_spell_review_external_jobs WHERE job_key = ?',
        [job.key]
    ));
}

async function enqueueSpellReviewPostCommitJobs(db, { operationCode, playerId, actorId } = {}) {
    const code = String(operationCode || '').trim();
    const player = String(playerId || '').trim();
    if (!code || !player) {
        const error = new Error('Operação e jogador são obrigatórios para efeitos externos.');
        error.code = 'external_job_context_required';
        throw error;
    }
    const common = { operationCode: code, actorId: actorId || null, source: 'admin-operation' };
    const removal = await enqueueSpellReviewExternalJob(db, {
        key: `spell-review:${code}:remove-participant`,
        type: 'remove_participant',
        playerId: player,
        metadata: common,
    });
    const fill = await enqueueSpellReviewExternalJob(db, {
        key: `spell-review:${code}:fill-capacity`,
        type: 'fill_capacity',
        metadata: { ...common, excludePlayerIds: [player], force: false, rotate: true },
    });
    return [removal, fill];
}

async function enqueueManualFillJob(db, { operationCode, actorId, force = true } = {}) {
    const code = String(operationCode || '').trim();
    if (!code) {
        const error = new Error('Operação é obrigatória para solicitar preenchimento.');
        error.code = 'external_job_context_required';
        throw error;
    }
    return enqueueSpellReviewExternalJob(db, {
        key: `spell-review:${code}:manual-fill`,
        type: 'fill_capacity',
        metadata: {
            operationCode: code,
            actorId: actorId || null,
            source: 'admin-operation',
            force: Boolean(force),
            rotate: true,
            excludePlayerIds: [],
        },
    });
}

async function listSpellReviewExternalJobs(db, options = {}) {
    await ensureSpellReviewExternalJobSchema(db);
    const statuses = Array.isArray(options.statuses) && options.statuses.length
        ? options.statuses.filter((value) => ['pending', 'running', 'failed', 'done', 'cancelled'].includes(value))
        : ['pending', 'running', 'failed'];
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const limit = Math.max(1, Math.min(200, Number(options.limit || 100)));
    const rows = await db.all(
        `SELECT * FROM clover_spell_review_external_jobs
         WHERE status IN (${placeholders})
         ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
                  available_at ASC, id ASC
         LIMIT ?`,
        [...statuses, limit]
    );
    return rows.map(mapJob);
}

async function claimNextSpellReviewExternalJob(db) {
    await ensureSpellReviewExternalJobSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_spell_review_external_jobs
             SET status = 'failed',
                 last_error = COALESCE(last_error, 'claim expirado recuperado automaticamente'),
                 available_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE status = 'running'
               AND claimed_at IS NOT NULL
               AND claimed_at <= datetime(CURRENT_TIMESTAMP, '-' || ? || ' minutes')`,
            [STALE_RUNNING_MINUTES]
        );
        const row = await db.get(
            `SELECT * FROM clover_spell_review_external_jobs
             WHERE status IN ('pending', 'failed')
               AND attempts < ?
               AND datetime(available_at) <= CURRENT_TIMESTAMP
             ORDER BY CASE status WHEN 'failed' THEN 0 ELSE 1 END, available_at ASC, id ASC
             LIMIT 1`,
            [MAX_ATTEMPTS]
        );
        if (!row) {
            await db.exec('COMMIT');
            return null;
        }
        const updated = await db.run(
            `UPDATE clover_spell_review_external_jobs
             SET status = 'running', attempts = attempts + 1,
                 claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('pending', 'failed')`,
            [row.id]
        );
        if (!Number(updated?.changes || 0)) {
            await db.exec('COMMIT');
            return null;
        }
        const claimed = await db.get('SELECT * FROM clover_spell_review_external_jobs WHERE id = ?', [row.id]);
        await db.exec('COMMIT');
        return mapJob(claimed);
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function completeSpellReviewExternalJob(db, jobId, result = {}) {
    await ensureSpellReviewExternalJobSchema(db);
    await db.run(
        `UPDATE clover_spell_review_external_jobs
         SET status = 'done', completed_at = CURRENT_TIMESTAMP,
             claimed_at = NULL, last_error = NULL,
             metadata_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'running'`,
        [JSON.stringify({ ...(result.metadata || {}), result: result.result ?? result }), jobId]
    );
    return mapJob(await db.get('SELECT * FROM clover_spell_review_external_jobs WHERE id = ?', [jobId]));
}

async function failSpellReviewExternalJob(db, jobId, error) {
    await ensureSpellReviewExternalJobSchema(db);
    const row = await db.get('SELECT attempts FROM clover_spell_review_external_jobs WHERE id = ?', [jobId]);
    const attempts = Number(row?.attempts || 1);
    const delaySeconds = Math.min(900, Math.max(30, 30 * (2 ** Math.max(0, attempts - 1))));
    const message = String(error?.message || error || 'falha externa desconhecida').slice(0, 1200);
    await db.run(
        `UPDATE clover_spell_review_external_jobs
         SET status = 'failed', claimed_at = NULL,
             last_error = ?,
             available_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'running'`,
        [message, delaySeconds, jobId]
    );
    return mapJob(await db.get('SELECT * FROM clover_spell_review_external_jobs WHERE id = ?', [jobId]));
}

async function cancelSpellReviewExternalJobs(db, jobIds = []) {
    await ensureSpellReviewExternalJobSchema(db);
    const ids = [...new Set(jobIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const blocked = await db.all(
        `SELECT id, status FROM clover_spell_review_external_jobs
         WHERE id IN (${placeholders}) AND status NOT IN ('pending', 'failed', 'cancelled')`,
        ids
    );
    if (blocked.length) {
        const error = new Error('Um efeito externo já começou ou terminou; o undo automático foi bloqueado.');
        error.code = 'spell_external_effect_already_started';
        error.details = { jobs: blocked.map((row) => ({ id: Number(row.id), status: row.status })) };
        throw error;
    }
    await db.run(
        `UPDATE clover_spell_review_external_jobs
         SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
             claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND status IN ('pending', 'failed')`,
        ids
    );
    const rows = await db.all(
        `SELECT * FROM clover_spell_review_external_jobs WHERE id IN (${placeholders}) ORDER BY id`,
        ids
    );
    return rows.map(mapJob);
}

module.exports = {
    MAX_ATTEMPTS,
    STALE_RUNNING_MINUTES,
    cancelSpellReviewExternalJobs,
    claimNextSpellReviewExternalJob,
    completeSpellReviewExternalJob,
    enqueueManualFillJob,
    enqueueSpellReviewExternalJob,
    enqueueSpellReviewPostCommitJobs,
    ensureSpellReviewExternalJobSchema,
    failSpellReviewExternalJob,
    listSpellReviewExternalJobs,
    mapJob,
};