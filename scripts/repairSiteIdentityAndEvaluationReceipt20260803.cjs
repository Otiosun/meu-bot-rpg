'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const AUTH_INFO_DIR = path.join(ROOT, 'auth_info');
const BACKUP_DIR = path.join(ROOT, 'backups');
const SITE_AUTH_PATH = path.join(ROOT, 'helpers', 'clover', 'siteAuthService.js');
const QUICK_EVAL_PATH = path.join(ROOT, 'helpers', 'clover', 'quickEvaluationService.js');
const CONFIRMATION = 'REPARAR-SESSOES-SITE-E-RECIBO-2026-08-03';
const QUICK_RECEIPT_MARKER = 'text: renderQuickEvaluationSuccess(result),';
const SITE_CANONICAL_MARKER = 'const resolvedPlayer = await resolveBestPlayerByPhone(db, phoneDigits);';
const SITE_ACTIVE_SCORE_MARKER = "if (!activeIdentity || gameStatus === 'arquivado') score -= 10000;";

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const confirmation = argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
    if (apply && confirmation !== CONFIRMATION) {
        throw new Error(`Aplicacao bloqueada. Use --apply --confirm=${CONFIRMATION}`);
    }
    return { apply };
}

function stamp() {
    return new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
}

function normalizeText(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function normalizeJid(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const match = raw.match(/(\d{8,})@(lid|s\.whatsapp\.net)/);
    return match ? `${match[1]}@${match[2]}` : raw;
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function maskIdentity(value) {
    const normalized = normalizeJid(value);
    const digits = extractDigits(normalized);
    if (digits.length >= 4) {
        return `***${digits.slice(-4)}@${normalized.includes('@lid') ? 'lid' : 'jid'}`;
    }
    return normalized ? '***@jid' : '(sem identidade)';
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '(sem nome)';
}

function isApproved(value) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeText(value));
}

function isRejected(value) {
    return ['negada', 'rejeitada', 'reprovada', 'rejected'].includes(normalizeText(value));
}

function canPlay(player = {}) {
    return isApproved(player.ficha_status)
        && !isRejected(player.historia_status)
        && normalizeText(player.jogo_status) === 'liberado';
}

function isActive(player = {}) {
    return normalizeText(player.identity_status || 'active') === 'active'
        && normalizeText(player.lifecycle_status || 'active') === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;
}

function addEdge(graph, left, right) {
    const a = normalizeJid(left);
    const b = normalizeJid(right);
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function inferDomain(keyHint, fallbackDomain) {
    const key = String(keyHint || '').toLowerCase();
    if (key.includes('phone') || key === 'pn' || key.includes('phone_number')) return 's.whatsapp.net';
    if (key.includes('lid')) return 'lid';
    return fallbackDomain;
}

function candidateFromScalar(value, keyHint, fallbackDomain) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const explicit = raw.match(/(\d{8,})@(lid|s\.whatsapp\.net)/i);
    if (explicit) return `${explicit[1]}@${explicit[2].toLowerCase()}`;
    const digits = extractDigits(raw);
    if (digits.length < 8) return '';
    const domain = inferDomain(keyHint, fallbackDomain);
    return domain ? `${digits}@${domain}` : '';
}

function collectCandidates(value, fallbackDomain, output, keyHint = '') {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
        const candidate = candidateFromScalar(value, keyHint, fallbackDomain);
        if (candidate) output.add(candidate);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectCandidates(item, fallbackDomain, output, keyHint);
        return;
    }
    if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) collectCandidates(item, inferDomain(key, fallbackDomain), output, key);
    }
}

function buildAuthGraph() {
    const graph = new Map();
    if (!fs.existsSync(AUTH_INFO_DIR)) return graph;
    const files = fs.readdirSync(AUTH_INFO_DIR).filter((name) => /^lid-mapping-\d+(?:_reverse)?\.json$/i.test(name));
    for (const name of files) {
        const match = name.match(/^lid-mapping-(\d+)(_reverse)?\.json$/i);
        if (!match) continue;
        const reverse = Boolean(match[2]);
        const root = `${match[1]}@${reverse ? 'lid' : 's.whatsapp.net'}`;
        const fallbackDomain = reverse ? 's.whatsapp.net' : 'lid';
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(AUTH_INFO_DIR, name), 'utf8'));
        } catch {
            continue;
        }
        const candidates = new Set();
        collectCandidates(parsed, fallbackDomain, candidates);
        for (const candidate of candidates) addEdge(graph, root, candidate);
    }
    return graph;
}

function connectedNodes(graph, seeds) {
    const queue = [...new Set(seeds.map(normalizeJid).filter(Boolean))];
    const visited = new Set(queue);
    while (queue.length) {
        const current = queue.shift();
        for (const next of graph.get(current) || []) {
            if (visited.has(next)) continue;
            visited.add(next);
            queue.push(next);
        }
    }
    return visited;
}

async function tableExists(db, tableName) {
    const row = await db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
    return Boolean(row?.found);
}

async function readPlan(db) {
    const hasStats = await tableExists(db, 'clover_character_stats');
    const statsJoin = hasStats ? 'LEFT JOIN clover_character_stats s ON s.player_id = j.id' : '';
    const statsSelect = hasStats ? ', s.distribution_status' : ', NULL AS distribution_status';
    const players = await db.all(`SELECT j.* ${statsSelect} FROM jogadores j ${statsJoin}`);
    const playersById = new Map(players.map((player) => [normalizeJid(player.id), player]));
    const sessions = await db.all(`
        SELECT token_hash, player_id, phone_digits, created_at, last_seen_at, expires_at
        FROM clover_site_sessions
        WHERE revoked_at IS NULL AND datetime(expires_at) > datetime('now')
        ORDER BY last_seen_at DESC, created_at DESC
    `);

    const graph = buildAuthGraph();
    for (const session of sessions) {
        const phone = extractDigits(session.phone_digits);
        if (phone) addEdge(graph, session.player_id, `${phone}@s.whatsapp.net`);
    }
    for (const player of players) {
        if (player.merged_into) addEdge(graph, player.id, player.merged_into);
    }

    const safe = [];
    const ambiguous = [];
    const unresolved = [];
    for (const session of sessions) {
        const current = playersById.get(normalizeJid(session.player_id)) || null;
        if (current && canPlay(current)) continue;
        const phone = extractDigits(session.phone_digits);
        const seeds = [session.player_id];
        if (phone) seeds.push(`${phone}@s.whatsapp.net`);
        const candidates = [...connectedNodes(graph, seeds)].map((jid) => playersById.get(jid)).filter(Boolean);
        const released = candidates.filter((player) => canPlay(player) && isActive(player));
        const record = { session, current, phone, candidates, released };
        if (released.length === 1) {
            record.canonical = released[0];
            safe.push(record);
        } else if (released.length > 1) {
            ambiguous.push(record);
        } else {
            unresolved.push(record);
        }
    }
    return { sessions, safe, ambiguous, unresolved };
}

function patchSiteAuth(original) {
    const originalUsesCrLf = original.includes('\r\n');
    let text = original.replace(/\r\n/g, '\n');
    let changed = false;

    if (!text.includes(SITE_ACTIVE_SCORE_MARKER)) {
        const needle = [
            '    const appearanceStatus = normalizeStatus(player.personagem_aparencia_status);',
            '    const distributionStatus = normalizeStatus(player.distribution_status);',
            '',
            "    if (gameStatus === 'liberado') score += 1000;",
        ].join('\n');
        const replacement = [
            '    const appearanceStatus = normalizeStatus(player.personagem_aparencia_status);',
            '    const distributionStatus = normalizeStatus(player.distribution_status);',
            "    const identityStatus = normalizeStatus(player.identity_status || 'active');",
            "    const lifecycleStatus = normalizeStatus(player.lifecycle_status || 'active');",
            "    const activeIdentity = identityStatus === 'active'",
            "        && lifecycleStatus === 'active'",
            '        && Number(player.is_shadow || 0) === 0',
            '        && !player.merged_into;',
            '',
            "    if (!activeIdentity || gameStatus === 'arquivado') score -= 10000;",
            '    if (activeIdentity) score += 2000;',
            "    if (gameStatus === 'liberado') score += 1000;",
        ].join('\n');
        if (!text.includes(needle)) throw new Error('Nao encontrei o bloco de pontuacao em siteAuthService.js.');
        text = text.replace(needle, replacement);
        changed = true;
    }

    if (!text.includes(SITE_CANONICAL_MARKER)) {
        const needle = [
            '    const normalizedPlayerId = normalizeJid(playerId);',
            "    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [normalizedPlayerId]);",
            "    if (!player) return { ok: false, reason: 'missing_player' };",
            '',
            '    const phoneDigits = getPlayerPhoneDigits(normalizedPlayerId);',
            "    if (!phoneDigits) return { ok: false, reason: 'missing_phone' };",
        ].join('\n');
        const replacement = [
            '    const requestedPlayerId = normalizeJid(playerId);',
            "    const requestedPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [requestedPlayerId]);",
            "    if (!requestedPlayer) return { ok: false, reason: 'missing_player' };",
            '',
            '    const phoneDigits = getPlayerPhoneDigits(requestedPlayerId);',
            "    if (!phoneDigits) return { ok: false, reason: 'missing_phone' };",
            '',
            '    const resolvedPlayer = await resolveBestPlayerByPhone(db, phoneDigits);',
            '    const player = resolvedPlayer || requestedPlayer;',
            '    const normalizedPlayerId = normalizeJid(player.id);',
        ].join('\n');
        if (!text.includes(needle)) throw new Error('Nao encontrei createSiteLoginCode em siteAuthService.js.');
        text = text.replace(needle, replacement);
        changed = true;
    }

    if (originalUsesCrLf) text = text.replace(/\n/g, '\r\n');
    return { text, changed };
}

function patchQuickEvaluation(original) {
    if (original.includes(QUICK_RECEIPT_MARKER)) return { text: original, changed: false };
    const needle = "        await sendReaction({ sock, idChat, m, emoji: '✅' }).catch(() => null);";
    const first = original.indexOf(needle);
    if (first < 0 || original.indexOf(needle, first + needle.length) >= 0) {
        throw new Error('Ponto do recibo de avaliacao ausente ou ambiguo.');
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
    ].join('\n');
    return { text: original.slice(0, first) + replacement + original.slice(first + needle.length), changed: true };
}

function syntaxCheck(filePath) {
    const result = spawnSync(process.execPath, ['--check', filePath], { cwd: ROOT, encoding: 'utf8', shell: false, windowsHide: true });
    if (result.error || result.status !== 0) {
        throw new Error(`Erro de sintaxe em ${path.relative(ROOT, filePath)}:\n${result.error?.message || result.stderr || result.stdout}`);
    }
}

async function createBackups(db) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const suffix = stamp();
    await db.exec('PRAGMA wal_checkpoint(FULL)');
    const backups = {
        database: path.join(BACKUP_DIR, `before-site-identity-repair-${suffix}.sqlite`),
        siteAuth: path.join(BACKUP_DIR, `siteAuthService.before-${suffix}.js`),
        quickEvaluation: path.join(BACKUP_DIR, `quickEvaluationService.before-${suffix}.js`),
    };
    fs.copyFileSync(DB_PATH, backups.database);
    fs.copyFileSync(SITE_AUTH_PATH, backups.siteAuth);
    fs.copyFileSync(QUICK_EVAL_PATH, backups.quickEvaluation);
    return backups;
}

function restoreFiles(backups) {
    if (!backups) return;
    if (fs.existsSync(backups.siteAuth)) fs.copyFileSync(backups.siteAuth, SITE_AUTH_PATH);
    if (fs.existsSync(backups.quickEvaluation)) fs.copyFileSync(backups.quickEvaluation, QUICK_EVAL_PATH);
}

async function applySessionRepairs(db, plan) {
    let migrated = 0;
    let revokedOlder = 0;
    let deletedCodes = 0;
    const details = [];

    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const record of plan.safe) {
            const sourceId = normalizeJid(record.session.player_id);
            const canonicalId = normalizeJid(record.canonical.id);
            if (!sourceId || !canonicalId || sourceId === canonicalId) continue;

            const activeRelated = await db.all(`
                SELECT token_hash, player_id, created_at, last_seen_at
                FROM clover_site_sessions
                WHERE player_id IN (?, ?)
                  AND revoked_at IS NULL
                  AND datetime(expires_at) > datetime('now')
                ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC
            `, [sourceId, canonicalId]);
            const keep = activeRelated[0] || record.session;

            for (const session of activeRelated.slice(1)) {
                const result = await db.run('UPDATE clover_site_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL', [session.token_hash]);
                revokedOlder += Number(result?.changes || 0);
            }

            if (normalizeJid(keep.player_id) === sourceId) {
                const result = await db.run(`
                    UPDATE clover_site_sessions
                    SET player_id = ?
                    WHERE token_hash = ? AND player_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')
                `, [canonicalId, keep.token_hash, sourceId]);
                if (Number(result?.changes || 0) !== 1) throw new Error(`Falha ao migrar ${sourceId} para ${canonicalId}.`);
                migrated += 1;
            }

            const codeResult = await db.run('DELETE FROM clover_site_login_codes WHERE player_id = ?', [sourceId]).catch(() => ({ changes: 0 }));
            deletedCodes += Number(codeResult?.changes || 0);
            details.push({ sourceId, canonicalId, canonicalName: playerName(record.canonical) });
        }

        const foreignKeys = await db.all('PRAGMA foreign_key_check');
        if (foreignKeys.length) throw new Error(`foreign_key_check encontrou ${foreignKeys.length} falha(s).`);

        for (const detail of details) {
            const sourceActive = await db.get(`SELECT COUNT(*) AS total FROM clover_site_sessions WHERE player_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`, [detail.sourceId]);
            const canonicalActive = await db.get(`SELECT COUNT(*) AS total FROM clover_site_sessions WHERE player_id = ? AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`, [detail.canonicalId]);
            if (Number(sourceActive?.total || 0) !== 0) throw new Error(`Ainda existe sessao ativa em ${detail.sourceId}.`);
            if (Number(canonicalActive?.total || 0) < 1) throw new Error(`Nenhuma sessao ativa restou em ${detail.canonicalId}.`);
        }

        await db.exec('COMMIT');
        return { migrated, revokedOlder, deletedCodes, details };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

function printPlan(plan, patchState) {
    console.log('='.repeat(76));
    console.log('REPARO DE IDENTIDADE DO SITE + RECIBO DE AVALIACAO');
    console.log('='.repeat(76));
    console.log(`Sessoes ativas totais: ${plan.sessions.length}`);
    console.log(`Migracoes seguras encontradas: ${plan.safe.length}`);
    console.log(`Casos ambiguos: ${plan.ambiguous.length}`);
    console.log(`Casos preservados: ${plan.unresolved.length}`);
    console.log(`Patch permanente do .#site: ${patchState.siteChanged ? 'sera instalado' : 'ja instalado'}`);
    console.log(`Recibo completo de avaliacao: ${patchState.quickChanged ? 'sera instalado' : 'ja instalado'}`);
    console.log('-'.repeat(76));
    for (const record of plan.safe) {
        console.log(`${maskIdentity(record.session.player_id)} (${playerName(record.current || {})}) -> ${maskIdentity(record.canonical.id)} (${playerName(record.canonical)})`);
    }
    console.log('='.repeat(76));
}

async function main() {
    const { apply } = parseArgs(process.argv.slice(2));
    for (const required of [DB_PATH, SITE_AUTH_PATH, QUICK_EVAL_PATH]) {
        if (!fs.existsSync(required)) throw new Error(`Arquivo ausente: ${required}`);
    }

    const sitePatch = patchSiteAuth(fs.readFileSync(SITE_AUTH_PATH, 'utf8'));
    const quickPatch = patchQuickEvaluation(fs.readFileSync(QUICK_EVAL_PATH, 'utf8'));
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database, mode: apply ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY });
    let backups = null;

    try {
        await db.exec('PRAGMA busy_timeout = 15000');
        if (!apply) await db.exec('PRAGMA query_only = ON');
        const plan = await readPlan(db);
        printPlan(plan, { siteChanged: sitePatch.changed, quickChanged: quickPatch.changed });

        if (plan.ambiguous.length) {
            throw new Error(`${plan.ambiguous.length} caso(s) ambiguo(s) encontrado(s). Aplicacao bloqueada.`);
        }
        if (!apply) {
            console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
            return;
        }

        backups = await createBackups(db);
        fs.writeFileSync(SITE_AUTH_PATH, sitePatch.text, 'utf8');
        fs.writeFileSync(QUICK_EVAL_PATH, quickPatch.text, 'utf8');
        try {
            syntaxCheck(SITE_AUTH_PATH);
            syntaxCheck(QUICK_EVAL_PATH);
        } catch (error) {
            restoreFiles(backups);
            throw error;
        }

        let repair;
        try {
            repair = await applySessionRepairs(db, plan);
        } catch (error) {
            restoreFiles(backups);
            throw error;
        }

        console.log('='.repeat(76));
        console.log('APLICACAO CONCLUIDA');
        console.log('='.repeat(76));
        console.log(`Sessoes migradas: ${repair.migrated}`);
        console.log(`Sessoes antigas revogadas: ${repair.revokedOlder}`);
        console.log(`Codigos provisorios removidos: ${repair.deletedCodes}`);
        console.log(`Casos preservados: ${plan.unresolved.length}`);
        console.log(`Backup do banco: ${backups.database}`);
        console.log(`Backup do siteAuthService: ${backups.siteAuth}`);
        console.log(`Backup do quickEvaluationService: ${backups.quickEvaluation}`);
        console.log('O .#site agora escolhe o personagem canonico ativo.');
        console.log('As avaliacoes agora exibem AVALIACAO APLICADA com saldos e checklist.');
        console.log('Reinicie clover-rpg para carregar os patches.');
        console.log('='.repeat(76));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO REPARO:');
    console.error(error?.stack || error);
    process.exitCode = 1;
});
