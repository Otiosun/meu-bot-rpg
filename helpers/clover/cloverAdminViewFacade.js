const base = require('./cloverAdminViewService');

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return text;
}

function parseKv(text) {
    const kv = {};
    const regex = /([A-Za-zÀ-ÿ0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        kv[String(match[1] || '').toLowerCase()] = stripQuotes(match[2]);
    }
    return kv;
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

function compactText(text, limit = 3900) {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 90)}\n\n> Relatório cortado por tamanho. Use uma consulta mais específica.`;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function findRun(db, query) {
    if (!await tableExists(db, 'clover_script_runs')) return null;
    const kv = parseKv(query);
    const raw = kv.codigo || kv.code || kv.id || kv.lote || kv.batch || String(query || '').trim();
    const value = String(raw || '').trim();
    if (!value) return null;
    const upper = value.toUpperCase();
    if (/^(CS|CSL|CSU|CSM|CSR|CSRR)-/.test(upper)) {
        return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [upper]);
    }
    return db.get(
        `SELECT * FROM clover_script_runs
         WHERE batch_id = ?
         ORDER BY id DESC LIMIT 1`,
        [value]
    );
}

async function buildBatchView(db, query) {
    const run = await findRun(db, query);
    if (!run) return { ok: false, error: 'Lote/simulação não encontrado.' };
    const actions = await db.all(
        `SELECT action_type, status, COUNT(*) AS total
         FROM clover_script_actions
         WHERE run_id = ?
         GROUP BY action_type, status
         ORDER BY status, action_type`,
        [run.id]
    ).catch(() => []);
    const recent = await db.all(
        `SELECT player_id, action_type, summary, status, error
         FROM clover_script_actions
         WHERE run_id = ?
         ORDER BY id DESC LIMIT 10`,
        [run.id]
    ).catch(() => []);

    let job = null;
    if (await tableExists(db, 'clover_script_jobs')) {
        job = await db.get('SELECT * FROM clover_script_jobs WHERE run_id = ?', [run.id]);
    }

    const plan = safeJsonParse(run.plan_json, {});
    const planned = (plan.blocks || []).reduce((total, block) => (
        total + ((block.targets || []).length * (block.actions || []).length)
    ), 0);

    return {
        ok: true,
        type: 'batch',
        mentions: recent.map((item) => item.player_id).filter(Boolean),
        text: compactText([
            '*♧┃LOTE CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*',
            '     ── consulta somente leitura ──',
            '',
            `*Código:* ${run.code}`,
            `*Lote:* ${run.batch_id || '-'}`,
            `*Nome:* ${run.batch_name || '-'}`,
            `*Modo:* ${run.mode || '-'}`,
            `*Status:* ${run.status}`,
            `*Ações planejadas:* ${planned}`,
            `*Criado por:* ${run.created_by || '-'}`,
            `*Criado em:* ${run.created_at || '-'}`,
            `*Aplicado por:* ${run.applied_by || '-'}`,
            `*Aplicado em:* ${run.applied_at || '-'}`,
            run.error ? `*Erro:* ${run.error}` : null,
            job ? '' : null,
            job ? '_`─( ⧖ )───── Tarefa`_' : null,
            job ? '' : null,
            job ? `*JOB:* ${job.code}` : null,
            job ? `*Estado:* ${job.status}` : null,
            job ? `*Progresso:* ${job.completed_actions}/${job.total_actions}` : null,
            '',
            '_`─( ◆ )───── Contagem registrada`_',
            '',
            ...(actions.length ? actions.map((item) => `> ${item.status} · ${item.action_type}: ${item.total}`) : ['> Nenhuma ação registrada ainda.']),
            '',
            '_`─( ◇ )───── Últimas ações`_',
            '',
            ...(recent.length ? recent.map((item) => `> ${item.status} · ${item.player_id || '-'} · ${item.summary || item.action_type}${item.error ? ` · ${item.error}` : ''}`) : ['> Nenhuma ação registrada.']),
        ].filter(Boolean).join('\n')),
    };
}

async function createCloverAdminView(db, rest, options = {}) {
    const parsed = base.splitView(rest);
    if (parsed.type === 'batch') return buildBatchView(db, parsed.rest);
    return base.createCloverAdminView(db, rest, options);
}

module.exports = {
    ...base,
    buildBatchView,
    createCloverAdminView,
};
