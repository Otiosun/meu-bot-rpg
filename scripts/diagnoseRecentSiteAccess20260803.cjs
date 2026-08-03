'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { getPlayerPhase } = require('../helpers/clover/playerPhase');
const { normalizeJid } = require('../helpers/groupAccess');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const AUTH_INFO_DIR = path.join(ROOT, 'auth_info');
const RECENT_DAYS = 21;

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '(sem nome)';
}

function isApproved(value) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeText(value));
}

function isPending(value) {
    return ['pending', 'pendente'].includes(normalizeText(value));
}

function isRejected(value) {
    return ['negada', 'rejeitada', 'reprovada', 'rejected'].includes(normalizeText(value));
}

function isReleased(value) {
    return normalizeText(value) === 'liberado';
}

function isActiveLifecycle(player = {}) {
    const identity = normalizeText(player.identity_status || 'active');
    const lifecycle = normalizeText(player.lifecycle_status || 'active');
    return identity === 'active'
        && lifecycle === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;
}

function matchesKnownRegression(player = {}) {
    return isApproved(player.ficha_status)
        && isPending(player.personagem_aparencia_status)
        && !isRejected(player.historia_status)
        && normalizeText(player.jogo_status) === 'bloqueado'
        && !player.jogo_bloqueio_motivo
        && !player.jogo_liberado_at
        && !player.jogo_liberado_by
        && isActiveLifecycle(player);
}

function parseJson(value, fallback = {}) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function hasReleaseEvidence(onboarding = {}) {
    const step = normalizeText(onboarding.current_step);
    if (step !== 'jogo liberado') return false;
    const payload = parseJson(onboarding.step_payload, {});
    return normalizeText(payload.last_message).includes('jogo liberado');
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function extractMappedDigits(parsed) {
    if (typeof parsed === 'string' || typeof parsed === 'number') return extractDigits(parsed);
    if (!parsed || typeof parsed !== 'object') return '';
    return extractDigits(
        parsed.phoneNumber || parsed.phone_number || parsed.pn || parsed.lid
        || parsed.jid || parsed.id || parsed.user || ''
    );
}

function counterpartId(playerId) {
    const normalized = normalizeJid(playerId);
    const [digits, domain] = String(normalized || '').split('@');
    if (!digits || !domain) return null;

    if (domain === 'lid') {
        const mapped = extractMappedDigits(
            readJsonFile(path.join(AUTH_INFO_DIR, `lid-mapping-${extractDigits(digits)}_reverse.json`))
        );
        return mapped ? `${mapped}@s.whatsapp.net` : null;
    }

    if (domain === 's.whatsapp.net') {
        const mapped = extractMappedDigits(
            readJsonFile(path.join(AUTH_INFO_DIR, `lid-mapping-${extractDigits(digits)}.json`))
        );
        return mapped ? `${mapped}@lid` : null;
    }

    return null;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${JSON.stringify(tableName)})`);
    return new Set((rows || []).map((row) => row.name));
}

async function safeGet(db, sql, params = []) {
    try {
        return await db.get(sql, params);
    } catch {
        return null;
    }
}

async function safeAll(db, sql, params = []) {
    try {
        return await db.all(sql, params);
    } catch {
        return [];
    }
}

function recentExpression(columns) {
    const candidates = [
        'updated_at',
        'created_at',
        'jogo_status_updated_at',
        'ficha_status_updated_at',
        'historia_status_updated_at',
        'personagem_aparencia_updated_at',
        'jogo_liberado_at',
    ].filter((column) => columns.has(column));
    if (!candidates.length) return 'NULL';
    return `MAX(${candidates.map((column) => `COALESCE(${column}, '')`).join(', ')})`;
}

async function readSessionSummary(db, playerId) {
    if (!await tableExists(db, 'clover_site_sessions')) return null;
    return safeGet(
        db,
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN revoked_at IS NULL AND datetime(expires_at) > datetime('now') THEN 1 ELSE 0 END) AS active,
                MAX(created_at) AS last_created_at,
                MAX(last_seen_at) AS last_seen_at
         FROM clover_site_sessions
         WHERE player_id = ?`,
        [playerId]
    );
}

async function readCodeSummary(db, playerId) {
    if (!await tableExists(db, 'clover_site_login_codes')) return null;
    return safeGet(
        db,
        `SELECT COUNT(*) AS total,
                MAX(created_at) AS last_created_at,
                MAX(used_at) AS last_used_at
         FROM clover_site_login_codes
         WHERE player_id = ?`,
        [playerId]
    );
}

async function readStats(db, playerId) {
    if (!await tableExists(db, 'clover_character_stats')) return null;
    return safeGet(
        db,
        `SELECT player_id, distribution_status, ph_accumulated, ph_available, updated_at
         FROM clover_character_stats
         WHERE player_id = ?`,
        [playerId]
    );
}

async function readRecentEvaluation(db, playerId) {
    if (!await tableExists(db, 'clover_quick_evaluations')) return null;
    return safeGet(
        db,
        `SELECT COUNT(*) AS total,
                MAX(created_at) AS last_created_at
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND datetime(created_at) >= datetime('now', ?)`,
        [playerId, `-${RECENT_DAYS} days`]
    );
}

async function readRecentLedger(db, playerId) {
    if (!await tableExists(db, 'clover_ph_ledger')) return null;
    return safeGet(
        db,
        `SELECT COUNT(*) AS total,
                MAX(created_at) AS last_created_at
         FROM clover_ph_ledger
         WHERE player_id = ?
           AND datetime(created_at) >= datetime('now', ?)`,
        [playerId, `-${RECENT_DAYS} days`]
    );
}

function hasRecentEvidence(record) {
    return Number(record.session?.total || 0) > 0
        || Number(record.code?.total || 0) > 0
        || Number(record.evaluation?.total || 0) > 0
        || Number(record.ledger?.total || 0) > 0
        || Boolean(record.recentAt);
}

function classify(record) {
    if (record.phase?.canPlay) return 'released';
    if (record.identitySplit) return 'identity_split';
    if (record.knownRegression && record.releaseEvidence) return 'safe_known_regression';
    if (record.knownRegression && !record.releaseEvidence) return 'regression_without_release_evidence';
    if (isApproved(record.player.ficha_status)) return 'approved_but_not_released';
    return 'incomplete_onboarding';
}

function printRecord(record) {
    const player = record.player;
    const session = record.session || {};
    const stats = record.stats || {};
    console.log(
        `${record.classification === 'safe_known_regression' ? '[REPARO SEGURO]' : '[BLOQUEADO]'} `
        + `${playerName(player)} | ${player.id}`
    );
    console.log(
        `  fase=${record.phase?.phase || '-'} | ficha=${player.ficha_status || '-'} | `
        + `aparencia=${player.personagem_aparencia_status || '-'} | historia=${player.historia_status || '-'} | `
        + `jogo=${player.jogo_status || '-'}`
    );
    console.log(
        `  onboarding=${record.onboarding?.current_step || '-'} | evidencia_liberacao=${record.releaseEvidence ? 'sim' : 'nao'} | `
        + `stats=${stats.distribution_status || '-'} | sessao_ativa=${Number(session.active || 0)}`
    );
    console.log(
        `  classificacao=${record.classification} | recente=${record.recentAt || '-'} | `
        + `codigo_site=${record.code?.last_created_at || '-'} | ultimo_site=${session.last_seen_at || '-'}`
    );
    if (record.counterpart) {
        console.log(
            `  contraparte=${record.counterpart.id} | nome=${playerName(record.counterpart)} | `
            + `jogo=${record.counterpart.jogo_status || '-'} | identidade=${record.counterpart.identity_status || 'active'} | `
            + `shadow=${Number(record.counterpart.is_shadow || 0)}`
        );
    }
    if (player.jogo_bloqueio_motivo) {
        console.log(`  motivo_bloqueio=${player.jogo_bloqueio_motivo}`);
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

        const playerColumns = await tableColumns(db, 'jogadores');
        if (!playerColumns.size) throw new Error('Tabela jogadores nao encontrada.');
        const recentExpr = recentExpression(playerColumns);
        const players = await safeAll(
            db,
            `SELECT jogadores.*, ${recentExpr} AS diagnostic_recent_at
             FROM jogadores
             ORDER BY diagnostic_recent_at DESC, id`
        );

        const byId = new Map(players.map((player) => [normalizeJid(player.id), player]));
        const records = [];

        for (const player of players) {
            if (!isActiveLifecycle(player)) continue;

            const phase = await getPlayerPhase(db, player.id);
            const onboarding = await safeGet(
                db,
                'SELECT * FROM player_onboarding WHERE player_id = ?',
                [player.id]
            );
            const [session, code, stats, evaluation, ledger] = await Promise.all([
                readSessionSummary(db, player.id),
                readCodeSummary(db, player.id),
                readStats(db, player.id),
                readRecentEvaluation(db, player.id),
                readRecentLedger(db, player.id),
            ]);

            const counterpart = byId.get(normalizeJid(counterpartId(player.id))) || null;
            let counterpartPhase = null;
            if (counterpart) counterpartPhase = await getPlayerPhase(db, counterpart.id);
            const identitySplit = Boolean(
                counterpart
                && !phase.canPlay
                && counterpartPhase?.canPlay
            );

            const record = {
                player,
                phase,
                onboarding,
                session,
                code,
                stats,
                evaluation,
                ledger,
                counterpart,
                counterpartPhase,
                identitySplit,
                knownRegression: matchesKnownRegression(player),
                releaseEvidence: hasReleaseEvidence(onboarding || {}),
                recentAt: player.diagnostic_recent_at || null,
            };
            record.classification = classify(record);

            if (!phase.canPlay && (
                hasRecentEvidence(record)
                || isApproved(player.ficha_status)
                || identitySplit
                || record.releaseEvidence
            )) {
                records.push(record);
            }
        }

        const safe = records.filter((record) => record.classification === 'safe_known_regression');
        const split = records.filter((record) => record.classification === 'identity_split');
        const uncertain = records.filter((record) => !['safe_known_regression', 'identity_split'].includes(record.classification));
        const withSite = records.filter((record) => Number(record.session?.total || 0) > 0 || Number(record.code?.total || 0) > 0);

        console.log('='.repeat(76));
        console.log('DIAGNOSTICO DE ACESSO AO SITE — TERCEIRA REMESSA / NOVATOS');
        console.log('='.repeat(76));
        console.log(`Jogadores ativos inspecionados: ${players.filter(isActiveLifecycle).length}`);
        console.log(`Bloqueados relevantes: ${records.length}`);
        console.log(`Com tentativa/login no site: ${withSite.length}`);
        console.log(`Assinatura exata + evidencia de liberacao: ${safe.length}`);
        console.log(`Sessao/identidade aponta para duplicata bloqueada: ${split.length}`);
        console.log(`Casos que exigem analise individual: ${uncertain.length}`);

        console.log('\n' + '-'.repeat(76));
        console.log('CANDIDATOS A REPARO SEGURO DA REGRESSAO CONHECIDA');
        console.log('-'.repeat(76));
        if (!safe.length) console.log('Nenhum.');
        for (const record of safe) printRecord(record);

        console.log('\n' + '-'.repeat(76));
        console.log('IDENTIDADES DUPLICADAS / SESSAO NA LINHA ERRADA');
        console.log('-'.repeat(76));
        if (!split.length) console.log('Nenhuma.');
        for (const record of split) printRecord(record);

        console.log('\n' + '-'.repeat(76));
        console.log('OUTROS BLOQUEIOS RELEVANTES');
        console.log('-'.repeat(76));
        if (!uncertain.length) console.log('Nenhum.');
        for (const record of uncertain) printRecord(record);

        console.log('\n' + '='.repeat(76));
        if (safe.length || split.length) {
            console.log('VEREDITO: HA REGRESSAO OU DIVERGENCIA DE IDENTIDADE COMPROVAVEL.');
        } else if (records.length) {
            console.log('VEREDITO: HA BLOQUEIOS, MAS NAO EXISTE EVIDENCIA SUFICIENTE PARA LIBERAR AUTOMATICAMENTE.');
        } else {
            console.log('VEREDITO: NENHUM BLOQUEIO RELEVANTE FOI ENCONTRADO NO BANCO VIVO.');
        }
        console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
        console.log('='.repeat(76));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO DIAGNOSTICO DE ACESSO AO SITE:');
    console.error(error?.stack || error);
    process.exitCode = 1;
});
