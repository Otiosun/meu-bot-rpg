'use strict';

const RETURN_POINT_SHOP_AUTH_VERSION = 43;
const RETURN_POINT_SHOP_AUTH_KEY = '0043_return_point_shop_scoped_auth';

const RETURN_POINT_SHOP_AUTH_OBJECTS = Object.freeze([
    Object.freeze({ type:'table', name:'clover_return_shop_login_codes', table:'clover_return_shop_login_codes', sql:`
CREATE TABLE clover_return_shop_login_codes (
    player_id TEXT PRIMARY KEY,
    phone_digits TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    used_at TEXT
)
`}),
    Object.freeze({ type:'index', name:'idx_return_shop_login_codes_phone', table:'clover_return_shop_login_codes', sql:`
CREATE INDEX idx_return_shop_login_codes_phone
ON clover_return_shop_login_codes (phone_digits, expires_at, used_at)
`}),
    Object.freeze({ type:'table', name:'clover_return_shop_sessions', table:'clover_return_shop_sessions', sql:`
CREATE TABLE clover_return_shop_sessions (
    token_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    phone_digits TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
)
`}),
    Object.freeze({ type:'index', name:'idx_return_shop_sessions_player', table:'clover_return_shop_sessions', sql:`
CREATE INDEX idx_return_shop_sessions_player
ON clover_return_shop_sessions (player_id, revoked_at, expires_at)
`}),
]);

function normalizeSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectReturnPointShopAuthSchemaState(db) {
    const names = RETURN_POINT_SHOP_AUTH_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = RETURN_POINT_SHOP_AUTH_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        return Object.freeze({
            name: expected.name,
            exists: Boolean(observed),
            exact: Boolean(observed)
                && observed.type === expected.type
                && observed.tbl_name === expected.table
                && normalizeSql(observed.sql) === normalizeSql(expected.sql),
        });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind:'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind:'exact', objects });
    return Object.freeze({ kind:'partial_or_divergent', objects });
}

async function createReturnPointShopAuthObjects(db) {
    for (const object of RETURN_POINT_SHOP_AUTH_OBJECTS) await db.exec(object.sql);
}

const RETURN_POINT_SHOP_AUTH_MIGRATION = Object.freeze({
    version: RETURN_POINT_SHOP_AUTH_VERSION,
    key: RETURN_POINT_SHOP_AUTH_KEY,
    description: 'Cria autenticacao temporaria isolada e exclusiva da Loja de Retorno.',
    checksumMaterial: Object.freeze({
        objects: RETURN_POINT_SHOP_AUTH_OBJECTS,
        revision: 'return-point-shop-scoped-auth-v1',
    }),
    async up(db) {
        const before = await inspectReturnPointShopAuthSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema de auth da Loja de Retorno parcial/divergente exige reconciliacao explicita.');
            error.code = 'return_point_shop_auth_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createReturnPointShopAuthObjects(db);
        const after = await inspectReturnPointShopAuthSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0043 nao produziu o schema canonico de auth da Loja de Retorno.');
            error.code = 'return_point_shop_auth_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    RETURN_POINT_SHOP_AUTH_KEY,
    RETURN_POINT_SHOP_AUTH_MIGRATION,
    RETURN_POINT_SHOP_AUTH_OBJECTS,
    RETURN_POINT_SHOP_AUTH_VERSION,
    createReturnPointShopAuthObjects,
    inspectReturnPointShopAuthSchemaState,
    normalizeSql,
};
