'use strict';

function normalizeStatus(value) {
    return String(value || '').trim().toLowerCase();
}

function isReleased(value) {
    return normalizeStatus(value) === 'liberado';
}

function isApprovedProfile(value) {
    return ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizeStatus(value));
}

function isPendingAppearance(value) {
    return ['pending', 'pendente'].includes(normalizeStatus(value));
}

async function readProfileAccessSnapshot(db, playerId) {
    return db.get(
        `SELECT id,
                ficha_status,
                personagem_aparencia_status,
                jogo_status,
                jogo_liberado_at,
                jogo_liberado_by,
                jogo_bloqueio_motivo
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );
}

function matchesProfileConfirmationResetSignature(player) {
    return Boolean(player)
        && isApprovedProfile(player.ficha_status)
        && isPendingAppearance(player.personagem_aparencia_status)
        && normalizeStatus(player.jogo_status) === 'bloqueado'
        && !player.jogo_liberado_at
        && !player.jogo_liberado_by
        && !player.jogo_bloqueio_motivo;
}

async function restoreReleasedAccessAfterProfileConfirmation(db, playerId, beforeSnapshot) {
    if (!beforeSnapshot || !isReleased(beforeSnapshot.jogo_status)) {
        return {
            restored: false,
            skipped: true,
            reason: 'player_was_not_released',
            player: await readProfileAccessSnapshot(db, playerId),
        };
    }

    const current = await readProfileAccessSnapshot(db, playerId);
    if (!matchesProfileConfirmationResetSignature(current)) {
        return {
            restored: false,
            skipped: true,
            reason: 'current_state_does_not_match_profile_reset',
            player: current,
        };
    }

    const result = await db.run(
        `UPDATE jogadores
         SET jogo_status = 'liberado',
             jogo_liberado_at = ?,
             jogo_liberado_by = ?,
             jogo_bloqueio_motivo = NULL
         WHERE id = ?
           AND ficha_status IN ('aprovada', 'aprovado', 'confirmada', 'confirmado')
           AND personagem_aparencia_status IN ('pending', 'pendente')
           AND LOWER(COALESCE(jogo_status, '')) = 'bloqueado'
           AND jogo_liberado_at IS NULL
           AND jogo_liberado_by IS NULL
           AND jogo_bloqueio_motivo IS NULL`,
        [
            beforeSnapshot.jogo_liberado_at || null,
            beforeSnapshot.jogo_liberado_by || null,
            playerId,
        ]
    );

    const player = await readProfileAccessSnapshot(db, playerId);
    return {
        restored: Number(result?.changes || 0) === 1,
        skipped: Number(result?.changes || 0) !== 1,
        reason: Number(result?.changes || 0) === 1 ? null : 'conditional_update_not_applied',
        player,
    };
}

module.exports = {
    matchesProfileConfirmationResetSignature,
    readProfileAccessSnapshot,
    restoreReleasedAccessAfterProfileConfirmation,
};
