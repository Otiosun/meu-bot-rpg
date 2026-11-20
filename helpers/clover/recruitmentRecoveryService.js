'use strict';
const {findEligibleFirstUp}=require('./recruitmentUpEvidence');

function normalizeEventKey(value) {
    return String(value || 'divulgacao_v1').trim() || 'divulgacao_v1';
}

async function findPendingReferralWithExistingUp(db, playerId, options = {}) {
    const eventKey = normalizeEventKey(options.eventKey);
    const player = await db.get(
        `SELECT id, jogo_status, jogo_liberado_at
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );
    if (!player || String(player.jogo_status || '').trim().toLowerCase() !== 'liberado') {
        return { ok: true, recoverable: false, reason: 'game_not_released', player: player || null };
    }

    const referral = await db.get(
        `SELECT r.*
         FROM clover_recruitment_referrals r
         JOIN clover_recruitment_events e ON e.id = r.event_id
         WHERE e.event_key = ?
           AND r.recruit_player_id = ?
           AND r.status IN ('pending', 'validated')
         ORDER BY r.id ASC
         LIMIT 1`,
        [eventKey, playerId]
    );
    if (!referral) {
        return { ok: true, recoverable: false, reason: 'no_pending_referral', player };
    }

    const evaluation=await findEligibleFirstUp(db,playerId,player.jogo_liberado_at);
    if (!evaluation) {
        return { ok: true, recoverable: false, reason: 'waiting_first_up', player, referral };
    }

    return {
        ok: true,
        recoverable: true,
        reason: 'existing_first_up',
        player,
        referral,
        evaluation,
    };
}

async function retryPendingReferralFromExistingUp(db, playerId, options = {}) {
    const candidate = await findPendingReferralWithExistingUp(db, playerId, options);
    if (!candidate.recoverable) {
        return { ...candidate, validated: false, attempted: false };
    }
    if (typeof options.deliver !== 'function') {
        throw new TypeError('A recuperação exige uma função de entrega transacional.');
    }

    const result = await options.deliver(
        db,
        candidate.referral,
        candidate.evaluation,
        options.actorId || 'system:recruitment-recovery'
    );
    return {
        ...result,
        validated: true,
        attempted: true,
        recovered: !result.duplicate,
        evaluation: candidate.evaluation,
    };
}

module.exports = {
    findPendingReferralWithExistingUp,
    retryPendingReferralFromExistingUp,
};
