'use strict';

const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const {
    ensureSquadSeasonStarSchema,
    getActiveSquadSeason,
    grantSquadStarsInTransaction,
    readSquadNativeStars,
} = require('./squadSeasonStarService');

class PlayerStarRewardError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'PlayerStarRewardError';
        this.code = code;
        this.details = details;
    }
}

function positiveInteger(value) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new PlayerStarRewardError('invalid_star_amount', 'A recompensa de Estrelas precisa ser um inteiro positivo.');
    }
    return amount;
}

function safeJson(value) {
    return value && typeof value === 'object' ? JSON.stringify(value) : null;
}

async function ensurePlayerStarRewardSchema(db) {
    await ensureSquadSeasonStarSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_star_reward_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL CHECK (amount > 0),
            player_stars_before INTEGER NOT NULL CHECK (player_stars_before >= 0),
            player_stars_after INTEGER NOT NULL CHECK (player_stars_after >= 0),
            squad_key TEXT DEFAULT NULL,
            squad_transaction_id INTEGER DEFAULT NULL,
            season_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'reversed')),
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            reversed_by TEXT DEFAULT NULL,
            reversed_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_star_reward_player
        ON clover_player_star_reward_transactions (player_id, status, id DESC)
    `);
}

async function ensureSquadProjection(db, squadKey, squadName) {
    if (!squadKey) return;
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(squad_key) DO UPDATE SET
            name = COALESCE(NULLIF(clover_squads.name, ''), excluded.name),
            updated_at = CURRENT_TIMESTAMP`,
        [squadKey, squadName || squadKey]
    );
}

async function getPlayerStarRewardTransaction(db, transactionKey) {
    await ensurePlayerStarRewardSchema(db);
    return db.get(
        'SELECT * FROM clover_player_star_reward_transactions WHERE transaction_key = ?',
        [String(transactionKey || '').trim()]
    );
}

async function grantPlayerStarsInTransaction(db, input = {}) {
    await ensurePlayerStarRewardSchema(db);
    const transactionKey = String(input.transactionKey || '').trim();
    if (!transactionKey) {
        throw new PlayerStarRewardError('missing_star_transaction_key', 'A chave da recompensa de Estrelas é obrigatória.');
    }
    const amount = positiveInteger(input.amount);
    const existing = await getPlayerStarRewardTransaction(db, transactionKey);
    if (existing) {
        if (existing.player_id !== input.playerId || Number(existing.amount) !== amount) {
            throw new PlayerStarRewardError('star_idempotency_conflict', 'A chave desta recompensa pertence a outro lançamento.');
        }
        return {
            ok: true,
            duplicate: true,
            transactionId: Number(existing.id),
            playerId: existing.player_id,
            amount: Number(existing.amount),
            playerStarsBefore: Number(existing.player_stars_before),
            playerStarsAfter: Number(existing.player_stars_after),
            squadKey: existing.squad_key || null,
            squadTransactionId: existing.squad_transaction_id ? Number(existing.squad_transaction_id) : null,
            seasonId: existing.season_id || null,
        };
    }

    const player = await db.get(
        `SELECT id, personagem_nome, nome, esquadrao, COALESCE(estrelas, 0) AS estrelas
         FROM jogadores WHERE id = ?`,
        [input.playerId]
    );
    if (!player) throw new PlayerStarRewardError('player_not_found', 'Jogador não encontrado.');

    const playerStarsBefore = Math.max(0, Number(player.estrelas || 0));
    const playerStarsAfter = playerStarsBefore + amount;
    const squadKey = normalizeSquadKey(input.squadKey || player.esquadrao);
    let squadTransactionId = null;
    let seasonId = null;

    await db.run(
        'UPDATE jogadores SET estrelas = COALESCE(estrelas, 0) + ? WHERE id = ?',
        [amount, player.id]
    );

    if (squadKey) {
        await ensureSquadProjection(db, squadKey, String(player.esquadrao || squadKey).trim() || squadKey);
        const squadResult = await grantSquadStarsInTransaction(db, {
            squadKey,
            playerId: player.id,
            amount,
            source: input.source || 'admin_reward',
            reason: input.reason || 'Recompensa administrativa',
            relatedId: input.relatedId || transactionKey,
            transactionKey: `${transactionKey}:squad`,
            createdBy: input.createdBy || 'system',
            metadata: {
                ...(input.metadata || {}),
                player_star_transaction_key: transactionKey,
            },
        });
        squadTransactionId = Number(squadResult.transactionId);
        seasonId = squadResult.stars?.seasonId || null;
    }

    const inserted = await db.run(
        `INSERT INTO clover_player_star_reward_transactions
         (transaction_key, player_id, amount, player_stars_before, player_stars_after,
          squad_key, squad_transaction_id, season_id, status, source, reason, related_id,
          created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        [
            transactionKey,
            player.id,
            amount,
            playerStarsBefore,
            playerStarsAfter,
            squadKey || null,
            squadTransactionId,
            seasonId,
            input.source || null,
            input.reason || null,
            input.relatedId || null,
            normalizeJid(input.createdBy) || String(input.createdBy || 'system'),
            safeJson(input.metadata || {}),
        ]
    );

    return {
        ok: true,
        duplicate: false,
        transactionId: Number(inserted.lastID),
        playerId: player.id,
        amount,
        playerStarsBefore,
        playerStarsAfter,
        squadKey: squadKey || null,
        squadTransactionId,
        seasonId,
        squadStars: squadKey ? await readSquadNativeStars(db, squadKey) : null,
    };
}

async function latestActivePlayerStarTransaction(db, playerId) {
    return db.get(
        `SELECT * FROM clover_player_star_reward_transactions
         WHERE player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [playerId]
    );
}

async function reverseSquadGrant(db, transaction, input = {}) {
    if (!transaction.squad_key || !transaction.squad_transaction_id) return null;
    const latest = await db.get(
        `SELECT id FROM clover_squad_star_transactions
         WHERE squad_key = ? ORDER BY id DESC LIMIT 1`,
        [transaction.squad_key]
    );
    if (Number(latest?.id || 0) !== Number(transaction.squad_transaction_id)) {
        throw new PlayerStarRewardError(
            'squad_stars_changed_since_reward',
            'O esquadrão recebeu outra movimentação de Estrelas depois desta recompensa.',
            { latestTransactionId: Number(latest?.id || 0), expected: Number(transaction.squad_transaction_id) }
        );
    }

    const amount = Number(transaction.amount);
    const squad = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [transaction.squad_key]);
    if (!squad) throw new PlayerStarRewardError('squad_not_found', 'Esquadrão da recompensa não existe mais.');
    if (Number(squad.current_stars || 0) < amount || Number(squad.historical_stars || 0) < amount) {
        throw new PlayerStarRewardError('insufficient_stars_for_reverse', 'O estado atual de Estrelas não permite desfazer esta recompensa com segurança.');
    }

    await db.run(
        `UPDATE clover_squads
         SET current_stars = current_stars - ?,
             historical_stars = historical_stars - ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [amount, amount, transaction.squad_key]
    );

    if (transaction.season_id) {
        const seasonRow = await db.get(
            `SELECT season_stars FROM clover_squad_season_stars
             WHERE squad_key = ? AND season_id = ?`,
            [transaction.squad_key, transaction.season_id]
        );
        if (Number(seasonRow?.season_stars || 0) < amount) {
            throw new PlayerStarRewardError('season_stars_changed_since_reward', 'A temporada não permite desfazer esta recompensa com segurança.');
        }
        await db.run(
            `UPDATE clover_squad_season_stars
             SET season_stars = season_stars - ?, updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ? AND season_id = ?`,
            [amount, transaction.squad_key, transaction.season_id]
        );
    }

    const inserted = await db.run(
        `INSERT INTO clover_squad_star_transactions
         (transaction_key, squad_key, season_id, player_id, amount, kind, source,
          reason, related_id, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'adjustment', 'admin_reward_undo', ?, ?, ?, ?)`,
        [
            `${transaction.transaction_key}:undo:squad`,
            transaction.squad_key,
            transaction.season_id || null,
            transaction.player_id,
            -amount,
            input.reason || `Desfazer ${transaction.transaction_key}`,
            input.relatedId || transaction.related_id || null,
            normalizeJid(input.createdBy) || String(input.createdBy || 'system'),
            safeJson({ reversed_transaction_id: Number(transaction.squad_transaction_id) }),
        ]
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, evaluation_id, amount, kind, source, reason,
          created_by, created_at, metadata_json)
         VALUES (?, ?, NULL, ?, 'ajuste', 'admin_reward_undo', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            transaction.squad_key,
            transaction.player_id,
            -amount,
            input.reason || `Desfazer ${transaction.transaction_key}`,
            normalizeJid(input.createdBy) || String(input.createdBy || 'system'),
            safeJson({ native_transaction_id: inserted.lastID, reversed_transaction_id: Number(transaction.squad_transaction_id) }),
        ]
    );
    return Number(inserted.lastID);
}

async function reversePlayerStarsInTransaction(db, transactionKey, input = {}) {
    await ensurePlayerStarRewardSchema(db);
    const transaction = await getPlayerStarRewardTransaction(db, transactionKey);
    if (!transaction) throw new PlayerStarRewardError('star_reward_not_found', 'Recompensa de Estrelas não encontrada.');
    if (transaction.status === 'reversed') {
        return { ok: true, duplicate: true, transactionId: Number(transaction.id), status: 'reversed' };
    }

    const latest = await latestActivePlayerStarTransaction(db, transaction.player_id);
    if (Number(latest?.id || 0) !== Number(transaction.id)) {
        throw new PlayerStarRewardError(
            'player_stars_changed_since_reward',
            'O personagem recebeu outra recompensa de Estrelas depois desta e o undo automático foi bloqueado.'
        );
    }
    const player = await db.get('SELECT COALESCE(estrelas, 0) AS estrelas FROM jogadores WHERE id = ?', [transaction.player_id]);
    if (Number(player?.estrelas || 0) !== Number(transaction.player_stars_after)) {
        throw new PlayerStarRewardError(
            'player_star_state_changed',
            'O saldo individual de Estrelas mudou depois desta recompensa.'
        );
    }

    await reverseSquadGrant(db, transaction, input);
    await db.run(
        'UPDATE jogadores SET estrelas = estrelas - ? WHERE id = ?',
        [Number(transaction.amount), transaction.player_id]
    );
    await db.run(
        `UPDATE clover_player_star_reward_transactions
         SET status = 'reversed', reversed_by = ?, reversed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'active'`,
        [normalizeJid(input.createdBy) || String(input.createdBy || 'system'), transaction.id]
    );

    return {
        ok: true,
        duplicate: false,
        transactionId: Number(transaction.id),
        status: 'reversed',
        playerStarsAfter: Number(transaction.player_stars_before),
        squadStars: transaction.squad_key ? await readSquadNativeStars(db, transaction.squad_key) : null,
    };
}

module.exports = {
    PlayerStarRewardError,
    ensurePlayerStarRewardSchema,
    getPlayerStarRewardTransaction,
    grantPlayerStarsInTransaction,
    reversePlayerStarsInTransaction,
};
