'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const RECENT_HOURS = 24;

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function safeJson(value, fallback = {}) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function playerName(row = {}) {
    return [row.personagem_nome, row.display_name, row.nome, row.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || row.id || '(sem nome)';
}

function line(char = '=', width = 84) {
    console.log(char.repeat(width));
}

async function tableExists(db, name) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
        [name]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, name) {
    if (!await tableExists(db, name)) return [];
    return db.all(`PRAGMA table_info(${JSON.stringify(name)})`);
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

async function findRoquePlayers(db) {
    const rows = await db.all('SELECT * FROM jogadores');
    return rows.filter((row) => [
        row.personagem_nome,
        row.display_name,
        row.nome,
        row.nome_real,
    ].some((value) => normalizeText(value).includes('roque')));
}

async function readRecentEvaluations(db, playerIds) {
    if (!playerIds.length || !await tableExists(db, 'clover_quick_evaluations')) return [];
    const placeholders = playerIds.map(() => '?').join(', ');
    return db.all(
        `SELECT e.*,
                COALESCE(NULLIF(j.personagem_nome,''), NULLIF(j.display_name,''), NULLIF(j.nome,''), e.player_id) AS player_name
         FROM clover_quick_evaluations e
         LEFT JOIN jogadores j ON j.id = e.player_id
         WHERE e.player_id IN (${placeholders})
           AND datetime(e.created_at) >= datetime('now', ?)
         ORDER BY e.id DESC`,
        [...playerIds, `-${RECENT_HOURS} hours`]
    );
}

async function readRelatedRows(db, tableName, whereSql, params) {
    if (!await tableExists(db, tableName)) return [];
    return safeAll(db, `SELECT * FROM ${tableName} WHERE ${whereSql} ORDER BY id`, params);
}

async function inspectInventoryTables(db, evaluationId, playerId) {
    const tables = await db.all(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type='table'
           AND (lower(name) LIKE '%inventory%' OR lower(name) LIKE '%inventar%')
         ORDER BY name`
    );
    const relatedId = `quick_eval:${evaluationId}`;
    const results = [];

    for (const table of tables) {
        const columns = await tableColumns(db, table.name);
        const names = new Set(columns.map((column) => column.name));
        const clauses = [];
        const params = [];
        if (names.has('related_id')) {
            clauses.push('related_id = ?');
            params.push(relatedId);
        }
        if (names.has('source')) {
            clauses.push("source = 'ficha_avaliacao'");
        }
        if (names.has('player_id')) {
            clauses.push('player_id = ?');
            params.push(playerId);
        }
        if (!names.has('related_id')) continue;

        const where = clauses.length ? clauses.join(' AND ') : '1=0';
        const rows = await safeAll(db, `SELECT * FROM ${table.name} WHERE ${where}`, params);
        if (rows.length && !rows[0]?.__error) {
            results.push({ table: table.name, columns: columns.map((column) => column.name), rows });
        }
    }
    return results;
}

function printRows(title, rows) {
    console.log(`\n${title}: ${rows.length}`);
    for (const row of rows) {
        console.log(JSON.stringify(row, null, 2));
    }
}

async function inspectEvaluation(db, evaluation) {
    const evaluationId = evaluation.id;
    const playerId = evaluation.player_id;
    const relatedId = `quick_eval:${evaluationId}`;
    const rewards = safeJson(evaluation.rewards_json, {});
    const metadata = safeJson(evaluation.metadata_json, {});

    line('-');
    console.log(`AVALIACAO CANDIDATA #${evaluationId}`);
    line('-');
    console.log(`Player: ${evaluation.player_name || playerId} | ${playerId}`);
    console.log(`Criada em: ${evaluation.created_at}`);
    console.log(`Modalidade atual: ${evaluation.modality_label || evaluation.modality_key}`);
    console.log(`PH: ${evaluation.ph_amount || 0}`);
    console.log(`Yulls: ${evaluation.yulls_amount || 0}`);
    console.log(`Estrelas: ${evaluation.stars_amount || 0}`);
    console.log(`Inventario texto: ${evaluation.inventory_text || '-'}`);
    console.log(`Semana: ${evaluation.week_key || '-'}`);
    console.log(`Mensagem: ${evaluation.message_key || '-'}`);
    console.log(`Cena citada: ${evaluation.quoted_message_key || '-'}`);
    console.log(`Rewards JSON: ${JSON.stringify(rewards)}`);
    console.log(`Metadata JSON: ${JSON.stringify(metadata)}`);

    const phRows = await readRelatedRows(
        db,
        'clover_ph_ledger',
        'player_id = ? AND related_id = ?',
        [playerId, relatedId]
    );
    const yullsRows = await readRelatedRows(
        db,
        'clover_yulls_ledger',
        'player_id = ? AND related_id = ?',
        [playerId, relatedId]
    );
    const squadRows = await readRelatedRows(
        db,
        'clover_squad_star_ledger',
        'player_id = ? AND evaluation_id = ?',
        [playerId, evaluationId]
    );
    const inventory = await inspectInventoryTables(db, evaluationId, playerId);
    const stats = await safeGet(
        db,
        'SELECT * FROM clover_character_stats WHERE player_id = ?',
        [playerId]
    );
    const player = await safeGet(db, 'SELECT * FROM jogadores WHERE id = ?', [playerId]);

    printRows('Ledger PH ligado', phRows);
    printRows('Ledger Yulls ligado', yullsRows);
    printRows('Ledger de estrelas do esquadrao', squadRows);

    console.log(`\nTabelas de inventario ligadas: ${inventory.length}`);
    for (const entry of inventory) {
        console.log(`\n[TABELA ${entry.table}]`);
        for (const row of entry.rows) console.log(JSON.stringify(row, null, 2));
    }

    console.log('\nStats atuais:');
    console.log(JSON.stringify(stats, null, 2));
    console.log('\nJogador atual (campos relevantes):');
    console.log(JSON.stringify({
        id: player?.id,
        personagem_nome: player?.personagem_nome,
        estrelas: player?.estrelas,
        dinheiro: player?.dinheiro,
        esquadrao: player?.esquadrao,
    }, null, 2));

    const correctionRows = await safeAll(
        db,
        `SELECT * FROM clover_ph_ledger
         WHERE player_id = ?
           AND (related_id = ? OR metadata_json LIKE ?)
           AND kind IN ('estorno', 'ajuste_admin', 'perda', 'gasto')
         ORDER BY id`,
        [playerId, `quick_eval_reversal:${evaluationId}`, `%\"reversed_evaluation_id\":${evaluationId}%`]
    );
    printRows('Possiveis estornos anteriores', correctionRows);

    const phTotal = phRows
        .filter((row) => !row.__error && row.kind === 'ganho')
        .reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);
    const expectedPh = Number(evaluation.ph_amount || 0);
    const itemRows = inventory.reduce((sum, entry) => sum + entry.rows.length, 0);
    const unsafeReasons = [];
    if (expectedPh > 0 && phTotal !== expectedPh) {
        unsafeReasons.push(`PH ligado (${phTotal}) diverge da ficha (${expectedPh}).`);
    }
    if (correctionRows.length && !correctionRows[0]?.__error) {
        unsafeReasons.push('Existe possivel estorno anterior.');
    }
    if (inventory.some((entry) => entry.rows.some((row) => (
        ['used', 'consumed', 'removed'].includes(normalizeText(row.status))
        || Number(row.quantity || 1) <= 0
    )))) {
        unsafeReasons.push('Item ligado parece consumido/removido ou sem quantidade.');
    }

    console.log('\nVEREDITO DO ESTORNO');
    if (unsafeReasons.length) {
        console.log('BLOQUEADO PARA AUTOMACAO CEGA:');
        for (const reason of unsafeReasons) console.log(`- ${reason}`);
    } else {
        console.log('CANDIDATO A ESTORNO DIRECIONADO.');
        console.log(`Efeito previsto: -${expectedPh} PH; -${Number(evaluation.stars_amount || 0)} estrela(s); remover ${itemRows} registro(s) de inventario ligado(s).`);
        console.log('A avaliacao deve ser marcada como anulada, nao apagada sem historico.');
    }
}

function walkJsFiles(rootDir) {
    const result = [];
    const ignored = new Set(['node_modules', '.git', 'auth_info', 'backups', 'site', 'dist', 'build']);
    const stack = [rootDir];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (ignored.has(entry.name)) continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile() && /\.(?:c?js|mjs)$/i.test(entry.name)) result.push(full);
        }
    }
    return result;
}

function collectSourceMatches() {
    const patterns = [
        /addfeitico/i,
        /upfeitico/i,
        /saveSpell\s*\(/,
        /concludeSpellReviewEntry\s*\(/,
        /findActiveEntryForPlayer\s*\(/,
        /getActiveQueueEntry\s*\(/,
        /removeSpellReviewParticipant\s*\(/,
        /groupParticipantsUpdate[\s\S]{0,180}['\"]remove['\"]/,
        /status\s*!==?\s*['\"]called['\"]/,
        /not_called/,
        /not_active/,
    ];
    const matches = [];
    for (const file of walkJsFiles(ROOT)) {
        let text;
        try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            const window = lines.slice(index, Math.min(lines.length, index + 8)).join('\n');
            if (!patterns.some((pattern) => pattern.test(window))) continue;
            const start = Math.max(0, index - 4);
            const end = Math.min(lines.length, index + 12);
            matches.push({
                file: path.relative(ROOT, file),
                line: index + 1,
                snippet: lines.slice(start, end).map((lineText, offset) => (
                    `${String(start + offset + 1).padStart(5, ' ')} | ${lineText}`
                )).join('\n'),
            });
            index += 8;
        }
    }
    return matches;
}

async function inspectSpellQueue(db) {
    if (!await tableExists(db, 'clover_spell_review_queue')) {
        console.log('Tabela clover_spell_review_queue ausente.');
        return;
    }
    const rows = await db.all(
        `SELECT q.*,
                COALESCE(NULLIF(j.personagem_nome,''), NULLIF(j.display_name,''), NULLIF(j.nome,''), q.player_id) AS player_name
         FROM clover_spell_review_queue q
         LEFT JOIN jogadores j ON j.id = q.player_id
         WHERE q.status IN ('waiting', 'called')
         ORDER BY CASE q.status WHEN 'called' THEN 0 ELSE 1 END, q.requested_at, q.id`
    );
    console.log(`Entradas ativas na fila: ${rows.length}`);
    for (const row of rows) {
        console.log(`#${row.id} | ${row.player_name} | ${row.player_id} | status=${row.status} | review_state=${row.review_state || '-'} | pedido=${row.requested_at || '-'} | chamado=${row.called_at || '-'}`);
    }
}

async function main() {
    if (!fs.existsSync(DB_PATH)) throw new Error(`Banco nao encontrado: ${DB_PATH}`);
    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        await db.exec('PRAGMA busy_timeout = 10000');

        line();
        console.log('ROQUE — AVALIACAO RECENTE E ESTORNO');
        line();
        const players = await findRoquePlayers(db);
        console.log(`Cadastros encontrados com Roque: ${players.length}`);
        for (const player of players) {
            console.log(`${player.id} | ${playerName(player)} | jogo=${player.jogo_status || '-'} | identidade=${player.identity_status || 'active'} | lifecycle=${player.lifecycle_status || 'active'}`);
        }

        const evaluations = await readRecentEvaluations(db, players.map((player) => player.id));
        console.log(`Avaliacoes nas ultimas ${RECENT_HOURS}h: ${evaluations.length}`);
        for (const evaluation of evaluations) {
            console.log(`#${evaluation.id} | ${evaluation.player_name} | ${evaluation.modality_label || evaluation.modality_key} | +${evaluation.ph_amount || 0} PH | +${evaluation.stars_amount || 0} estrela(s) | item=${evaluation.inventory_text || '-'} | ${evaluation.created_at}`);
        }
        if (evaluations.length) await inspectEvaluation(db, evaluations[0]);

        console.log('');
        line();
        console.log('FLUXO DE FEITICOS — FILA E EXPULSAO');
        line();
        await inspectSpellQueue(db);

        const matches = collectSourceMatches();
        console.log(`\nBlocos de codigo relevantes encontrados: ${matches.length}`);
        for (const match of matches) {
            console.log('\n' + '-'.repeat(84));
            console.log(`${match.file}:${match.line}`);
            console.log('-'.repeat(84));
            console.log(match.snippet);
        }

        line();
        console.log('VEREDITO TECNICO PRELIMINAR');
        console.log('- A fila pode organizar entrada e capacidade, mas nao deve ser requisito para o ADM salvar/atualizar um feitico.');
        console.log('- Concluir a fila e remover o player do grupo so deve ocorrer depois de salvar o feitico e enviar feedback com sucesso.');
        console.log('- Falha ao salvar ou enviar feedback deve preservar o player no grupo e a entrada da fila.');
        console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
        line();
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO DIAGNOSTICO:');
    console.error(error?.stack || error);
    process.exitCode = 1;
});
