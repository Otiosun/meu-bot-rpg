const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ensureCloverSiteAuthSchema } = require('../../database');
const { extractPhoneNumber, normalizeJid } = require('../groupAccess');

const AUTH_INFO_DIR = path.join(process.cwd(), 'auth_info');
const CODE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function toIsoDate(timestamp) {
    return new Date(timestamp).toISOString();
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

function hashLoginCode(playerId, code, salt) {
    return sha256(`${salt}:${normalizeJid(playerId)}:${String(code || '').trim()}`);
}

function hashSessionToken(token) {
    return sha256(`clover-site-session:${String(token || '').trim()}`);
}

function phoneMatches(storedDigits, inputDigits) {
    const stored = extractDigits(storedDigits);
    const input = extractDigits(inputDigits);
    if (!stored || !input) return false;
    if (input.length >= 8) return stored === input;
    if (input.length >= 4) return stored.endsWith(input);
    return false;
}

async function createSiteLoginCode(db, playerId, options = {}) {
    await ensureCloverSiteAuthSchema(db);

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        return { ok: false, reason: 'missing_player' };
    }

    const code = randomCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = toIsoDate(now + Number(options.ttlMs || CODE_TTL_MS));
    const phoneDigits = getPlayerPhoneDigits(playerId);

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
        [playerId, phoneDigits || null, hashLoginCode(playerId, code, salt), salt, expiresAt]
    );

    return {
        ok: true,
        code,
        expiresAt,
        ttlMinutes: Math.round(Number(options.ttlMs || CODE_TTL_MS) / 60000),
        phoneDigits,
        phoneLast4: phoneDigits ? phoneDigits.slice(-4) : '',
        player,
    };
}

async function createSession(db, playerId, phoneDigits) {
    await ensureCloverSiteAuthSchema(db);

    const token = randomToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = toIsoDate(Date.now() + SESSION_TTL_MS);

    await db.run(
        `INSERT INTO clover_site_sessions
         (token_hash, player_id, phone_digits, created_at, expires_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, NULL)`,
        [tokenHash, playerId, phoneDigits || null, expiresAt]
    );

    return { token, expiresAt };
}

async function loginWithSiteCode(db, { phone, code }) {
    await ensureCloverSiteAuthSchema(db);

    const phoneDigits = extractDigits(phone);
    const cleanCode = String(code || '').trim();
    if (!phoneDigits || !/^\d{6}$/.test(cleanCode)) {
        return { ok: false, reason: 'invalid_credentials' };
    }

    const rows = await db.all(
        `SELECT *
         FROM clover_site_login_codes
         WHERE used_at IS NULL
           AND datetime(expires_at) > datetime('now')`
    );

    const matches = rows.filter((row) => phoneMatches(row.phone_digits, phoneDigits)
        && row.code_hash === hashLoginCode(row.player_id, cleanCode, row.code_salt));

    if (!matches.length) {
        return { ok: false, reason: 'invalid_credentials' };
    }
    if (matches.length > 1) {
        return { ok: false, reason: 'ambiguous_phone' };
    }

    const match = matches[0];
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [match.player_id]);
    if (!player) {
        return { ok: false, reason: 'missing_player' };
    }

    await db.run(
        `UPDATE clover_site_login_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [match.player_id]
    );

    const session = await createSession(db, match.player_id, match.phone_digits);
    return {
        ok: true,
        player,
        token: session.token,
        expiresAt: session.expiresAt,
    };
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

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [session.player_id]);
    if (!player) return { ok: false, reason: 'missing_player' };

    await db.run(
        `UPDATE clover_site_sessions
         SET last_seen_at = CURRENT_TIMESTAMP
         WHERE token_hash = ?`,
        [tokenHash]
    );

    return { ok: true, session, player };
}

async function revokeSiteSession(db, token) {
    await ensureCloverSiteAuthSchema(db);
    const tokenHash = hashSessionToken(token);
    await db.run(
        `UPDATE clover_site_sessions
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE token_hash = ?`,
        [tokenHash]
    );
    return { ok: true };
}

module.exports = {
    CODE_TTL_MS,
    SESSION_TTL_MS,
    authenticateSiteSession,
    createSiteLoginCode,
    extractDigits,
    getJidCandidatesForPhone,
    getPlayerPhoneDigits,
    loginWithSiteCode,
    resolveBestPlayerByPhone,
    revokeSiteSession,
};
