'use strict';

const crypto = require('crypto');

const { normalizeJid } = require('../groupAccess');
const {
    extractDigits,
    getPlayerPhoneDigits,
    parseDatabaseDate,
} = require('./siteAuthService');
const { assertReturnPointShopBuyerEligible } = require('./returnPointShopGateService');
const { withImmediateTransaction } = require('./sqliteImmediateTransactionService');

const DEFAULT_CODE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
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

const CODE_TTL_MS = positiveEnvNumber('CLOVER_RETURN_SHOP_CODE_TTL_MS', DEFAULT_CODE_TTL_MS);
const SESSION_TTL_MS = positiveEnvNumber('CLOVER_RETURN_SHOP_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS);
const loginAttempts = new Map();

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
    return `clv_rs_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashLoginCode(playerId, code, salt) {
    return sha256(`return-shop-code:${salt}:${normalizeJid(playerId)}:${String(code || '').trim()}`);
}

function hashSessionToken(token) {
    return sha256(`return-shop-session:${String(token || '').trim()}`);
}

function consumeLoginAttempt(phoneDigits) {
    const key = extractDigits(phoneDigits);
    if (!key) return { allowed:false, retryAfterMs:LOGIN_ATTEMPT_WINDOW_MS };
    const now = Date.now();
    const current = loginAttempts.get(key);
    if (!current || now - current.startedAt >= LOGIN_ATTEMPT_WINDOW_MS) {
        loginAttempts.set(key, { startedAt:now, count:1 });
        return { allowed:true, retryAfterMs:0 };
    }
    if (current.count >= LOGIN_ATTEMPT_LIMIT) {
        return {
            allowed:false,
            retryAfterMs:Math.max(0, LOGIN_ATTEMPT_WINDOW_MS - (now - current.startedAt)),
        };
    }
    current.count += 1;
    return { allowed:true, retryAfterMs:0 };
}

function clearLoginAttempts(phoneDigits) {
    loginAttempts.delete(extractDigits(phoneDigits));
}

async function pruneReturnShopAuth(db) {
    await db.run(
        `DELETE FROM clover_return_shop_login_codes
         WHERE datetime(expires_at) <= datetime('now', '-1 day')`
    ).catch(() => {});
    await db.run(
        `DELETE FROM clover_return_shop_sessions
         WHERE datetime(expires_at) <= datetime('now', '-1 day')
            OR (revoked_at IS NOT NULL AND datetime(revoked_at) <= datetime('now', '-1 day'))`
    ).catch(() => {});
}

async function createReturnShopLoginCode(db, playerId, options = {}) {
    const id = normalizeJid(playerId);
    if (!id) return { ok:false, reason:'missing_player' };

    const player = await db.get('SELECT * FROM jogadores WHERE id=?', [id]);
    if (!player) return { ok:false, reason:'missing_player' };

    const phoneDigits = getPlayerPhoneDigits(id);
    if (!phoneDigits) return { ok:false, reason:'missing_phone' };

    await assertReturnPointShopBuyerEligible(db, id);

    const code = randomCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const ttlMs = positiveNumber(options.ttlMs, CODE_TTL_MS);
    const expiresAt = toIsoDate(Date.now() + ttlMs);

    await db.run(
        `INSERT INTO clover_return_shop_login_codes
         (player_id,phone_digits,code_hash,code_salt,created_at,expires_at,used_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,NULL)
         ON CONFLICT(player_id) DO UPDATE SET
             phone_digits=excluded.phone_digits,
             code_hash=excluded.code_hash,
             code_salt=excluded.code_salt,
             created_at=CURRENT_TIMESTAMP,
             expires_at=excluded.expires_at,
             used_at=NULL`,
        [id, phoneDigits, hashLoginCode(id, code, salt), salt, expiresAt]
    );

    clearLoginAttempts(phoneDigits);
    pruneReturnShopAuth(db).catch(() => {});
    return {
        ok:true,
        scope:'return_shop',
        code,
        expiresAt,
        ttlMinutes:Math.round(ttlMs / 60000),
        phoneDigits,
        phoneLast4:phoneDigits.slice(-4),
        player,
    };
}

async function createSessionRecord(db, playerId, phoneDigits, options = {}) {
    const id = normalizeJid(playerId);
    const token = randomToken();
    const tokenHash = hashSessionToken(token);
    const ttlMs = positiveNumber(options.ttlMs, SESSION_TTL_MS);
    const expiresAt = toIsoDate(Date.now() + ttlMs);

    await db.run(
        `UPDATE clover_return_shop_sessions
         SET revoked_at=CURRENT_TIMESTAMP
         WHERE player_id=? AND revoked_at IS NULL`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_return_shop_sessions
         (token_hash,player_id,phone_digits,created_at,expires_at,last_seen_at,revoked_at)
         VALUES (?,?,?,CURRENT_TIMESTAMP,?,CURRENT_TIMESTAMP,NULL)`,
        [tokenHash, id, extractDigits(phoneDigits), expiresAt]
    );
    return { token, tokenHash, expiresAt };
}

async function loginWithReturnShopCode(db, { phone, code } = {}) {
    const phoneDigits = extractDigits(phone);
    const cleanCode = String(code || '').trim();
    if (!phoneDigits || !/^\d{6}$/.test(cleanCode)) {
        return { ok:false, reason:'invalid_credentials' };
    }

    const attempt = consumeLoginAttempt(phoneDigits);
    if (!attempt.allowed) {
        return { ok:false, reason:'rate_limited', retryAfterMs:attempt.retryAfterMs };
    }

    const result = await withImmediateTransaction(db, async () => {
        const rows = await db.all(
            `SELECT * FROM clover_return_shop_login_codes
             WHERE phone_digits=?
               AND used_at IS NULL
               AND datetime(expires_at) > datetime('now')`,
            [phoneDigits]
        );
        const matches = rows.filter((row) => (
            row.code_hash === hashLoginCode(row.player_id, cleanCode, row.code_salt)
        ));
        if (!matches.length) return { ok:false, reason:'invalid_credentials' };
        if (matches.length > 1) return { ok:false, reason:'ambiguous_phone' };

        const match = matches[0];
        const player = await db.get('SELECT * FROM jogadores WHERE id=?', [match.player_id]);
        if (!player) return { ok:false, reason:'missing_player' };

        await assertReturnPointShopBuyerEligible(db, match.player_id);

        const consumed = await db.run(
            `UPDATE clover_return_shop_login_codes
             SET used_at=CURRENT_TIMESTAMP
             WHERE player_id=?
               AND used_at IS NULL
               AND datetime(expires_at) > datetime('now')`,
            [match.player_id]
        );
        if (Number(consumed?.changes || 0) !== 1) {
            return { ok:false, reason:'code_already_used' };
        }

        const session = await createSessionRecord(db, match.player_id, match.phone_digits);
        return {
            ok:true,
            scope:'return_shop',
            player,
            token:session.token,
            expiresAt:session.expiresAt,
        };
    });

    if (result.ok) {
        clearLoginAttempts(phoneDigits);
        pruneReturnShopAuth(db).catch(() => {});
    }
    return result;
}

async function authenticateReturnShopSession(db, token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken || !cleanToken.startsWith('clv_rs_')) {
        return { ok:false, reason:cleanToken ? 'invalid_token' : 'missing_token' };
    }

    const tokenHash = hashSessionToken(cleanToken);
    const session = await db.get(
        `SELECT * FROM clover_return_shop_sessions
         WHERE token_hash=?
           AND revoked_at IS NULL
           AND datetime(expires_at) > datetime('now')`,
        [tokenHash]
    );
    if (!session) return { ok:false, reason:'invalid_token' };

    const player = await db.get('SELECT * FROM jogadores WHERE id=?', [session.player_id]);
    if (!player) return { ok:false, reason:'missing_player' };

    try {
        await assertReturnPointShopBuyerEligible(db, session.player_id);
    } catch (error) {
        await db.run(
            `UPDATE clover_return_shop_sessions
             SET revoked_at=CURRENT_TIMESTAMP
             WHERE token_hash=? AND revoked_at IS NULL`,
            [tokenHash]
        ).catch(() => {});
        return { ok:false, reason:error?.code || 'session_ineligible' };
    }

    const lastSeenAt = parseDatabaseDate(session.last_seen_at);
    if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
        await db.run(
            'UPDATE clover_return_shop_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token_hash=?',
            [tokenHash]
        );
    }
    return { ok:true, scope:'return_shop', session, player };
}

async function revokeReturnShopSession(db, token) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) return { ok:true };
    await db.run(
        `UPDATE clover_return_shop_sessions
         SET revoked_at=CURRENT_TIMESTAMP
         WHERE token_hash=?`,
        [hashSessionToken(cleanToken)]
    );
    return { ok:true };
}

module.exports = {
    CODE_TTL_MS,
    LAST_SEEN_WRITE_INTERVAL_MS,
    LOGIN_ATTEMPT_LIMIT,
    LOGIN_ATTEMPT_WINDOW_MS,
    SESSION_TTL_MS,
    authenticateReturnShopSession,
    createReturnShopLoginCode,
    hashSessionToken,
    loginWithReturnShopCode,
    pruneReturnShopAuth,
    revokeReturnShopSession,
};
