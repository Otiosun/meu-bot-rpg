'use strict';

const { ensureCloverCharacterStatsSchema } = require('../../database');

class CharacterStatAdjustmentError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'CharacterStatAdjustmentError';
        this.code = code;
        this.details = details;
    }
}

function asSignedInteger(value) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount === 0) {
        throw new CharacterStatAdjustmentError(
            'invalid_stat_adjustment',
            'O ajuste precisa ser um número inteiro diferente de zero.'
        );
    }
    return amount;
}

function optionalText(value) {
    const text = String(value || '').trim();
    return text || null;
}

async function ensureCharacterStatAdjustmentSchema(db) {
    await ensureCloverCharacterStatsSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_character_stat_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            stat_key TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount != 0),
            value_before INTEGER NOT NULL CHECK (value_before >= 0),
            value_after INTEGER NOT NULL CHECK (value_after >= 0),
            kind TEXT NOT NULL CHECK (kind IN ('ganho', 'penalidade', 'ajuste_admin', 'estorno')),
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            CHECK (value_after = value_before + amount)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_character_stat_player
        ON clover_character_stat_ledger (player_id, stat_key, created_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_character_stat_source
        ON clover_character_stat_ledger (source, related_id)
    `);
}

async function ensurePlayerStats(db, playerId) {
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new CharacterStatAdjustmentError('player_not_found', 'Player não encontrado.');
    await db.run(
        `INSERT OR IGNORE INTO clover_character_stats (player_id, updated_at)
         VALUES (?, CURRENT_TIMESTAMP)`,
        [playerId]
    );
}

async function findIdempotentEntry(db, idempotencyKey) {
    const key = optionalText(idempotencyKey);
    if (!key) return null;
    return db.get('SELECT * FROM clover_character_stat_ledger WHERE idempotency_key = ?', [key]);
}

function mutationResult(row, duplicate = false) {
    return {
        ok: true,
        duplicate,
        ledgerId: Number(row.id),
        playerId: row.player_id,
        statKey: row.stat_key,
        amount: Number(row.amount),
        valueBefore: Number(row.value_before),
        valueAfter: Number(row.value_after),
        kind: row.kind,
        source: row.source || null,
        relatedId: row.related_id || null,
    };
}

async function adjustPoderMagicoInTransaction(db, playerId, amountInput, options = {}) {
    await ensureCharacterStatAdjustmentSchema(db);
    await ensurePlayerStats(db, playerId);

    const amount = asSignedInteger(amountInput);
    const idempotencyKey = optionalText(options.idempotencyKey);
    const duplicate = await findIdempotentEntry(db, idempotencyKey);
    if (duplicate) {
        if (
            duplicate.player_id !== playerId
            || duplicate.stat_key !== 'poder_magico'
            || Number(duplicate.amount) !== amount
        ) {
            throw new CharacterStatAdjustmentError(
                'stat_idempotency_conflict',
                'A identificação deste ajuste pertence a outra alteração.'
            );
        }
        return mutationResult(duplicate, true);
    }

    const stats = await db.get(
        'SELECT poder_magico FROM clover_character_stats WHERE player_id = ?',
        [playerId]
    );
    const valueBefore = Number(stats?.poder_magico || 0);
    const valueAfter = valueBefore + amount;
    if (valueAfter < 0) {
        throw new CharacterStatAdjustmentError(
            'poder_magico_below_zero',
            'A penalidade deixaria o Poder Mágico abaixo de zero.',
            { valueBefore, amount, valueAfter }
        );
    }

    const kind = String(
        options.kind || (amount > 0 ? 'ganho' : 'penalidade')
    ).trim();
    const allowedKinds = new Set(['ganho', 'penalidade', 'ajuste_admin', 'estorno']);
    if (!allowedKinds.has(kind)) {
        throw new CharacterStatAdjustmentError('invalid_stat_kind', 'Tipo de ajuste de atributo inválido.');
    }

    await db.run(
        `UPDATE clover_character_stats
         SET poder_magico = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [valueAfter, playerId]
    );
    const inserted = await db.run(
        `INSERT INTO clover_character_stat_ledger
         (player_id, stat_key, amount, value_before, value_after, kind, source, reason,
          related_id, idempotency_key, created_by, created_at, metadata_json)
         VALUES (?, 'poder_magico', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            playerId,
            amount,
            valueBefore,
            valueAfter,
            kind,
            optionalText(options.source),
            optionalText(options.reason),
            optionalText(options.relatedId),
            idempotencyKey,
            optionalText(options.createdBy),
            options.metadata && typeof options.metadata === 'object'
                ? JSON.stringify(options.metadata)
                : null,
        ]
    );
    const row = await db.get('SELECT * FROM clover_character_stat_ledger WHERE id = ?', [inserted.lastID]);
    return mutationResult(row, false);
}

async function adjustPoderMagico(db, playerId, amount, options = {}) {
    await ensureCharacterStatAdjustmentSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await adjustPoderMagicoInTransaction(db, playerId, amount, options);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getCharacterStatHistory(db, playerId, statKey = 'poder_magico', limit = 20) {
    await ensureCharacterStatAdjustmentSchema(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.all(
        `SELECT * FROM clover_character_stat_ledger
         WHERE player_id = ? AND stat_key = ?
         ORDER BY id DESC LIMIT ?`,
        [playerId, statKey, safeLimit]
    );
}

module.exports = {
    CharacterStatAdjustmentError,
    adjustPoderMagico,
    adjustPoderMagicoInTransaction,
    ensureCharacterStatAdjustmentSchema,
    getCharacterStatHistory,
};
