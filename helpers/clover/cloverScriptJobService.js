const crypto = require('crypto');

const { ensureCloverScriptSchema } = require('./cloverScriptService');

const JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const DEFAULT_ASYNC_THRESHOLD = 20;
const STALE_RUNNING_MINUTES = 30;

function generateJobCode() {
    return `JOB-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function serialize(value) {
    return JSON.stringify(value ?? null);
}

function countPlanActions(plan) {
    let total = 0;
    for (const block of plan?.blocks || []) {
        total += (block.targets || []).length * (block.actions || []).length;
    }
    return total;
}

function parseSqliteDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
        ? `${text.replace(' ', 'T')}Z`
        : text;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}

function isStaleRunning(job, now = new Date()) {
    if (job?.status !== 'running') return false;
    const updated = parseSqliteDate(job.updated_at || job.started_at || job.created_at);
    if (!updated) return false;
    return now.getTime() - updated.getTime() >= STALE_RUNNING_MINUTES * 60 * 1000;
}

async function ensureCloverScriptJobSchema(db) {
    await ensureCloverScriptSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_script_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            run_id INTEGER NOT NULL UNIQUE,
            simulation_code TEXT NOT NULL,
            actor_id TEXT DEFAULT NULL,
            chat_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
            total_actions INTEGER NOT NULL DEFAULT 0,
            completed_actions INTEGER NOT NULL DEFAULT 0,
            failed_actions INTEGER NOT NULL DEFAULT 0,
            lifecycle INTEGER NOT NULL DEFAULT 0,
            result_json TEXT DEFAULT NULL,
            final_text TEXT DEFAULT NULL,
            error TEXT DEFAULT NULL,
            notification_error TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_clover_script_jobs_actor_created
        ON clover_script_jobs (actor_id, created_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_clover_script_jobs_status
        ON clover_script_jobs (status, updated_at, id);
    `);
}

async function findSimulationRun(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureCloverScriptSchema(db);
    if (code) {
        return db.get(
            'SELECT * FROM clover_script_runs WHERE code = ?',
            [String(code).trim().toUpperCase()]
        );
    }
    return db.get(
        `SELECT *
         FROM clover_script_runs
         WHERE status = 'simulated'
           AND created_by = ?
           AND chat_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [actorId || null, chatId || null]
    );
}

function isLifecycleRun(run) {
    if (!run) return false;
    if (String(run.code || '').toUpperCase().startsWith('CSL-')) return true;
    const metadata = safeJsonParse(run.metadata_json, {});
    const plan = safeJsonParse(run.plan_json, {});
    return metadata?.source === 'cloverscript_lifecycle' || plan?.kind === 'lifecycle';
}

async function inspectSimulationForJob(db, {
    code = null,
    actorId = null,
    chatId = null,
    force = false,
    threshold = DEFAULT_ASYNC_THRESHOLD,
} = {}) {
    const run = await findSimulationRun(db, { code, actorId, chatId });
    if (!run) return { ok: false, code: 'missing_simulation', error: 'Simulação pendente não encontrada.' };
    if (run.status !== 'simulated') {
        return { ok: false, code: 'invalid_run_status', error: `Simulação está como ${run.status}.`, run };
    }

    const plan = safeJsonParse(run.plan_json, null);
    if (!plan) return { ok: false, code: 'invalid_plan', error: 'Plano salvo está inválido.', run };
    const totalActions = countPlanActions(plan);
    const lifecycle = isLifecycleRun(run);
    const normalizedThreshold = Math.max(1, Number(threshold || DEFAULT_ASYNC_THRESHOLD));

    return {
        ok: true,
        run,
        plan,
        totalActions,
        lifecycle,
        shouldQueue: Boolean(force) || totalActions >= normalizedThreshold,
        threshold: normalizedThreshold,
    };
}

async function getJobByCode(db, jobCode, options = {}) {
    await ensureCloverScriptJobSchema(db);
    const code = String(jobCode || '').trim().toUpperCase();
    if (!code) return null;
    const params = [code];
    let sql = 'SELECT * FROM clover_script_jobs WHERE code = ?';
    if (options.actorId && !options.allowAll) {
        sql += ' AND actor_id = ?';
        params.push(options.actorId);
    }
    const row = await db.get(sql, params);
    return row ? hydrateJob(row) : null;
}

async function getJobByRunId(db, runId) {
    await ensureCloverScriptJobSchema(db);
    const row = await db.get(
        'SELECT * FROM clover_script_jobs WHERE run_id = ?',
        [runId]
    );
    return row ? hydrateJob(row) : null;
}

function hydrateJob(row) {
    return {
        ...row,
        result: safeJsonParse(row.result_json, null),
        stale: isStaleRunning(row),
    };
}

async function enqueueCloverScriptJob(db, {
    code = null,
    actorId = null,
    chatId = null,
    force = false,
    threshold = DEFAULT_ASYNC_THRESHOLD,
} = {}) {
    await ensureCloverScriptJobSchema(db);
    const inspection = await inspectSimulationForJob(db, {
        code,
        actorId,
        chatId,
        force,
        threshold,
    });
    if (!inspection.ok) return inspection;

    const existing = await getJobByRunId(db, inspection.run.id);
    if (existing) {
        return {
            ok: true,
            duplicate: true,
            job: existing,
            inspection,
        };
    }

    const jobCode = generateJobCode();
    try {
        const insert = await db.run(
            `INSERT INTO clover_script_jobs
             (code, run_id, simulation_code, actor_id, chat_id, status,
              total_actions, completed_actions, failed_actions, lifecycle,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                jobCode,
                inspection.run.id,
                inspection.run.code,
                actorId || inspection.run.created_by || null,
                chatId || inspection.run.chat_id || null,
                inspection.totalActions,
                inspection.lifecycle ? 1 : 0,
            ]
        );
        const job = await db.get('SELECT * FROM clover_script_jobs WHERE id = ?', [insert.lastID]);
        return { ok: true, duplicate: false, job: hydrateJob(job), inspection };
    } catch (error) {
        const concurrent = await getJobByRunId(db, inspection.run.id);
        if (concurrent) return { ok: true, duplicate: true, job: concurrent, inspection };
        throw error;
    }
}

function countApplyResults(result) {
    const rows = Array.isArray(result?.results) ? result.results : [];
    if (!rows.length) {
        return {
            completed: result?.ok ? 1 : 0,
            failed: result?.ok ? 0 : 1,
        };
    }
    return {
        completed: rows.filter((item) => item?.ok).length,
        failed: rows.filter((item) => !item?.ok).length,
    };
}

async function claimJob(db, jobId) {
    const result = await db.run(
        `UPDATE clover_script_jobs
         SET status = 'running',
             started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP,
             error = NULL
         WHERE id = ?
           AND status = 'queued'`,
        [jobId]
    );
    return Number(result?.changes || 0) > 0;
}

async function notifyJobResult(sock, job, text) {
    if (!sock?.sendMessage || !job.chat_id || !text) return null;
    try {
        await sock.sendMessage(job.chat_id, { text });
        return null;
    } catch (error) {
        return error?.message || String(error);
    }
}

async function processCloverScriptJob(db, jobCode, options = {}) {
    await ensureCloverScriptJobSchema(db);
    const job = await getJobByCode(db, jobCode, { allowAll: true });
    if (!job) return { ok: false, code: 'job_not_found', error: 'Tarefa não encontrada.' };
    if (job.status === 'completed') return { ok: true, alreadyFinished: true, job };
    if (job.status === 'failed' || job.status === 'cancelled') {
        return { ok: false, code: `job_${job.status}`, error: job.error || `Tarefa ${job.status}.`, job };
    }
    if (job.status === 'running') {
        return { ok: false, code: 'job_already_running', error: 'Tarefa já está em execução.', job };
    }

    const claimed = await claimJob(db, job.id);
    if (!claimed) {
        const fresh = await getJobByCode(db, job.code, { allowAll: true });
        return { ok: false, code: 'job_not_claimed', error: 'Tarefa já foi assumida por outro executor.', job: fresh };
    }

    const executeStandard = options.executeStandard || (async (args) => {
        const { applySimulation } = require('./cloverScriptService');
        return applySimulation(db, args);
    });
    const executeLifecycle = options.executeLifecycle || (async (args) => {
        const { applyLifecycleSimulation } = require('./cloverScriptLifecycleService');
        return applyLifecycleSimulation(db, args);
    });

    try {
        const args = {
            code: job.simulation_code,
            actorId: job.actor_id,
            chatId: job.chat_id,
            sock: options.sock || null,
        };
        const result = job.lifecycle
            ? await executeLifecycle(args)
            : await executeStandard(args);
        const counts = countApplyResults(result);
        const successful = Boolean(result?.ok);
        const status = successful ? 'completed' : 'failed';
        const finalText = result?.text || (successful ? 'CloverScript aplicado.' : 'CloverScript terminou com falha.');

        await db.run(
            `UPDATE clover_script_jobs
             SET status = ?,
                 completed_actions = ?,
                 failed_actions = ?,
                 result_json = ?,
                 final_text = ?,
                 error = ?,
                 completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                status,
                counts.completed,
                counts.failed,
                serialize({ ok: successful, result }),
                finalText,
                successful ? null : (result?.error || 'falha durante aplicação'),
                job.id,
            ]
        );

        const fresh = await getJobByCode(db, job.code, { allowAll: true });
        const notificationError = await notifyJobResult(options.sock, fresh, renderJobCompletion(fresh));
        if (notificationError) {
            await db.run(
                `UPDATE clover_script_jobs
                 SET notification_error = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [notificationError, job.id]
            );
        }
        return { ok: successful, job: await getJobByCode(db, job.code, { allowAll: true }), result };
    } catch (error) {
        const message = error?.message || String(error);
        await db.run(
            `UPDATE clover_script_jobs
             SET status = 'failed',
                 failed_actions = CASE WHEN failed_actions > 0 THEN failed_actions ELSE 1 END,
                 error = ?,
                 completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [message, job.id]
        );
        const fresh = await getJobByCode(db, job.code, { allowAll: true });
        const notificationError = await notifyJobResult(options.sock, fresh, renderJobCompletion(fresh));
        if (notificationError) {
            await db.run(
                'UPDATE clover_script_jobs SET notification_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [notificationError, job.id]
            );
        }
        return { ok: false, code: 'job_failed', error: message, job: await getJobByCode(db, job.code, { allowAll: true }) };
    }
}

async function listCloverScriptJobs(db, { actorId = null, allowAll = false, limit = 10 } = {}) {
    await ensureCloverScriptJobSchema(db);
    const params = [];
    let sql = 'SELECT * FROM clover_script_jobs';
    if (actorId && !allowAll) {
        sql += ' WHERE actor_id = ?';
        params.push(actorId);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(Math.max(1, Math.min(30, Number(limit || 10))));
    const rows = await db.all(sql, params);
    return (rows || []).map(hydrateJob);
}

function statusLabel(job) {
    if (job?.stale) return 'possivelmente interrompida';
    const labels = {
        queued: 'na fila',
        running: 'processando',
        completed: 'concluída',
        failed: 'falhou',
        cancelled: 'cancelada',
    };
    return labels[job?.status] || job?.status || '-';
}

function renderJobReceived(job) {
    return [
        '*♧┃TAREFA CLOVER RECEBIDA 𖥔 CLOVER MULTICOLOR*',
        '     ── execução persistida antes de começar ──',
        '',
        `*Código:* ${job.code}`,
        `*Simulação:* ${job.simulation_code}`,
        `*Ações:* ${job.total_actions}`,
        `*Estado:* ${statusLabel(job)}`,
        '',
        `Consulte depois com *.#clover tarefa ${job.code}*.`
    ].join('\n');
}

function renderJobStatus(job) {
    if (!job) return '*♧┃TAREFA CLOVER 𖥔 CLOVER MULTICOLOR*\n\n> Tarefa não encontrada.';
    return [
        '*♧┃TAREFA CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── estado persistido ──',
        '',
        `*Código:* ${job.code}`,
        `*Simulação:* ${job.simulation_code}`,
        `*Estado:* ${statusLabel(job)}`,
        `*Ações previstas:* ${job.total_actions}`,
        `*Aplicadas:* ${job.completed_actions}`,
        `*Falhas:* ${job.failed_actions}`,
        `*Criada em:* ${job.created_at || '-'}`,
        `*Iniciada em:* ${job.started_at || '-'}`,
        `*Finalizada em:* ${job.completed_at || '-'}`,
        job.error ? `*Erro:* ${job.error}` : null,
        job.notification_error ? '*Aviso:* o resultado final não foi entregue automaticamente no WhatsApp.' : null,
        job.stale ? '> A execução ficou sem atualização por mais de 30 minutos. Não repita o lote; confira o histórico antes.' : null,
        job.final_text ? '' : null,
        job.final_text ? '_`─( ◆ )───── Resultado salvo`_' : null,
        job.final_text ? '' : null,
        job.final_text ? job.final_text : null,
    ].filter(Boolean).join('\n');
}

function renderJobCompletion(job) {
    return [
        job.status === 'completed'
            ? '*♧┃TAREFA CLOVER CONCLUÍDA 𖥔 CLOVER MULTICOLOR*'
            : '*♧┃TAREFA CLOVER COM FALHA 𖥔 CLOVER MULTICOLOR*',
        '',
        `*Código:* ${job.code}`,
        `*Simulação:* ${job.simulation_code}`,
        `*Estado:* ${statusLabel(job)}`,
        `*Aplicadas:* ${job.completed_actions}/${job.total_actions}`,
        `*Falhas:* ${job.failed_actions}`,
        job.error ? `*Erro:* ${job.error}` : null,
        '',
        `Use *.#clover tarefa ${job.code}* para ver o resultado persistido.`,
    ].filter(Boolean).join('\n');
}

function renderJobList(jobs) {
    if (!jobs?.length) {
        return '*♧┃TAREFAS CLOVER 𖥔 CLOVER MULTICOLOR*\n\n> Nenhuma tarefa registrada.';
    }
    return [
        '*♧┃TAREFAS CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── execuções recentes ──',
        '',
        ...jobs.map((job) => (
            `*${job.code}* · ${statusLabel(job)}\n> ${job.simulation_code} · ${job.completed_actions}/${job.total_actions} aplicadas`
        )),
    ].join('\n');
}

module.exports = {
    DEFAULT_ASYNC_THRESHOLD,
    JOB_STATUSES,
    STALE_RUNNING_MINUTES,
    countPlanActions,
    enqueueCloverScriptJob,
    ensureCloverScriptJobSchema,
    findSimulationRun,
    getJobByCode,
    inspectSimulationForJob,
    isLifecycleRun,
    isStaleRunning,
    listCloverScriptJobs,
    processCloverScriptJob,
    renderJobList,
    renderJobReceived,
    renderJobStatus,
};
