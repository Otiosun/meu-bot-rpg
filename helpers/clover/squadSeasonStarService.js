'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');

const DEFAULT_SEASON_ID = 'season-2026';
const DEFAULT_SEASON_NAME = 'Temporada 2026';

class SquadSeasonStarError extends Error {
    constructor(message, code = 'squad_season_star_error', details = null) {
        super(message);
        this.name = 'SquadSeasonStarError';
        this.code = code;
        this.details = details;
    }
}

function safeInteger(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.trunc(number);
}

function readStoredNonNegativeInteger(value, field, details = {}) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new SquadSeasonStarError(
            'Integridade de Estrelas violada: valor armazenado invalido.',
            'star_integrity_violation',
            {
                ...details,
                field,
                value,
            }
        );
    }
    return number;
}

function serializeMetadata(value) {
    return value && typeof value === 'object' ? JSON.stringify(value) : null;
}

function normalizeKind(value) {
    const kind = String(value || '').trim().toLowerCase();
    if (['grant', 'purchase', 'adjustment'].includes(kind)) return kind;
    throw new SquadSeasonStarError('Tipo de movimentacao de Estrelas invalido.', 'invalid_star_transaction_kind', { kind });
}

function activeSeasonRowFallback() {
    return {
        season_id: DEFAULT_SEASON_ID,
        name: DEFAULT_SEASON_NAME,
        status: 'active',
    };
}

async function ensureSquadSeasonStarSchema(db) {
    await ensureCloverSquadSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_seasons (
            season_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('draft', 'active', 'closed', 'archived')),
            starts_at TEXT DEFAULT NULL,
            ends_at TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_squad_seasons_single_active
        ON clover_squad_seasons (status)
        WHERE status = 'active'
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_season_stars (
            squad_key TEXT NOT NULL,
            season_id TEXT NOT NULL,
            season_stars INTEGER NOT NULL DEFAULT 0 CHECK (season_stars >= 0),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (squad_key, season_id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_season_stars_ranking
        ON clover_squad_season_stars (season_id, season_stars DESC, squad_key ASC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_star_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_key TEXT DEFAULT NULL UNIQUE,
            squad_key TEXT NOT NULL,
            season_id TEXT DEFAULT NULL,
            player_id TEXT DEFAULT NULL,
            amount INTEGER NOT NULL CHECK (amount != 0),
            kind TEXT NOT NULL CHECK (kind IN ('grant', 'purchase', 'adjustment')),
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_star_transactions_squad
        ON clover_squad_star_transactions (squad_key, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_star_transactions_season
        ON clover_squad_star_transactions (season_id, squad_key, created_at DESC, id DESC)
    `);

    await db.run(
        `INSERT OR IGNORE INTO clover_squad_seasons
         (season_id, name, status, created_by, metadata_json)
         VALUES (?, ?, 'active', 'system', ?)`,
        [DEFAULT_SEASON_ID, DEFAULT_SEASON_NAME, serializeMetadata({ automatic_default: true })]
    );
}

async function getActiveSquadSeason(db) {
    await ensureSquadSeasonStarSchema(db);
    return await db.get(
        "SELECT * FROM clover_squad_seasons WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    ) || activeSeasonRowFallback();
}

async function ensureSquadSeasonRow(db, squadKey, seasonId) {
    await db.run(
        `INSERT OR IGNORE INTO clover_squad_season_stars
         (squad_key, season_id, season_stars)
         VALUES (?, ?, 0)`,
        [squadKey, seasonId]
    );
}

async function readSquadNativeStars(db, squadInput) {
    await ensureSquadSeasonStarSchema(db);
    const squadKey = normalizeSquadKey(squadInput?.squad_key || squadInput?.name || squadInput);
    if (!squadKey) return null;
    const squad = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [squadKey]);
    if (!squad) return null;
    const season = await getActiveSquadSeason(db);
    await ensureSquadSeasonRow(db, squad.squad_key, season.season_id);
    const seasonRow = await db.get(
        `SELECT season_stars FROM clover_squad_season_stars
         WHERE squad_key = ? AND season_id = ?`,
        [squad.squad_key, season.season_id]
    );
    const integrityDetails = {
        squadKey: squad.squad_key,
        seasonId: season.season_id,
    };
    return {
        balance: readStoredNonNegativeInteger(
            squad.current_stars,
            'clover_squads.current_stars',
            integrityDetails
        ),
        season: readStoredNonNegativeInteger(
            seasonRow?.season_stars,
            'clover_squad_season_stars.season_stars',
            integrityDetails
        ),
        lifetime: readStoredNonNegativeInteger(
            squad.historical_stars,
            'clover_squads.historical_stars',
            integrityDetails
        ),
        black: readStoredNonNegativeInteger(
            squad.black_stars,
            'clover_squads.black_stars',
            integrityDetails
        ),
        seasonId: season.season_id,
        seasonName: season.name,
    };
}

async function writeLegacyLedger(db, {
    squadKey,
    playerId = null,
    amount,
    kind,
    source,
    reason,
    createdBy,
    metadata = {},
}) {
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, evaluation_id, amount, kind, source, reason,
          created_by, created_at, metadata_json)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            squadKey,
            playerId ? normalizeJid(playerId) : null,
            amount,
            kind,
            source || null,
            reason || null,
            normalizeJid(createdBy) || String(createdBy || 'system'),
            serializeMetadata(metadata),
        ]
    );
}

async function recordSquadStarTransactionInTransaction(db, {
    squadKey,
    playerId = null,
    amount,
    kind,
    source = null,
    reason = null,
    relatedId = null,
    transactionKey = null,
    createdBy = 'system',
    metadata = {},
}) {
    await ensureSquadSeasonStarSchema(db);
    const normalizedSquad = normalizeSquadKey(squadKey);
    const delta = safeInteger(amount);
    const action = normalizeKind(kind);
    if (!normalizedSquad) {
        throw new SquadSeasonStarError('Esquadrao invalido para Estrelas.', 'invalid_squad');
    }
    if (!delta) {
        throw new SquadSeasonStarError('A movimentacao precisa alterar Estrelas.', 'invalid_star_amount');
    }

    const squad = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [normalizedSquad]);
    if (!squad) throw new SquadSeasonStarError('Esquadrao nao encontrado.', 'squad_not_found', { squadKey });

    if (transactionKey) {
        const existing = await db.get(
            'SELECT * FROM clover_squad_star_transactions WHERE transaction_key = ?',
            [String(transactionKey)]
        );
        if (existing) {
            return {
                ok: true,
                duplicate: true,
                transactionId: Number(existing.id),
                stars: await readSquadNativeStars(db, normalizedSquad),
            };
        }
    }

    const season = await getActiveSquadSeason(db);
    await ensureSquadSeasonRow(db, normalizedSquad, season.season_id);

    const balanceBefore = readStoredNonNegativeInteger(
        squad.current_stars,
        'clover_squads.current_stars',
        { squadKey: normalizedSquad }
    );
    readStoredNonNegativeInteger(
        squad.historical_stars,
        'clover_squads.historical_stars',
        { squadKey: normalizedSquad }
    );
    readStoredNonNegativeInteger(
        squad.black_stars,
        'clover_squads.black_stars',
        { squadKey: normalizedSquad }
    );

    const balanceAfter = balanceBefore + delta;
    if (delta < 0 && balanceAfter < 0) {
        throw new SquadSeasonStarError('Estrelas atuais insuficientes.', 'insufficient_stars', {
            balance: balanceBefore,
            amount: delta,
            kind: action,
        });
    }

    const increasesSeason = action === 'grant' && delta > 0;
    const increasesLifetime = action === 'grant' && delta > 0;
    const updatedBalance = await db.run(
        `UPDATE clover_squads
         SET current_stars = current_stars + ?,
             historical_stars = historical_stars + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?
           AND current_stars = ?
           AND current_stars + ? >= 0`,
        [delta, increasesLifetime ? delta : 0, normalizedSquad, balanceBefore, delta]
    );
    if (Number(updatedBalance.changes || 0) !== 1) {
        const current = await db.get(
            'SELECT current_stars FROM clover_squads WHERE squad_key = ?',
            [normalizedSquad]
        );
        const currentBalance = Number(current?.current_stars);
        if (!Number.isSafeInteger(currentBalance) || currentBalance < 0) {
            throw new SquadSeasonStarError(
                'Integridade de Estrelas violada: saldo armazenado invalido.',
                'star_integrity_violation',
                {
                    squadKey: normalizedSquad,
                    field: 'clover_squads.current_stars',
                    value: current?.current_stars,
                }
            );
        }
        throw new SquadSeasonStarError(
            'O saldo mudou durante a movimentacao. Tente novamente.',
            'star_balance_conflict',
            {
                squadKey: normalizedSquad,
                expectedBalance: balanceBefore,
                currentBalance,
                amount: delta,
            }
        );
    }

    const confirmed = await db.get(
        'SELECT current_stars FROM clover_squads WHERE squad_key = ?',
        [normalizedSquad]
    );
    const confirmedBalance = readStoredNonNegativeInteger(
        confirmed?.current_stars,
        'clover_squads.current_stars',
        { squadKey: normalizedSquad }
    );
    if (confirmedBalance !== balanceAfter) {
        throw new SquadSeasonStarError(
            'O saldo posterior nao corresponde ao delta aplicado.',
            'star_balance_postcondition_failed',
            {
                squadKey: normalizedSquad,
                balanceBefore,
                expectedBalance: balanceAfter,
                currentBalance: confirmedBalance,
                amount: delta,
            }
        );
    }
    if (increasesSeason) {
        await db.run(
            `UPDATE clover_squad_season_stars
             SET season_stars = season_stars + ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ? AND season_id = ?`,
            [delta, normalizedSquad, season.season_id]
        );
    }

    const inserted = await db.run(
        `INSERT INTO clover_squad_star_transactions
         (transaction_key, squad_key, season_id, player_id, amount, kind, source,
          reason, related_id, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            transactionKey || null,
            normalizedSquad,
            season.season_id,
            playerId ? normalizeJid(playerId) : null,
            delta,
            action,
            source,
            reason,
            relatedId,
            normalizeJid(createdBy) || String(createdBy || 'system'),
            serializeMetadata({
                ...metadata,
                balance_before: balanceBefore,
                balance_after: confirmedBalance,
                season_id: season.season_id,
            }),
        ]
    );

    await writeLegacyLedger(db, {
        squadKey: normalizedSquad,
        playerId,
        amount: delta,
        kind: delta < 0 ? 'gasto' : 'ganho',
        source,
        reason,
        createdBy,
        metadata: {
            ...metadata,
            native_transaction_id: inserted.lastID,
            balance_before: balanceBefore,
            balance_after: confirmedBalance,
            season_id: season.season_id,
        },
    });

    return {
        ok: true,
        duplicate: false,
        transactionId: Number(inserted.lastID),
        stars: await readSquadNativeStars(db, normalizedSquad),
    };
}

async function grantSquadStarsInTransaction(db, input) {
    return recordSquadStarTransactionInTransaction(db, {
        ...input,
        kind: 'grant',
        amount: Math.abs(safeInteger(input.amount)),
    });
}

async function purchaseSquadStarsInTransaction(db, input) {
    return recordSquadStarTransactionInTransaction(db, {
        ...input,
        kind: 'purchase',
        amount: -Math.abs(safeInteger(input.amount)),
    });
}

async function openSquadSeason(db, {
    seasonId,
    name,
    startsAt = null,
    endsAt = null,
    createdBy = 'system',
    squadKeys = null,
    metadata = {},
} = {}) {
    await ensureSquadSeasonStarSchema(db);
    const id = String(seasonId || '').trim();
    const label = String(name || '').trim();
    if (!id || !label) {
        throw new SquadSeasonStarError('Informe id e nome da temporada.', 'invalid_season');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            "UPDATE clover_squad_seasons SET status = 'closed' WHERE status = 'active' AND season_id <> ?",
            [id]
        );
        await db.run(
            `INSERT INTO clover_squad_seasons
             (season_id, name, status, starts_at, ends_at, created_by, metadata_json)
             VALUES (?, ?, 'active', ?, ?, ?, ?)
             ON CONFLICT(season_id) DO UPDATE SET
                name = excluded.name,
                status = 'active',
                starts_at = excluded.starts_at,
                ends_at = excluded.ends_at,
                metadata_json = excluded.metadata_json`,
            [id, label, startsAt, endsAt, normalizeJid(createdBy) || String(createdBy || 'system'), serializeMetadata(metadata)]
        );
        const keys = Array.isArray(squadKeys) && squadKeys.length
            ? squadKeys.map(normalizeSquadKey).filter(Boolean)
            : (await db.all('SELECT squad_key FROM clover_squads ORDER BY squad_key')).map((row) => row.squad_key);
        for (const squadKey of keys) {
            await ensureSquadSeasonRow(db, squadKey, id);
        }
        await db.exec('COMMIT');
        return { ok: true, seasonId: id, name: label, squadCount: keys.length };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    DEFAULT_SEASON_ID,
    DEFAULT_SEASON_NAME,
    SquadSeasonStarError,
    ensureSquadSeasonStarSchema,
    getActiveSquadSeason,
    grantSquadStarsInTransaction,
    openSquadSeason,
    purchaseSquadStarsInTransaction,
    readSquadNativeStars,
    recordSquadStarTransactionInTransaction,
};
