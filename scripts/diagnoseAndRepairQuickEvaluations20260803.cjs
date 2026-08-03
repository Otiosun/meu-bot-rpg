'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const SERVICE_PATH = path.join(ROOT, 'helpers', 'clover', 'quickEvaluationService.js');
const BACKUP_DIR = path.join(ROOT, 'backups');
const CONFIRMATION = 'CORRIGIR-FLUXO-AVALIACAO-2026-08-03';
const RECEIPT_MARKER = "text: renderQuickEvaluationSuccess(result),";

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const confirmArg = argv.find((arg) => arg.startsWith('--confirm='));
    const confirmation = confirmArg ? confirmArg.slice('--confirm='.length) : null;
    if (apply && confirmation !== CONFIRMATION) {
        throw new Error(`Aplicacao bloqueada. Use --apply --confirm=${CONFIRMATION}`);
    }
    return { apply };
}

function timestamp() {
    return new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function safeAll(db, sql, params = []) {
    try {
        return await db.all(sql, params);
    } catch (error) {
        return [{ __error: error?.message || String(error) }];
    }
}

async function safeGet(db, sql, params = []) {
    try {
        return await db.get(sql, params);
    } catch (error) {
        return { __error: error?.message || String(error) };
    }
}

function line(char = '=', width = 68) {
    console.log(char.repeat(width));
}

function showRows(rows, formatter, emptyText = 'Nenhum registro.') {
    if (!rows?.length) {
        console.log(emptyText);
        return;
    }
    for (const row of rows) {
        if (row.__error) {
            console.log(`[ERRO SQL] ${row.__error}`);
            continue;
        }
        console.log(formatter(row));
    }
}

async function inspectPermissions(db, evaluatorIds) {
    const results = [];
    let hasAccessPermission = null;
    try {
        ({ hasAccessPermission } = require('../helpers/clover/accessControlService'));
    } catch (error) {
        return evaluatorIds.map((id) => ({
            evaluator_id: id,
            allowed: null,
            error: `nao consegui carregar accessControlService: ${error.message}`,
        }));
    }

    for (const evaluatorId of evaluatorIds) {
        try {
            const allowed = await hasAccessPermission(db, evaluatorId, 'evaluation.apply');
            results.push({ evaluator_id: evaluatorId, allowed });
        } catch (error) {
            results.push({ evaluator_id: evaluatorId, allowed: null, error: error?.message || String(error) });
        }
    }
    return results;
}

async function diagnoseDatabase() {
    if (!fs.existsSync(DB_PATH)) throw new Error(`Banco nao encontrado: ${DB_PATH}`);

    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');

        line();
        console.log('DIAGNOSTICO DE AVALIACOES RAPIDAS — SOMENTE LEITURA');
        line();

        const requiredTables = [
            'clover_quick_evaluations',
            'clover_ph_ledger',
            'clover_character_stats',
            'jogadores',
        ];
        const tableState = {};
        for (const table of requiredTables) tableState[table] = await tableExists(db, table);
        for (const [table, exists] of Object.entries(tableState)) {
            console.log(`${exists ? '[OK]' : '[AUSENTE]'} ${table}`);
        }

        if (!tableState.clover_quick_evaluations) {
            console.log('VEREDITO: a tabela principal de avaliacoes nao existe no banco vivo.');
            return { critical: true, total: 0, recent: [], anomalies: [] };
        }

        const totals = await safeGet(db, `
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN datetime(created_at) >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS last_24h,
                SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last_7d,
                MAX(created_at) AS latest_at
            FROM clover_quick_evaluations
        `);

        console.log('');
        console.log(`Avaliacoes totais: ${Number(totals?.total || 0)}`);
        console.log(`Ultimas 24h: ${Number(totals?.last_24h || 0)}`);
        console.log(`Ultimos 7 dias: ${Number(totals?.last_7d || 0)}`);
        console.log(`Ultima gravacao: ${totals?.latest_at || '-'}`);

        const recent = await safeAll(db, `
            SELECT
                e.id,
                e.player_id,
                COALESCE(NULLIF(j.personagem_nome, ''), NULLIF(j.nome, ''), e.player_id) AS player_name,
                e.evaluator_id,
                e.modality_key,
                e.modality_label,
                e.ph_amount,
                e.week_key,
                e.scene_sent_at,
                e.created_at,
                s.ph_available,
                s.ph_accumulated,
                (
                    SELECT l.id
                    FROM clover_ph_ledger l
                    WHERE l.source = 'ficha_avaliacao'
                      AND l.related_id = 'quick_eval:' || e.id
                    ORDER BY l.id DESC
                    LIMIT 1
                ) AS ledger_id,
                (
                    SELECT l.amount
                    FROM clover_ph_ledger l
                    WHERE l.source = 'ficha_avaliacao'
                      AND l.related_id = 'quick_eval:' || e.id
                    ORDER BY l.id DESC
                    LIMIT 1
                ) AS ledger_amount
            FROM clover_quick_evaluations e
            LEFT JOIN jogadores j ON j.id = e.player_id
            LEFT JOIN clover_character_stats s ON s.player_id = e.player_id
            ORDER BY e.id DESC
            LIMIT 30
        `);

        line('-');
        console.log('ULTIMAS AVALIACOES');
        line('-');
        showRows(recent, (row) => {
            const ph = Number(row.ph_amount || 0);
            const ledgerOk = ph <= 0
                ? 'PH N/A'
                : (row.ledger_id && Number(row.ledger_amount) === ph
                    ? `ledger #${row.ledger_id} OK`
                    : `LEDGER FALHO (${row.ledger_id || 'ausente'} / ${row.ledger_amount ?? '-'})`);
            return `#${row.id} | ${row.player_name} | ${row.modality_label || row.modality_key} | +${ph} PH | ${ledgerOk} | semana ${row.week_key || '-'} | ${row.created_at}`;
        });

        const missingLedgers = tableState.clover_ph_ledger
            ? await safeAll(db, `
                SELECT e.id, e.player_id, e.evaluator_id, e.modality_key, e.ph_amount, e.created_at
                FROM clover_quick_evaluations e
                LEFT JOIN clover_ph_ledger l
                  ON l.source = 'ficha_avaliacao'
                 AND l.related_id = 'quick_eval:' || e.id
                WHERE e.ph_amount > 0
                GROUP BY e.id
                HAVING COUNT(l.id) = 0
                ORDER BY e.id DESC
                LIMIT 100
            `)
            : [];

        const amountMismatches = tableState.clover_ph_ledger
            ? await safeAll(db, `
                SELECT
                    e.id,
                    e.player_id,
                    e.ph_amount,
                    SUM(CASE WHEN l.kind = 'ganho' THEN ABS(l.amount) ELSE 0 END) AS ledger_total,
                    e.created_at
                FROM clover_quick_evaluations e
                JOIN clover_ph_ledger l
                  ON l.source = 'ficha_avaliacao'
                 AND l.related_id = 'quick_eval:' || e.id
                WHERE e.ph_amount > 0
                GROUP BY e.id
                HAVING SUM(CASE WHEN l.kind = 'ganho' THEN ABS(l.amount) ELSE 0 END) <> e.ph_amount
                ORDER BY e.id DESC
                LIMIT 100
            `)
            : [];

        const orphanLedgers = tableState.clover_ph_ledger
            ? await safeAll(db, `
                SELECT l.id, l.player_id, l.amount, l.related_id, l.created_at
                FROM clover_ph_ledger l
                LEFT JOIN clover_quick_evaluations e
                  ON 'quick_eval:' || e.id = l.related_id
                WHERE l.source = 'ficha_avaliacao'
                  AND l.related_id LIKE 'quick_eval:%'
                  AND e.id IS NULL
                ORDER BY l.id DESC
                LIMIT 100
            `)
            : [];

        const missingStats = tableState.clover_character_stats
            ? await safeAll(db, `
                SELECT DISTINCT e.player_id
                FROM clover_quick_evaluations e
                LEFT JOIN clover_character_stats s ON s.player_id = e.player_id
                WHERE e.ph_amount > 0
                  AND s.player_id IS NULL
                ORDER BY e.player_id
            `)
            : [];

        line('-');
        console.log('INTEGRIDADE');
        line('-');
        console.log(`Avaliacoes com PH sem ledger: ${missingLedgers.length}`);
        console.log(`Avaliacoes com valor divergente: ${amountMismatches.length}`);
        console.log(`Ledgers orfaos sem avaliacao: ${orphanLedgers.length}`);
        console.log(`Players avaliados sem stats: ${missingStats.length}`);

        showRows(missingLedgers.slice(0, 20), (row) => (
            `  [SEM LEDGER] avaliacao #${row.id} | player ${row.player_id} | +${row.ph_amount} PH | ${row.created_at}`
        ), 'Nenhuma avaliacao sem ledger.');
        showRows(amountMismatches.slice(0, 20), (row) => (
            `  [DIVERGENTE] avaliacao #${row.id} | ficha +${row.ph_amount} | ledger +${row.ledger_total}`
        ), 'Nenhuma divergencia de valor.');
        showRows(orphanLedgers.slice(0, 20), (row) => (
            `  [ORFAO] ledger #${row.id} | ${row.player_id} | ${row.related_id} | +${row.amount}`
        ), 'Nenhum ledger orfao.');

        const evaluatorIds = [...new Set(recent
            .filter((row) => !row.__error)
            .map((row) => row.evaluator_id)
            .filter(Boolean))];
        const permissionResults = await inspectPermissions(db, evaluatorIds);

        line('-');
        console.log('PERMISSAO DOS AVALIADORES RECENTES');
        line('-');
        showRows(permissionResults, (row) => (
            `${row.allowed === true ? '[OK]' : row.allowed === false ? '[NEGADO]' : '[ERRO]'} ${row.evaluator_id}${row.error ? ` | ${row.error}` : ''}`
        ), 'Nenhum avaliador recente para testar.');

        const canonicalGrants = await tableExists(db, 'clover_role_grants')
            ? await safeAll(db, `
                SELECT id, subject_id, role_key, scope_type, scope_key, status, valid_from, valid_until
                FROM clover_role_grants
                WHERE status = 'active'
                  AND role_key IN ('owner', 'admin', 'evaluator')
                ORDER BY role_key, subject_id, id
            `)
            : [];
        const legacyAccess = await tableExists(db, 'clover_access_roles')
            ? await safeAll(db, 'SELECT * FROM clover_access_roles ORDER BY subject_id, id')
            : [];
        const legacyAdmin = await tableExists(db, 'clover_admin_roles')
            ? await safeAll(db, 'SELECT * FROM clover_admin_roles ORDER BY player_id, id')
            : [];

        console.log('');
        console.log(`Grants canonicos ativos de avaliacao/admin: ${canonicalGrants.length}`);
        showRows(canonicalGrants, (row) => (
            `  #${row.id} ${row.subject_id} | ${row.role_key} | ${row.scope_type}:${row.scope_key} | ${row.status}`
        ));
        console.log(`Registros legados de acesso: ${legacyAccess.length}`);
        console.log(`Registros legados de ADM: ${legacyAdmin.length}`);

        const anomalies = [
            ...missingLedgers.map((row) => ({ type: 'missing_ledger', ...row })),
            ...amountMismatches.map((row) => ({ type: 'amount_mismatch', ...row })),
            ...orphanLedgers.map((row) => ({ type: 'orphan_ledger', ...row })),
            ...missingStats.map((row) => ({ type: 'missing_stats', ...row })),
        ];

        line();
        if (anomalies.length) {
            console.log('VEREDITO: HA INCONSISTENCIA REAL ENTRE AVALIACAO, LEDGER OU STATS.');
        } else if (Number(totals?.last_7d || 0) === 0) {
            console.log('VEREDITO: NENHUMA AVALIACAO FOI GRAVADA NOS ULTIMOS 7 DIAS.');
            console.log('A falha esta antes do commit: permissao, reconhecimento da ficha, grupo ON ou alvo.');
        } else {
            console.log('VEREDITO: AS AVALIACOES RECENTES ESTAO GRAVADAS E O PH ESTA NO LEDGER.');
            console.log('O defeito confirmado e a ausencia do recibo visivel de sucesso.');
        }
        line();

        return { critical: anomalies.length > 0, totals, recent, anomalies, permissionResults };
    } finally {
        await db.close();
    }
}

function buildPatchedService(original) {
    if (original.includes(RECEIPT_MARKER)) {
        return { text: original, alreadyPatched: true };
    }

    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const needle = "        await sendReaction({ sock, idChat, m, emoji: '✅' }).catch(() => null);";
    const index = original.indexOf(needle);
    if (index < 0) throw new Error('Nao encontrei o ponto exato do recibo de avaliacao.');
    if (original.indexOf(needle, index + needle.length) >= 0) {
        throw new Error('Ponto de patch ambiguo: mais de uma reacao de sucesso encontrada.');
    }

    const replacement = [
        '        await sendReply({',
        '            sock,',
        '            idChat,',
        '            m,',
        '            text: renderQuickEvaluationSuccess(result),',
        '            mentions: [result.player.id],',
        '        });',
        needle,
    ].join(eol);

    const text = original.slice(0, index) + replacement + original.slice(index + needle.length);
    if (!text.includes(RECEIPT_MARKER)) throw new Error('Patch incompleto: recibo nao foi inserido.');
    return { text, alreadyPatched: false };
}

function syntaxCheck() {
    const result = spawnSync(process.execPath, ['--check', SERVICE_PATH], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
        throw new Error(result.error?.message || result.stderr || result.stdout || 'Erro de sintaxe desconhecido.');
    }
}

async function main() {
    const { apply } = parseArgs(process.argv.slice(2));
    const diagnosis = await diagnoseDatabase();

    if (!fs.existsSync(SERVICE_PATH)) throw new Error(`Servico nao encontrado: ${SERVICE_PATH}`);
    const original = fs.readFileSync(SERVICE_PATH, 'utf8');
    const patched = buildPatchedService(original);

    console.log('');
    line();
    console.log('CORRECAO DO RECIBO DE AVALIACAO');
    line();
    console.log(`Estado: ${patched.alreadyPatched ? 'ja instalado' : 'pronto para instalar'}`);
    console.log('Efeito: apos commit, o grupo recebe AVALIACAO APLICADA com saldos e checklist.');
    console.log('Banco: nenhuma linha sera alterada por este patch.');
    line();

    if (!apply) {
        console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
        return;
    }

    if (diagnosis.critical) {
        throw new Error('Aplicacao bloqueada: o diagnostico encontrou inconsistencia real no banco. Corrija os dados antes do patch visual.');
    }

    if (patched.alreadyPatched) {
        syntaxCheck();
        console.log('APLICACAO CONCLUIDA. O recibo ja estava instalado e a sintaxe esta valida.');
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `quickEvaluationService.before-receipt-${timestamp()}.js`);
    fs.copyFileSync(SERVICE_PATH, backupPath);
    fs.writeFileSync(SERVICE_PATH, patched.text, 'utf8');

    try {
        syntaxCheck();
    } catch (error) {
        fs.copyFileSync(backupPath, SERVICE_PATH);
        throw new Error(`Patch revertido por erro de sintaxe: ${error.message}`);
    }

    line();
    console.log('APLICACAO CONCLUIDA');
    console.log(`Backup: ${backupPath}`);
    console.log('Recibo completo de avaliacao: instalado');
    console.log('Banco: preservado');
    line();
}

main().catch((error) => {
    console.error(`FALHA: ${error?.stack || error}`);
    process.exitCode = 1;
});
