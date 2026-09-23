'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ensureCloverSiteAuthSchema } = require('../../database');
const { extractPhoneNumber, normalizeJid } = require('../groupAccess');
const { connectedIdentities, getIdentityGraph } = require('./siteIdentityGraph');

const AUTH_INFO_DIR = path.join(process.cwd(), 'auth_info');
const DEFAULT_CODE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 8;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveEnvNumber(name, fallback) {
    return positiveNumber(process.env[name], fallback);
}

const CODE_TTL_MS = positiveEnvNumber('CLOVER_SITE_CODE_TTL_MS', DEFAULT_CODE_TTL_MS);
const SESSION_TTL_MS = positiveEnvNumber('CLOVER_SITE_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS);
const MAX_ACTIVE_SESSIONS = Math.max(1, Math.floor(positiveEnvNumber('CLOVER_SITE_MAX_ACTIVE_SESSIONS', 5)));
const loginAttempts = new Map();

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function isGhostSitePlayer(player) {
    return Number(player?.is_test_user || 0) === 1
        && String(player?.character_kind || '') === 'ghost'
        && Number(player?.is_canonical ?? 1) === 0;
}

function maskIdentityForLog(value) {
    const normalized = normalizeJid(value);
    const digits = extractDigits(normalized);
    if (digits.length >= 4) return `***${digits.slice(-4)}@${normalized.includes('@lid') ? 'lid' : 'jid'}`;
    return normalized ? '***@jid' : null;
}

function toIsoDate(timestamp) {
    return new Date(timestamp).toISOString();
}

function parseDatabaseDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return NaN;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomCode() {
    return String(crypto.randomInt(100000, 1000000));
}

function randomToken() {
    return `clv_${crypto.randomBytes(32).toString('base64url')}`;
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
    if (parsed && typeof parsed === 'object') {
        return extractDigits(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user || parsed.lid);
    }
    return '';
}

function readForwardMappedLidDigits(phoneDigits) {
    const digits = extractDigits(phoneDigits);
    if (!digits) return '';
    return extractMappedDigits(readJsonFile(path.join(AUTH_INFO_DIR, `lid-mapping-${digits}.json`)));
}

function readReverseMappedPhoneDigits(lidDigits) {
    const digits = extractDigits(lidDigits);
    if (!digits) return '';
    return extractMappedDigits(readJsonFile(path.join(AUTH_INFO_DIR, `lid-mapping-${digits}_reverse.json`)));
}

function getPlayerPhoneDigits(playerId) {
    const normalized = normalizeJid(playerId);
    const directPhone = extractPhoneNumber(normalized);
    if (directPhone) return directPhone;

    const [userPart, domain] = normalized.split('@');
    if (domain === 'lid') return readReverseMappedPhoneDigits(userPart);
    return '';
}

function getJidCandidatesForPhone(phoneDigits) {
    const digits = extractDigits(phoneDigits);
    if (!digits) return [];

    const candidates = new Set([`${digits}@s.whatsapp.net`]);
    const mappedLid = readForwardMappedLidDigits(digits);
    if (mappedLid) candidates.add(`${mappedLid}@lid`);
    return [...candidates];
}

function normalizeStatus(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function hasFilledPlayerField(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function scorePlayer(player) {
    if (!player) return -1;

    let score = 0;
    const gameStatus = normalizeStatus(player.jogo_status);
    const profileStatus = normalizeStatus(player.ficha_status);
    const storyStatus = normalizeStatus(player.historia_status);
    const appearanceStatus = normalizeStatus(player.personagem_aparencia_status);
    const distributionStatus = normalizeStatus(player.distribution_status);
    const identityStatus = normalizeStatus(player.identity_status || 'active');
    const lifecycleStatus = normalizeStatus(player.lifecycle_status || 'active');
    const activeIdentity = identityStatus === 'active'
        && lifecycleStatus === 'active'
        && Number(player.is_shadow || 0) === 0
        && !player.merged_into;

    if (!activeIdentity || gameStatus === 'arquivado') score -= 10000;
    if (activeIdentity) score += 2000;
    if (gameStatus === 'liberado') score += 1000;
    if (['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profileStatus)) score += 500;
    if (['aprovada', 'aprovado'].includes(storyStatus)) score += 100;
    if (['approved', 'aprovada', 'aprovado'].includes(appearanceStatus)) score += 100;
    if (distributionStatus === 'confirmed') score += 50;

    for (const field of ['personagem_nome', 'nome', 'raca', 'classe', 'grimorio', 'magia']) {
        if (hasFilledPlayerField(player[field])) score += 10;
    }
    return score;
}

async function resolveBestPlayerByPhone(db, phoneDigits) {
    const candidates = getJidCandidatesForPhone(phoneDigits);
    if (!candidates.length) return null;

    const placeholders = candidates.map(() => '?').join(', ');
    const players = await db.all(
        `SELECT jogadores.*, clover_character_stats.distribution_status
         FROM jogadores
         LEFT JOIN clover_character_stats ON clover_character_stats.player_id = jogadores.id
         WHERE jogadores.id IN (${placeholders})`,
        candidates
    ).catch(() => []);

    if (!players.length) return null;
    return players.sort((left, right) => scorePlayer(right) - scorePlayer(left))[0];
}

async function readDirectPhonePlayer(db, phoneDigits) {
    const digits = extractDigits(phoneDigits);
    if (!digits) return null;
    return db.get('SELECT * FROM jogadores WHERE id = ?', [`${digits}@s.whatsapp.net`]).catch(() => null);
}

function connectedSiteIdentities(seeds) {
    return connectedIdentities(getIdentityGraph(AUTH_INFO_DIR), seeds);
}

function isSafeReleasedSitePlayer(player) {
    if (!player) return false;
    if (isGhostSitePlayer(player)) {
        return normalizeStatus(player.jogo_status) === 'liberado'
            && ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeStatus(player.ficha_status));
    }
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

async function resolvePlayerByIdentityGraph(db, requestedPlayerId, phoneDigits) {
    const normalizedRequested = normalizeJid(requestedPlayerId);
    const digits = extractDigits(phoneDigits);
    const seeds = [normalizedRequested];
    if (digits) seeds.push(`${digits}@s.whatsapp.net`);
    const candidates = connectedSiteIdentities(seeds);
    for (const direct of getJidCandidatesForPhone(digits)) {
        if (!candidates.includes(direct)) candidates.push(direct);
    }
    if (!candidates.length) return { player: null, ambiguous: false, candidates: [] };

    const placeholders = candidates.map(() => '?').join(', ');
    const players = await db.all(
        `SELECT jogadores.*, clover_character_stats.distribution_status
         FROM jogadores
         LEFT JOIN clover_character_stats ON clover_character_stats.player_id = jogadores.id
         WHERE jogadores.id IN (${placeholders})`,
        candidates
    ).catch(() => []);
    if (!players.length) return { player: null, ambiguous: false, candidates };

    const released = players.filter(isSafeReleasedSitePlayer);
    if (released.length === 1) return { player: released[0], ambiguous: false, candidates, players };
    if (released.length > 1) return { player: null, ambiguous: true, candidates, players };
    return {
        player: players.sort((left, right) => scorePlayer(right) - scorePlayer(left))[0] || null,
        ambiguous: false,
        candidates,
        players,
    };
}

async function resolveBestPlayerByIdentityGraph(db, requestedPlayerId, phoneDigits) {
    const result = await resolvePlayerByIdentityGraph(db, requestedPlayerId, phoneDigits);
    return result.ambiguous ? null : result.player;
}

function hashLoginCode(playerId, code, salt) {
    return sha256(`${salt}:${normalizeJid(playerId)}:${String(code || '').trim()}`);
}

function hashSessionToken(token) {
    return sha256(`clover-site-session:${String(token || '').trim()}`);
}

function phoneMatches(storedDigits, inputDigits) {
    const stored = extractDigits(storedDigits);
    const input = extractDigits(inputDigits);
    return Boolean(stored) && stored === input;
}

function consumeLoginAttempt(phoneDigits) {
    const key = extractDigits(phoneDigits);
    if (!key) return { allowed: false, retryAfterMs: LOGIN_ATTEMPT_WINDOW_MS };

    const now = Date.now();
    const current = loginAttempts.get(key);
    if (!current || now - current.startedAt >= LOGIN_ATTEMPT_WINDOW_MS) {
        loginAttempts.set(key, { startedAt: now, count: 1 });
        return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= LOGIN_ATTEMPT_LIMIT) {
        return {
            allowed: false,
            retryAfterMs: Math.max(0, LOGIN_ATTEMPT_WINDOW_MS - (now - current.startedAt)),
        };
    }

    current.count += 1;
    return { allowed: true, retryAfterMs: 0 };
}

function clearLoginAttempts(phoneDigits) {
    loginAttempts.delete(extractDigits(phoneDigits));
}

async function pruneSiteAuth(db) {
    await db.run(
        `DELETE FROM clover_site_login_codes
         WHERE datetime(expires_at) <= datetime('now', '-1 day')`
    ).catch(() => {});
    await db.run(
        `DELETE FROM clover_site_sessions
         WHERE datetime(expires_at) <= datetime('now', '-7 days')
            OR (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime('now', '-7 days'))`
    ).catch(() => {});
}

async function createSiteLoginCode(db, playerId, options = {}) {
    await ensureCloverSiteAuthSchema(db);

    const requestedPlayerId = normalizeJid(playerId);
    const requestedPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [requestedPlayerId]);
    if (!requestedPlayer) return { ok: false, reason: 'missing_player' };

    const phoneDigits = getPlayerPhoneDigits(requestedPlayerId) || extractDigits(options.phoneDigits || options.phone);
    if (!phoneDigits) return { ok: false, reason: 'missing_phone' };

    const resolved = isGhostSitePlayer(requestedPlayer)
        ? { player: requestedPlayer, ambiguous: false }
        : await resolvePlayerByIdentityGraph(db, requestedPlayerId, phoneDigits);
    if (resolved.ambiguous) return { ok: false, reason: 'ambiguous_identity' };
    const player = resolved.player || requestedPlayer;
    if (!isSafeReleasedSitePlayer(player)) return { ok: false, reason: 'player_not_released' };
    const normalizedPlayerId = normalizeJid(player.id);

    const code = randomCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const ttlMs = positiveNumber(options.ttlMs, CODE_TTL_MS);
    const expiresAt = toIsoDate(Date.now() + ttlMs);

    await db.run(
        `INSERT INTO clover_site_login_codes
         (player_id, phone_digits, code_hash, code_salt, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, NULL)
         ON CONFLICT(player_id) DO UPDATE SET
             phone_digits = excluded.phone_digits,
             code_hash = excluded.code_hash,
             code_salt = excluded.code_salt,
             created_at = CURRENT_TIMESTAMP,
             expires_at = excluded.expires_at,
             used_at = NULL`,
        [
            normalizedPlayerId,
            phoneDigits,
            hashLoginCode(normalizedPlayerId, code, salt),
            salt,
            expiresAt,
        ]
    );

    clearLoginAttempts(phoneDigits);
    pruneSiteAuth(db).catch(() => {});

    return {
        ok: true,
        code,
        expiresAt,
        ttlMinutes: Math.round(ttlMs / 60000),
        phoneDigits,
        phoneLast4: phoneDigits.slice(-4),
        player,
    };
}

async function enforceActiveSessionLimit(db, playerId, currentTokenHash) {
    const keepPriorSessions = Math.max(0, MAX_ACTIVE_SESSIONS - 1);
    const activePriorSessions = await db.all(
        `SELECT token_hash
         FROM clover_site_sessions
         WHERE player_id = ?
           AND token_hash <> ?
           AND revoked_at IS NULL
           AND datetime(expires_at) > datetime('now')
         ORDER BY datetime(COALESCE(last_seen_at, created_at)) DESC,
                  datetime(created_at) DESC,
                  rowid DESC`,
        [normalizeJid(playerId), currentTokenHash]
    );

    const excessSessions = activePriorSessions.slice(keepPriorSessions);
    if (!excessSessions.length) return 0;

    const placeholders = excessSessions.map(() => '?').join(', ');
    await db.run(
        `UPDATE clover_site_sessions
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE token_hash IN (${placeholders})
           AND revoked_at IS NULL`,
        excessSessions.map((row) => row.token_hash)
    );
    return excessSessions.length;
}
async function createSessionRecord(db, playerId, phoneDigits, options = {}) {
    let sessionPlayerId = normalizeJid(playerId);
    const directPhonePlayer = await readDirectPhonePlayer(db, phoneDigits);
    const requestedPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [sessionPlayerId]).catch(() => null);
    if (
        !isGhostSitePlayer(requestedPlayer)
        && !isGhostSitePlayer(directPhonePlayer)
        && directPhonePlayer
        && isSafeReleasedSitePlayer(directPhonePlayer)
        && normalizeJid(directPhonePlayer.id) !== sessionPlayerId
    ) {
        sessionPlayerId = normalizeJid(directPhonePlayer.id);
    }

    const token = randomToken();
    const tokenHash = hashSessionToken(token);
    const ttlMs = positiveNumber(options.ttlMs, SESSION_TTL_MS);
    const expiresAt = toIsoDate(Date.now() + ttlMs);

await db.run(
        `INSERT INTO clover_site_sessions
         (token_hash, player_id, phone_digits, created_at, expires_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, NULL)`,
        [tokenHash, sessionPlayerId, extractDigits(phoneDigits) || null, expiresAt]
    );

    await enforceActiveSessionLimit(db, sessionPlayerId, tokenHash);
    return { token, expiresAt };
}

async function createSession(db, playerId, phoneDigits, options = {}) {
    await ensureCloverSiteAuthSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const session = await createSessionRecord(db, playerId, phoneDigits, options);
        await db.exec('COMMIT');
        return session;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function loginWithSiteCode(db, { phone, code } = {}) {
    await ensureCloverSiteAuthSchema(db);

    const phoneDigits = extractDigits(phone);
    const cleanCode = String(code || '').trim();
    if (!phoneDigits || !/^\d{6}$/.test(cleanCode)) {
        return { ok: false, reason: 'invalid_credentials' };
    }

    const attempt = consumeLoginAttempt(phoneDigits);
    if (!attempt.allowed) {
        return {
            ok: false,
            reason: 'rate_limited',
            retryAfterMs: attempt.retryAfterMs,
        };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const rows = await db.all(
            `SELECT *
             FROM clover_site_login_codes
             WHERE phone_digits = ?
               AND used_at IS NULL
               AND datetime(expires_at) > datetime('now')`,
            [phoneDigits]
        );
        const matches = rows.filter((row) => (
            phoneMatches(row.phone_digits, phoneDigits)
            && row.code_hash === hashLoginCode(row.player_id, cleanCode, row.code_salt)
        ));

        if (!matches.length) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'invalid_credentials' };
        }
        if (matches.length > 1) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'ambiguous_phone' };
        }

        const match = matches[0];
        let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [match.player_id]);
        if (!player) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'missing_player' };
        }

        if (!isGhostSitePlayer(player)) {
            const resolved = await resolvePlayerByIdentityGraph(db, match.player_id, match.phone_digits);
            if (resolved.ambiguous) {
                await db.exec('ROLLBACK');
                return { ok: false, reason: 'ambiguous_phone' };
            }
            if (resolved.player && isSafeReleasedSitePlayer(resolved.player)) {
                player = resolved.player;
                match.player_id = normalizeJid(player.id);
            }
        }
        if (!isSafeReleasedSitePlayer(player)) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'player_not_released' };
        }

        const consumed = await db.run(
            `UPDATE clover_site_login_codes
             SET used_at = CURRENT_TIMESTAMP
             WHERE player_id = ?
               AND used_at IS NULL
               AND datetime(expires_at) > datetime('now')`,
            [match.player_id]
        );
        if (Number(consumed?.changes || 0) !== 1) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'code_already_used' };
        }

        const session = await createSessionRecord(db, match.player_id, match.phone_digits);
        await db.exec('COMMIT');
        clearLoginAttempts(phoneDigits);
        pruneSiteAuth(db).catch(() => {});

        return {
            ok: true,
            player,
            token: session.token,
            expiresAt: session.expiresAt,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function authenticateSiteSession(db, token) {
    await ensureCloverSiteAuthSchema(db);

    const cleanToken = String(token || '').trim();
    if (!cleanToken) return { ok: false, reason: 'missing_token' };

    const tokenHash = hashSessionToken(cleanToken);
    const session = await db.get(
        `SELECT *
         FROM clover_site_sessions
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND datetime(expires_at) > datetime('now')`,
        [tokenHash]
    );
    if (!session) return { ok: false, reason: 'invalid_token' };

    let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [session.player_id]);
    if (!player) return { ok: false, reason: 'missing_player' };

    const sessionPhoneDigits = extractDigits(session.phone_digits) || getPlayerPhoneDigits(session.player_id);
    if (!isGhostSitePlayer(player)) {
        const canonicalResolution = await resolvePlayerByIdentityGraph(
            db,
            session.player_id,
            sessionPhoneDigits
        );
        if (canonicalResolution.ambiguous === true) {
            return { ok: false, reason: 'ambiguous_session' };
        }
        const canonicalPlayer = canonicalResolution.player && isSafeReleasedSitePlayer(canonicalResolution.player)
            ? canonicalResolution.player
            : null;
        if (
            canonicalPlayer
            && isSafeReleasedSitePlayer(canonicalPlayer)
            && normalizeJid(canonicalPlayer.id) !== normalizeJid(session.player_id)
        ) {
            const previousPlayerId = session.player_id;
            const migrated = await db.run(
                `UPDATE clover_site_sessions
                 SET player_id = ?
                 WHERE token_hash = ?
                   AND player_id = ?
                   AND revoked_at IS NULL
                   AND datetime(expires_at) > datetime('now')`,
                [normalizeJid(canonicalPlayer.id), tokenHash, previousPlayerId]
            );
            if (Number(migrated?.changes || 0) === 1) {
                session.player_id = normalizeJid(canonicalPlayer.id);
                player = canonicalPlayer;
                console.log('[site-auth] sessao autocorrigida:', {
                    from: maskIdentityForLog(previousPlayerId),
                    to: maskIdentityForLog(session.player_id),
                    phoneLast4: sessionPhoneDigits.slice(-4),
                });
            }
        }
    }

    if (!isSafeReleasedSitePlayer(player)) {
        await db.run(
            `UPDATE clover_site_sessions
             SET revoked_at = CURRENT_TIMESTAMP
             WHERE token_hash = ? AND revoked_at IS NULL`,
            [tokenHash]
        ).catch(() => {});
        return { ok: false, reason: 'player_not_released' };
    }

    const lastSeenAt = parseDatabaseDate(session.last_seen_at);
    if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
        await db.run(
            `UPDATE clover_site_sessions
             SET last_seen_at = CURRENT_TIMESTAMP
             WHERE token_hash = ?`,
            [tokenHash]
        );
    }

    return { ok: true, session, player };
}

async function revokeSiteSession(db, token) {
    await ensureCloverSiteAuthSchema(db);
    const cleanToken = String(token || '').trim();
    if (!cleanToken) return { ok: true };

    await db.run(
        `UPDATE clover_site_sessions
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE token_hash = ?`,
        [hashSessionToken(cleanToken)]
    );
    return { ok: true };
}

module.exports = {
    CODE_TTL_MS,
    LAST_SEEN_WRITE_INTERVAL_MS,
    LOGIN_ATTEMPT_LIMIT,
    LOGIN_ATTEMPT_WINDOW_MS,
    SESSION_TTL_MS,
    authenticateSiteSession,
    createSession,
    createSiteLoginCode,
    extractDigits,
    getJidCandidatesForPhone,
    getPlayerPhoneDigits,
    isGhostSitePlayer,
    maskIdentityForLog,
    loginWithSiteCode,
    parseDatabaseDate,
    pruneSiteAuth,
    resolveBestPlayerByPhone,
    resolvePlayerByIdentityGraph,
    revokeSiteSession,
};
