const { assertLifecycleAllowed } = require('./lifecyclePolicy');

async function approvePlayerStory(db, { playerId, actorId, releaseGame }) {
    assertLifecycleAllowed({ surface: 'internal', operation: 'story.approve', mutationClass: 'CURRENT_WORLD' });
    return db.run(
        `UPDATE jogadores
         SET historia_status = 'aprovada',
             historia_aprovada_at = CURRENT_TIMESTAMP,
             historia_aprovada_by = ?,
             historia_status_updated_at = CURRENT_TIMESTAMP,
             historia_motivo = NULL,
             jogo_status = CASE WHEN ? = 1 THEN 'liberado' WHEN jogo_status = 'liberado' THEN jogo_status ELSE 'historia_aprovada' END,
             jogo_liberado_at = CASE WHEN ? = 1 THEN COALESCE(jogo_liberado_at, CURRENT_TIMESTAMP) ELSE jogo_liberado_at END,
             jogo_liberado_by = CASE WHEN ? = 1 THEN COALESCE(jogo_liberado_by, ?) ELSE jogo_liberado_by END,
             jogo_bloqueio_motivo = CASE WHEN ? = 1 THEN NULL ELSE jogo_bloqueio_motivo END
         WHERE id = ?`,
        [actorId, releaseGame ? 1 : 0, releaseGame ? 1 : 0, releaseGame ? 1 : 0,
            actorId, releaseGame ? 1 : 0, playerId]
    );
}

async function denyPlayerStory(db, { playerId, reason }) {
    assertLifecycleAllowed({ surface: 'internal', operation: 'story.denyStory', mutationClass: 'CURRENT_WORLD' });
    return db.run(
        `UPDATE jogadores
         SET historia_status = 'negada',
             historia_status_updated_at = CURRENT_TIMESTAMP,
             historia_motivo = ?,
             jogo_status = 'aguardando_historia',
             jogo_bloqueio_motivo = ?
         WHERE id = ?`,
        [reason || null, reason || null, playerId]
    );
}

async function releasePlayerGame(db, { playerId, actorId }) {
    assertLifecycleAllowed({ surface: 'internal', operation: 'releaseGame', mutationClass: 'CURRENT_WORLD' });
    return db.run(
        `UPDATE jogadores
         SET jogo_status = 'liberado',
             jogo_liberado_at = CURRENT_TIMESTAMP,
             jogo_liberado_by = ?,
             jogo_bloqueio_motivo = NULL
         WHERE id = ?`,
        [actorId, playerId]
    );
}

async function blockPlayerGame(db, { playerId, reason }) {
    assertLifecycleAllowed({ surface: 'internal', operation: 'story.blockGame', mutationClass: 'CURRENT_WORLD' });
    return db.run(
        `UPDATE jogadores
         SET jogo_status = 'bloqueado',
             jogo_bloqueio_motivo = ?,
             jogo_liberado_at = NULL,
             jogo_liberado_by = NULL
         WHERE id = ?`,
        [reason || null, playerId]
    );
}

module.exports = {
    approvePlayerStory,
    blockPlayerGame,
    denyPlayerStory,
    releasePlayerGame,
};
