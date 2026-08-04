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
const PROFILE_ACCESS_PATH = path.join(ROOT, 'helpers', 'clover', 'profileAccessPreservationService.js');
const CONFIRMATION = 'REPARAR-DESATUALIZACAO-RECORRENTE-SITE-2026-08-04';
const REPAIR_ACTOR = 'system:repair-recurring-site-access-drift';
const SITE_GRAPH_MARKER = 'async function resolveBestPlayerByIdentityGraph(db, requestedPlayerId, phoneDigits) {';
const SITE_SESSION_MARKER = "console.log('[site-auth] sessao autocorrigida:'";
const PROFILE_EVIDENCE_MARKER = 'async function readOnboardingReleaseEvidence(db, playerId) {';

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
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
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

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || player.id || '(sem nome)';
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

function isActive(player = {}) {
    return normalizeText(player.identity_status || 'active') === 'active'
        && normalizeText(player.lifecycle_status || 'active') === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;
}

function canPlay(player = {}) {
    return isApproved(player.ficha_status)
        && !isRejected(player.historia_status)
        && normalizeText(player.jogo_status) === 'liberado'
        && isActive(player);
}

function matchesResetSignature(player = {}) {
    return isApproved(player.ficha_status)
        && isPending(player.personagem_aparencia_status)
        && !isRejected(player.historia_status)
        && normalizeText(player.jogo_status) === 'bloqueado'
        && !player.jogo_bloqueio_motivo
        && !player.jogo_liberado_at
        && !player.jogo_liberado_by
        && isActive(player);
}

function safeJson(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function hasReleaseEvidence(onboarding = {}) {
    if (normalizeText(onboarding.current_step) !== 'jogo liberado') return false;
    const payload = safeJson(onboarding.step_payload);
    return normalizeText(payload.last_message).includes('jogo liberado');
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
        for (const [key, item] of Object.entries(value)) {
            collectCandidates(item, inferDomain(key, fallbackDomain), output, key);
        }
    }
}

function buildAuthGraph() {
    const graph = new Map();
    if (!fs.existsSync(AUTH_INFO_DIR)) return graph;
    const files = fs.readdirSync(AUTH_INFO_DIR)
        .filter((name) => /^lid-mapping-\d+(?:_reverse)?\.json$/i.test(name));

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

async function tableExists(db, name) {
    const row = await db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?", [name]);
    return Boolean(row?.found);
}

async function readPlan(db) {
    const hasStats = await tableExists(db, 'clover_character_stats');
    const players = await db.all(`
        SELECT j.*${hasStats ? ', s.distribution_status' : ', NULL AS distribution_status'}
        FROM jogadores j
        ${hasStats ? 'LEFT JOIN clover_character_stats s ON s.player_id = j.id' : ''}
    `);
    const byId = new Map(players.map((player) => [normalizeJid(player.id), player]));
    const sessions = await db.all(`
        SELECT token_hash, player_id, phone_digits, created_at, last_seen_at, expires_at
        FROM clover_site_sessions
        WHERE revoked_at IS NULL
          AND datetime(expires_at) > datetime('now')
        ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC
    `);

    const graph = buildAuthGraph();
    for (const session of sessions) {
        const phone = extractDigits(session.phone_digits);
        if (phone) addEdge(graph, session.player_id, `${phone}@s.whatsapp.net`);
    }
    for (const player of players) {
        if (player.merged_into) addEdge(graph, player.id, player.merged_into);
    }

    const safeSessions = [];
    const ambiguousSessions = [];
    const unresolvedSessions = [];
    for (const session of sessions) {
        const current = byId.get(normalizeJid(session.player_id)) || null;
        if (current && canPlay(current)) continue;
        const phone = extractDigits(session.phone_digits);
        const seeds = [session.player_id];
        if (phone) seeds.push(`${phone}@s.whatsapp.net`);
        const candidates = [...connectedNodes(graph, seeds)]
            .map((jid) => byId.get(jid))
            .filter(Boolean);
        const released = candidates.filter(canPlay);
        const record = { session, current, phone, candidates, released };
        if (released.length === 1) {
            record.canonical = released[0];
            safeSessions.push(record);
        } else if (released.length > 1) {
            ambiguousSessions.push(record);
        } else {
            unresolvedSessions.push(record);
        }
    }

    const resetCandidates = [];
    if (await tableExists(db, 'player_onboarding')) {
        for (const player of players.filter(matchesResetSignature)) {
            const onboarding = await db.get(
                'SELECT * FROM player_onboarding WHERE player_id = ?',
                [player.id]
            );
            if (onboarding && hasReleaseEvidence(onboarding)) {
                resetCandidates.push({ player, onboarding });
            }
        }
    }

    return {
        sessions,
        safeSessions,
        ambiguousSessions,
        unresolvedSessions,
        resetCandidates,
    };
}

function normalizeLf(value) {
    return String(value || '').replace(/\r\n/g, '\n');
}

function restoreEol(value, crlf) {
    return crlf ? value.replace(/\n/g, '\r\n') : value;
}

function siteGraphHelpers() {
    return `let siteIdentityGraphCache = { at: 0, graph: new Map() };

function addSiteIdentityEdge(graph, left, right) {
    const a = normalizeJid(left);
    const b = normalizeJid(right);
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function inferSiteIdentityDomain(keyHint, fallbackDomain) {
    const key = String(keyHint || '').toLowerCase();
    if (key.includes('phone') || key === 'pn' || key.includes('phone_number')) return 's.whatsapp.net';
    if (key.includes('lid')) return 'lid';
    return fallbackDomain;
}

function collectSiteIdentityCandidates(value, fallbackDomain, output, keyHint = '') {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
        const raw = String(value || '').trim();
        const explicit = raw.match(/(\\d{8,})@(lid|s\\.whatsapp\\.net)/i);
        if (explicit) {
            output.add(\`\${explicit[1]}@\${explicit[2].toLowerCase()}\`);
            return;
        }
        const digits = extractDigits(raw);
        if (digits.length < 8) return;
        const domain = inferSiteIdentityDomain(keyHint, fallbackDomain);
        if (domain) output.add(\`\${digits}@\${domain}\`);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectSiteIdentityCandidates(item, fallbackDomain, output, keyHint);
        return;
    }
    if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            collectSiteIdentityCandidates(item, inferSiteIdentityDomain(key, fallbackDomain), output, key);
        }
    }
}

function getSiteIdentityGraph() {
    const now = Date.now();
    if (now - siteIdentityGraphCache.at < 60000) return siteIdentityGraphCache.graph;
    const graph = new Map();
    if (fs.existsSync(AUTH_INFO_DIR)) {
        const files = fs.readdirSync(AUTH_INFO_DIR)
            .filter((name) => /^lid-mapping-\\d+(?:_reverse)?\\.json$/i.test(name));
        for (const name of files) {
            const match = name.match(/^lid-mapping-(\\d+)(_reverse)?\\.json$/i);
            if (!match) continue;
            const reverse = Boolean(match[2]);
            const root = \`\${match[1]}@\${reverse ? 'lid' : 's.whatsapp.net'}\`;
            const fallbackDomain = reverse ? 's.whatsapp.net' : 'lid';
            const parsed = readJsonFile(path.join(AUTH_INFO_DIR, name));
            if (parsed === null || parsed === undefined) continue;
            const candidates = new Set();
            collectSiteIdentityCandidates(parsed, fallbackDomain, candidates);
            for (const candidate of candidates) addSiteIdentityEdge(graph, root, candidate);
        }
    }
    siteIdentityGraphCache = { at: now, graph };
    return graph;
}

function connectedSiteIdentities(seeds) {
    const graph = getSiteIdentityGraph();
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
    return [...visited];
}

function isSafeReleasedSitePlayer(player) {
    if (!player) return false;
    const identityStatus = normalizeStatus(player.identity_status || 'active');
    const lifecycleStatus = normalizeStatus(player.lifecycle_status || 'active');
    const active = identityStatus === 'active'
        && lifecycleStatus === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;
    return active
        && normalizeStatus(player.jogo_status) === 'liberado'
        && ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeStatus(player.ficha_status));
}

async function resolveBestPlayerByIdentityGraph(db, requestedPlayerId, phoneDigits) {
    const normalizedRequested = normalizeJid(requestedPlayerId);
    const digits = extractDigits(phoneDigits);
    const seeds = [normalizedRequested];
    if (digits) seeds.push(\`\${digits}@s.whatsapp.net\`);
    const candidates = connectedSiteIdentities(seeds);
    for (const direct of getJidCandidatesForPhone(digits)) {
        if (!candidates.includes(direct)) candidates.push(direct);
    }
    if (!candidates.length) return null;

    const placeholders = candidates.map(() => '?').join(', ');
    const players = await db.all(
        \`SELECT jogadores.*, clover_character_stats.distribution_status
         FROM jogadores
         LEFT JOIN clover_character_stats ON clover_character_stats.player_id = jogadores.id
         WHERE jogadores.id IN (\${placeholders})\`,
        candidates
    ).catch(() => []);
    if (!players.length) return null;

    const released = players.filter(isSafeReleasedSitePlayer);
    if (released.length === 1) return released[0];
    if (released.length > 1) return null;
    return players.sort((left, right) => scorePlayer(right) - scorePlayer(left))[0] || null;
}

`;
}

function patchSiteAuth(original) {
    const crlf = original.includes('\r\n');
    let text = normalizeLf(original);
    let changed = false;

    if (!text.includes(SITE_GRAPH_MARKER)) {
        const insertion = text.indexOf('function hashLoginCode(');
        if (insertion < 0) throw new Error('Nao encontrei o ponto para o resolvedor de identidades do site.');
        text = text.slice(0, insertion) + siteGraphHelpers() + text.slice(insertion);
        changed = true;
    }

    if (text.includes('const resolvedPlayer = await resolveBestPlayerByPhone(db, phoneDigits);')) {
        text = text.replace(
            'const resolvedPlayer = await resolveBestPlayerByPhone(db, phoneDigits);',
            'const resolvedPlayer = await resolveBestPlayerByIdentityGraph(db, requestedPlayerId, phoneDigits);'
        );
        changed = true;
    }

    if (!text.includes(SITE_SESSION_MARKER)) {
        const oldBlock = [
            "    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [session.player_id]);",
            "    if (!player) return { ok: false, reason: 'missing_player' };",
        ].join('\n');
        const newBlock = [
            "    let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [session.player_id]);",
            "    if (!player) return { ok: false, reason: 'missing_player' };",
            '',
            '    const canonicalPlayer = await resolveBestPlayerByIdentityGraph(',
            '        db,',
            '        session.player_id,',
            '        session.phone_digits',
            '    );',
            '    if (',
            '        canonicalPlayer',
            '        && isSafeReleasedSitePlayer(canonicalPlayer)',
            '        && normalizeJid(canonicalPlayer.id) !== normalizeJid(session.player_id)',
            '    ) {',
            '        const previousPlayerId = session.player_id;',
            '        const migrated = await db.run(',
            "            `UPDATE clover_site_sessions",
            "             SET player_id = ?",
            "             WHERE token_hash = ?",
            "               AND player_id = ?",
            "               AND revoked_at IS NULL",
            "               AND datetime(expires_at) > datetime('now')`,",
            '            [normalizeJid(canonicalPlayer.id), tokenHash, previousPlayerId]',
            '        );',
            '        if (Number(migrated?.changes || 0) === 1) {',
            '            session.player_id = normalizeJid(canonicalPlayer.id);',
            '            player = canonicalPlayer;',
            "            console.log('[site-auth] sessao autocorrigida:', {",
            '                from: previousPlayerId,',
            '                to: session.player_id,',
            '                phoneLast4: extractDigits(session.phone_digits).slice(-4),',
            '            });',
            '        }',
            '    }',
        ].join('\n');
        if (!text.includes(oldBlock)) throw new Error('Nao encontrei authenticateSiteSession no formato esperado.');
        text = text.replace(oldBlock, newBlock);
        changed = true;
    }

    return { text: restoreEol(text, crlf), changed };
}

function profileEvidenceHelpers() {
    return `function safeParsePayload(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function hasOnboardingReleaseEvidence(onboarding) {
    if (normalizeStatus(onboarding?.current_step).replace(/[^a-z0-9]+/g, ' ') !== 'jogo liberado') {
        return false;
    }
    const payload = safeParsePayload(onboarding?.step_payload);
    return normalizeStatus(payload.last_message).includes('jogo liberado');
}

async function readOnboardingReleaseEvidence(db, playerId) {
    const onboarding = await db.get(
        'SELECT * FROM player_onboarding WHERE player_id = ?',
        [playerId]
    ).catch(() => null);
    return hasOnboardingReleaseEvidence(onboarding) ? onboarding : null;
}

`;
}

function patchProfileAccess(original) {
    const crlf = original.includes('\r\n');
    let text = normalizeLf(original);
    let changed = false;

    if (!text.includes(PROFILE_EVIDENCE_MARKER)) {
        const insertion = text.indexOf('async function readProfileAccessSnapshot(');
        if (insertion < 0) throw new Error('Nao encontrei o ponto de evidencia do onboarding.');
        text = text.slice(0, insertion) + profileEvidenceHelpers() + text.slice(insertion);
        changed = true;
    }

    const oldGuard = [
        "    if (!beforeSnapshot || !isReleased(beforeSnapshot.jogo_status)) {",
        '        return {',
        '            restored: false,',
        '            skipped: true,',
        "            reason: 'player_was_not_released',",
        '            player: await readProfileAccessSnapshot(db, playerId),',
        '        };',
        '    }',
        '',
        '    const current = await readProfileAccessSnapshot(db, playerId);',
    ].join('\n');
    const newGuard = [
        '    const previousWasReleased = Boolean(beforeSnapshot && isReleased(beforeSnapshot.jogo_status));',
        '    const onboardingEvidence = previousWasReleased',
        '        ? null',
        '        : await readOnboardingReleaseEvidence(db, playerId);',
        '    if (!previousWasReleased && !onboardingEvidence) {',
        '        return {',
        '            restored: false,',
        '            skipped: true,',
        "            reason: 'no_previous_release_evidence',",
        '            player: await readProfileAccessSnapshot(db, playerId),',
        '        };',
        '    }',
        '',
        '    const current = await readProfileAccessSnapshot(db, playerId);',
    ].join('\n');
    if (text.includes(oldGuard)) {
        text = text.replace(oldGuard, newGuard);
        changed = true;
    }

    const oldParams = [
        '            beforeSnapshot.jogo_liberado_at || null,',
        '            beforeSnapshot.jogo_liberado_by || null,',
        '            playerId,',
    ].join('\n');
    const newParams = [
        '            beforeSnapshot?.jogo_liberado_at || onboardingEvidence?.last_seen_at || new Date().toISOString(),',
        "            beforeSnapshot?.jogo_liberado_by || 'system:profile-confirmation-release-evidence',",
        '            playerId,',
    ].join('\n');
    if (text.includes(oldParams)) {
        text = text.replace(oldParams, newParams);
        changed = true;
    }

    if (!text.includes('readOnboardingReleaseEvidence,')) {
        text = text.replace(
            '    matchesProfileConfirmationResetSignature,\n',
            '    matchesProfileConfirmationResetSignature,\n    readOnboardingReleaseEvidence,\n'
        );
        changed = true;
    }

    return { text: restoreEol(text, crlf), changed };
}

function syntaxCheck(filePath) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || result.stdout || `Erro de sintaxe em ${filePath}`);
    }
}

async function createBackups(db) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await db.exec('PRAGMA wal_checkpoint(FULL)');
    const suffix = stamp();
    const files = {
        database: path.join(BACKUP_DIR, `before-recurring-site-access-${suffix}.sqlite`),
        siteAuth: path.join(BACKUP_DIR, `siteAuthService.before-recurring-${suffix}.js`),
        profileAccess: path.join(BACKUP_DIR, `profileAccessPreservationService.before-recurring-${suffix}.js`),
    };
    fs.copyFileSync(DB_PATH, files.database);
    fs.copyFileSync(SITE_AUTH_PATH, files.siteAuth);
    fs.copyFileSync(PROFILE_ACCESS_PATH, files.profileAccess);
    return files;
}

async function applyDatabaseRepairs(db, plan) {
    let migratedSessions = 0;
    let restoredProfiles = 0;
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const record of plan.safeSessions) {
            const source = normalizeJid(record.session.player_id);
            const target = normalizeJid(record.canonical.id);
            if (!source || !target || source === target) continue;
            const result = await db.run(
                `UPDATE clover_site_sessions
                 SET player_id = ?
                 WHERE token_hash = ?
                   AND player_id = ?
                   AND revoked_at IS NULL
                   AND datetime(expires_at) > datetime('now')`,
                [target, record.session.token_hash, source]
            );
            migratedSessions += Number(result?.changes || 0);
        }

        for (const record of plan.resetCandidates) {
            const result = await db.run(
                `UPDATE jogadores
                 SET jogo_status = 'liberado',
                     jogo_liberado_at = COALESCE(?, CURRENT_TIMESTAMP),
                     jogo_liberado_by = ?,
                     jogo_bloqueio_motivo = NULL
                 WHERE id = ?
                   AND ficha_status IN ('aprovada', 'aprovado', 'confirmada', 'confirmado')
                   AND personagem_aparencia_status IN ('pending', 'pendente')
                   AND LOWER(COALESCE(jogo_status, '')) = 'bloqueado'
                   AND jogo_bloqueio_motivo IS NULL
                   AND jogo_liberado_at IS NULL
                   AND jogo_liberado_by IS NULL
                   AND COALESCE(identity_status, 'active') = 'active'
                   AND COALESCE(lifecycle_status, 'active') = 'active'
                   AND COALESCE(is_shadow, 0) = 0
                   AND merged_into IS NULL`,
                [record.onboarding.last_seen_at || null, REPAIR_ACTOR, record.player.id]
            );
            restoredProfiles += Number(result?.changes || 0);
        }

        await db.exec('COMMIT');
        return { migratedSessions, restoredProfiles };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function assertIntegrity(db) {
    const foreign = await db.all('PRAGMA foreign_key_check');
    if (foreign.length) throw new Error(`foreign_key_check encontrou ${foreign.length} falha(s).`);
    const integrity = await db.all('PRAGMA integrity_check');
    const failures = integrity.flatMap((row) => Object.values(row))
        .filter((value) => String(value).toLowerCase() !== 'ok');
    if (failures.length) throw new Error(`integrity_check falhou: ${failures.join('; ')}`);
}

async function main() {
    const { apply } = parseArgs(process.argv.slice(2));
    for (const required of [DB_PATH, SITE_AUTH_PATH, PROFILE_ACCESS_PATH]) {
        if (!fs.existsSync(required)) throw new Error(`Arquivo ausente: ${required}`);
    }

    const db = await open({ filename: DB_PATH, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE });
    let backups = null;
    try {
        await db.exec('PRAGMA busy_timeout = 15000');
        await db.exec('PRAGMA foreign_keys = ON');
        const plan = await readPlan(db);
        const sitePatch = patchSiteAuth(fs.readFileSync(SITE_AUTH_PATH, 'utf8'));
        const profilePatch = patchProfileAccess(fs.readFileSync(PROFILE_ACCESS_PATH, 'utf8'));

        console.log('='.repeat(82));
        console.log('REPARO DA DESATUALIZACAO RECORRENTE DO SITE');
        console.log('='.repeat(82));
        console.log(`Sessoes ativas: ${plan.sessions.length}`);
        console.log(`Sessoes com migracao canonica segura: ${plan.safeSessions.length}`);
        console.log(`Sessoes ambiguas preservadas: ${plan.ambiguousSessions.length}`);
        console.log(`Sessoes sem prova de personagem liberado: ${plan.unresolvedSessions.length}`);
        console.log(`Perfis com regressao comprovada pelo onboarding: ${plan.resetCandidates.length}`);
        console.log(`Autocorrecao continua da sessao: ${sitePatch.changed ? 'sera instalada' : 'ja instalada'}`);
        console.log(`Protecao de confirmacao de perfil: ${profilePatch.changed ? 'sera ampliada' : 'ja ampliada'}`);

        for (const record of plan.safeSessions) {
            console.log(`  SESSAO: ${record.session.player_id} -> ${record.canonical.id} (${playerName(record.canonical)})`);
        }
        for (const record of plan.resetCandidates) {
            console.log(`  PERFIL: ${record.player.id} (${playerName(record.player)}) sera restaurado para liberado`);
        }

        if (!apply) {
            console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
            console.log('='.repeat(82));
            return;
        }

        backups = await createBackups(db);
        fs.writeFileSync(SITE_AUTH_PATH, sitePatch.text, 'utf8');
        fs.writeFileSync(PROFILE_ACCESS_PATH, profilePatch.text, 'utf8');
        syntaxCheck(SITE_AUTH_PATH);
        syntaxCheck(PROFILE_ACCESS_PATH);
        const result = await applyDatabaseRepairs(db, plan);
        await assertIntegrity(db);

        console.log(`Backup do banco: ${backups.database}`);
        console.log(`Sessoes migradas agora: ${result.migratedSessions}`);
        console.log(`Perfis restaurados agora: ${result.restoredProfiles}`);
        console.log('APLICACAO CONCLUIDA. Reinicie clover-rpg.');
        console.log('='.repeat(82));
    } catch (error) {
        if (backups) {
            try {
                fs.copyFileSync(backups.siteAuth, SITE_AUTH_PATH);
                fs.copyFileSync(backups.profileAccess, PROFILE_ACCESS_PATH);
            } catch {
                // O backup do banco permanece disponivel para restauracao manual.
            }
        }
        throw error;
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO REPARO RECORRENTE DO SITE:');
    console.error(error?.stack || error);
    process.exitCode = 1;
});
