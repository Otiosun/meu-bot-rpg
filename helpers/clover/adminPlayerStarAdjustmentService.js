'use strict';

const {
    getRecommendedPatent,
    resolvePatent,
} = require('./cavalierService');
const {
    resolvePlayerSquadMembership,
} = require('./squadMembershipReadService');
const {
    readSquadNativeStars,
    recordSquadStarTransactionInTransaction,
} = require('./squadSeasonStarService');

class AdminPlayerStarAdjustmentError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminPlayerStarAdjustmentError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function normalizeStarAdjustmentPayload(payload = {}) {
    const amount = Number(payload.amount ?? payload.delta ?? payload.stars ?? payload.estrelas);
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 100000) {
        throw new AdminPlayerStarAdjustmentError(
            'invalid_star_adjustment',
            'O ajuste de Estrelas precisa ser um inteiro diferente de zero.',
            400
        );
    }
    return {
        amount,
        syncSquad: payload.syncSquad !== false && payload.sync_squad !== false,
    };
}

async function readPlayerStarSnapshot(db, playerId) {
    const player = await db.get(
        `SELECT id, personagem_nome, nome, COALESCE(estrelas, 0) AS estrelas,
                esquadrao, patente
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );
    if (!player) {
        throw new AdminPlayerStarAdjustmentError(
            'player_not_found',
            'Jogador não encontrado.',
            404,
            { playerId }
        );
    }

    const membership = await resolvePlayerSquadMembership(db, player);
    if (!membership.ok && membership.code === 'multiple_active_memberships') {
        throw new AdminPlayerStarAdjustmentError(
            'squad_membership_conflict',
            'O jogador possui mais de um vínculo ativo de esquadrão.',
            409,
            { membershipIds: membership.membershipIds || [] }
        );
    }

    const stars = Math.max(0, Number(player.estrelas || 0));
    const effectiveSquad = membership.ok
        ? {
            key: membership.squadKey,
            name: membership.squadName || membership.squadKey,
            source: membership.source || null,
            mismatch: Boolean(membership.mismatch),
        }
        : null;
    const squadStars = effectiveSquad
        ? await readSquadNativeStars(db, effectiveSquad.key)
        : null;
    const patentPlayer = {
        ...player,
        estrelas: stars,
        esquadrao: effectiveSquad?.name || null,
    };

    return {
        playerId: String(player.id),
        characterName: String(player.personagem_nome || player.nome || player.id),
        stars,
        storedPatent: player.patente || null,
        effectivePatent: resolvePatent(patentPlayer),
        recommendedPatent: effectiveSquad ? getRecommendedPatent(stars) : null,
        squad: effectiveSquad
            ? {
                ...effectiveSquad,
                balance: Number(squadStars?.balance || 0),
                season: Number(squadStars?.season || 0),
                lifetime: Number(squadStars?.lifetime || 0),
                seasonId: squadStars?.seasonId || null,
            }
            : null,
    };
}

function projectedSnapshot(before, amount, syncSquad) {
    const nextStars = before.stars + amount;
    if (nextStars < 0) {
        throw new AdminPlayerStarAdjustmentError(
            'player_stars_below_zero',
            'O ajuste deixaria o jogador com Estrelas negativas.',
            409,
            { before: before.stars, amount }
        );
    }

    const squad = before.squad && syncSquad
        ? {
            ...before.squad,
            balance: before.squad.balance + amount,
        }
        : before.squad;

    if (before.squad && syncSquad && squad.balance < 0) {
        throw new AdminPlayerStarAdjustmentError(
            'squad_stars_below_zero',
            'O ajuste deixaria o saldo atual do esquadrão negativo.',
            409,
            { before: before.squad.balance, amount, squadKey: before.squad.key }
        );
    }

    const effectivePatent = resolvePatent({
        patente: before.storedPatent,
        estrelas: nextStars,
        esquadrao: before.squad?.name || null,
    });

    return {
        ...before,
        stars: nextStars,
        effectivePatent,
        recommendedPatent: before.squad ? getRecommendedPatent(nextStars) : null,
        squad,
    };
}

function sameCurrentState(current, expected, syncSquad) {
    if (Number(current?.stars) !== Number(expected?.stars)) return false;
    const currentKey = current?.squad?.key || null;
    const expectedKey = expected?.squad?.key || null;
    if (currentKey !== expectedKey) return false;
    if (syncSquad && expectedKey) {
        return Number(current?.squad?.balance) === Number(expected?.squad?.balance);
    }
    return true;
}

async function assertCurrentState(db, playerId, expected, syncSquad, code) {
    const current = await readPlayerStarSnapshot(db, playerId);
    if (!sameCurrentState(current, expected, syncSquad)) {
        throw new AdminPlayerStarAdjustmentError(
            code,
            'As Estrelas mudaram depois da prévia. Gere uma nova operação.',
            409,
            { expected, current }
        );
    }
    return current;
}

function createPlayerStarAdjustmentExecutors() {
    return {
        'player.stars.adjust': {
            async preview({ db, action, target }) {
                const { amount, syncSquad } = normalizeStarAdjustmentPayload(action.payload || {});
                const before = await readPlayerStarSnapshot(db, target.playerId);
                const after = projectedSnapshot(before, amount, syncSquad);
                return {
                    summary: `${before.characterName}: ajustar Estrelas em ${amount > 0 ? '+' : ''}${amount}`,
                    before,
                    after: {
                        ...after,
                        delta: amount,
                        syncSquad,
                    },
                    metadata: {
                        delta: amount,
                        syncSquad,
                        squadKey: before.squad?.key || null,
                    },
                };
            },

            async apply({ db, operation, action, target, unit, before }) {
                const { amount, syncSquad } = normalizeStarAdjustmentPayload(action.payload || {});
                await assertCurrentState(
                    db,
                    target.playerId,
                    before,
                    syncSquad,
                    'player_stars_changed_after_preview'
                );

                let squadTransactionId = null;
                if (syncSquad && before.squad?.key) {
                    const squadResult = await recordSquadStarTransactionInTransaction(db, {
                        squadKey: before.squad.key,
                        playerId: target.playerId,
                        amount,
                        kind: 'adjustment',
                        source: 'admin_player_star_adjustment',
                        reason: operation.reason || 'Ajuste administrativo de Estrelas',
                        relatedId: operation.code,
                        transactionKey: `${operation.code}:unit:${unit.id}:stars:squad`,
                        createdBy: operation.actor.id,
                        metadata: {
                            adminOperation: operation.code,
                            playerStarsBefore: before.stars,
                            playerStarsAfter: before.stars + amount,
                        },
                    });
                    squadTransactionId = Number(squadResult.transactionId || 0) || null;
                }

                const updated = await db.run(
                    `UPDATE jogadores
                     SET estrelas = COALESCE(estrelas, 0) + ?
                     WHERE id = ? AND COALESCE(estrelas, 0) = ?`,
                    [amount, target.playerId, before.stars]
                );
                if (Number(updated?.changes || 0) !== 1) {
                    throw new AdminPlayerStarAdjustmentError(
                        'player_stars_changed_during_apply',
                        'O saldo individual mudou durante a aplicação.',
                        409
                    );
                }

                const current = await readPlayerStarSnapshot(db, target.playerId);
                return {
                    before,
                    after: {
                        ...current,
                        delta: amount,
                        syncSquad,
                        squadTransactionId,
                    },
                    summary: `${current.characterName}: Estrelas ajustadas para ${current.stars}.`,
                    metadata: { squadTransactionId },
                };
            },

            async undo({ db, operation, action, target, after }) {
                const { amount, syncSquad } = normalizeStarAdjustmentPayload(action.payload || {});
                await assertCurrentState(
                    db,
                    target.playerId,
                    after,
                    syncSquad,
                    'player_stars_changed_since_apply'
                );

                if (syncSquad && after.squad?.key && after.squadTransactionId) {
                    const latest = await db.get(
                        `SELECT id FROM clover_squad_star_transactions
                         WHERE squad_key = ?
                         ORDER BY id DESC
                         LIMIT 1`,
                        [after.squad.key]
                    );
                    if (Number(latest?.id || 0) !== Number(after.squadTransactionId)) {
                        throw new AdminPlayerStarAdjustmentError(
                            'squad_stars_changed_since_apply',
                            'O esquadrão recebeu outra movimentação de Estrelas; undo automático bloqueado.',
                            409,
                            {
                                expectedTransactionId: Number(after.squadTransactionId),
                                latestTransactionId: Number(latest?.id || 0),
                            }
                        );
                    }

                    await recordSquadStarTransactionInTransaction(db, {
                        squadKey: after.squad.key,
                        playerId: target.playerId,
                        amount: -amount,
                        kind: 'adjustment',
                        source: 'admin_player_star_adjustment_undo',
                        reason: `Desfazer ${operation.code}`,
                        relatedId: operation.code,
                        transactionKey: `${operation.code}:undo:stars:squad`,
                        createdBy: operation.actor.id,
                        metadata: {
                            reversedTransactionId: Number(after.squadTransactionId),
                        },
                    });
                }

                const updated = await db.run(
                    `UPDATE jogadores
                     SET estrelas = COALESCE(estrelas, 0) - ?
                     WHERE id = ? AND COALESCE(estrelas, 0) = ?`,
                    [amount, target.playerId, after.stars]
                );
                if (Number(updated?.changes || 0) !== 1) {
                    throw new AdminPlayerStarAdjustmentError(
                        'player_stars_changed_during_undo',
                        'O saldo individual mudou durante o undo.',
                        409
                    );
                }
            },
        },
    };
}

module.exports = {
    AdminPlayerStarAdjustmentError,
    createPlayerStarAdjustmentExecutors,
    normalizeStarAdjustmentPayload,
    projectedSnapshot,
    readPlayerStarSnapshot,
};
