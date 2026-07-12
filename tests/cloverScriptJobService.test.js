const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverScriptSchema } = require('../helpers/clover/cloverScriptService');
const {
    countPlanActions,
    enqueueCloverScriptJob,
    ensureCloverScriptJobSchema,
    getJobByCode,
    inspectSimulationForJob,
    isStaleRunning,
    listCloverScriptJobs,
    processCloverScriptJob,
} = require('../helpers/clover/cloverScriptJobService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureCloverScriptSchema(db);
    await ensureCloverScriptJobSchema(db);
    return db;
}

function plan(targets = 10, actions = 2, kind = 'standard') {
    return {
        kind,
        header: { id: 'job-test', mode: 'rigido' },
        blocks: [{
            targets: Array.from({ length: targets }, (_, index) => ({ id: `p${index}@lid` })),
            actions: Array.from({ length: actions }, (_, index) => ({ type: `action_${index}` })),
        }],
    };
}

async function insertSimulation(db, {
    code = 'CS-ABC123',
    actorId = 'owner@lid',
    chatId = 'admin@g.us',
    savedPlan = plan(),
    metadata = {},
} = {}) {
    const result = await db.run(
        `INSERT INTO clover_script_runs
         (code, batch_id, batch_name, mode, script_hash, script_text, plan_json,
          status, created_by, chat_id, created_at, metadata_json)
         VALUES (?, 'job-test', 'Job test', 'rigido', 'hash', 'script', ?,
                 'simulated', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [code, JSON.stringify(savedPlan), actorId, chatId, JSON.stringify(metadata)]
    );
    return result.lastID;
}

test('conta ações e decide fila automática pelo limite', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await insertSimulation(db, { savedPlan: plan(10, 2) });

    assert.equal(countPlanActions(plan(10, 2)), 20);
    const inspection = await inspectSimulationForJob(db, {
        code: 'CS-ABC123',
        actorId: 'owner@lid',
        chatId: 'admin@g.us',
    });

    assert.equal(inspection.ok, true);
    assert.equal(inspection.totalActions, 20);
    assert.equal(inspection.shouldQueue, true);
    assert.equal(inspection.lifecycle, false);
});

test('persiste job antes de executar e bloqueia duplicata do mesmo run', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await insertSimulation(db);

    const first = await enqueueCloverScriptJob(db, {
        code: 'CS-ABC123',
        actorId: 'owner@lid',
        chatId: 'admin@g.us',
    });
    const second = await enqueueCloverScriptJob(db, {
        code: 'CS-ABC123',
        actorId: 'owner@lid',
        chatId: 'admin@g.us',
    });

    assert.equal(first.ok, true);
    assert.match(first.job.code, /^JOB-/);
    assert.equal(first.job.status, 'queued');
    assert.equal(first.job.total_actions, 20);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.job.code, first.job.code);

    const jobs = await listCloverScriptJobs(db, { actorId: 'owner@lid' });
    assert.equal(jobs.length, 1);
});

test('processa job, salva resultado e continua concluído mesmo se notificação falhar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await insertSimulation(db, { savedPlan: plan(2, 2) });

    const queued = await enqueueCloverScriptJob(db, {
        code: 'CS-ABC123',
        actorId: 'owner@lid',
        chatId: 'admin@g.us',
        force: true,
    });

    const fakeSock = {
        sendMessage: async () => {
            throw new Error('WhatsApp offline');
        },
    };
    const processed = await processCloverScriptJob(db, queued.job.code, {
        sock: fakeSock,
        executeStandard: async () => ({
            ok: true,
            text: 'resultado final persistido',
            results: [
                { ok: true },
                { ok: true },
                { ok: true },
                { ok: true },
            ],
        }),
    });

    assert.equal(processed.ok, true);
    const job = await getJobByCode(db, queued.job.code, { allowAll: true });
    assert.equal(job.status, 'completed');
    assert.equal(job.completed_actions, 4);
    assert.equal(job.failed_actions, 0);
    assert.equal(job.final_text, 'resultado final persistido');
    assert.match(job.notification_error, /WhatsApp offline/);
});

test('falha do executor fica persistida e não permite repetição cega', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await insertSimulation(db, { savedPlan: plan(1, 1) });

    const queued = await enqueueCloverScriptJob(db, {
        code: 'CS-ABC123',
        actorId: 'owner@lid',
        chatId: 'admin@g.us',
        force: true,
    });
    const processed = await processCloverScriptJob(db, queued.job.code, {
        executeStandard: async () => {
            throw new Error('falha controlada');
        },
    });

    assert.equal(processed.ok, false);
    const job = await getJobByCode(db, queued.job.code, { allowAll: true });
    assert.equal(job.status, 'failed');
    assert.match(job.error, /falha controlada/);

    const repeated = await processCloverScriptJob(db, queued.job.code, {
        executeStandard: async () => ({ ok: true }),
    });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.code, 'job_failed');
});

test('identifica job running sem atualização como possivelmente interrompido', () => {
    assert.equal(isStaleRunning({
        status: 'running',
        updated_at: '2026-07-12 10:00:00',
    }, new Date('2026-07-12T10:31:00Z')), true);

    assert.equal(isStaleRunning({
        status: 'running',
        updated_at: '2026-07-12 10:20:00',
    }, new Date('2026-07-12T10:31:00Z')), false);
});

test('reconhece jobs de ciclo de vida pelo plano e código', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await insertSimulation(db, {
        code: 'CSL-ABC123',
        savedPlan: plan(1, 1, 'lifecycle'),
        metadata: { source: 'cloverscript_lifecycle' },
    });

    const inspection = await inspectSimulationForJob(db, {
        code: 'CSL-ABC123',
        actorId: 'owner@lid',
        chatId: 'admin@g.us',
        force: true,
    });
    assert.equal(inspection.ok, true);
    assert.equal(inspection.lifecycle, true);
});
