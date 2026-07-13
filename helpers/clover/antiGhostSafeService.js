const base = require('./antiGhostService');
const {
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
} = require('./groupManager');
const { syncSquadGroupDescription } = require('./squadService');

async function removePlayerForAntiGhost({
    sock,
    db,
    player,
    moderatorId,
    reason = 'anti-ghost',
} = {}) {
    const result = await base.removePlayerForAntiGhost({
        sock,
        db,
        player,
        moderatorId,
        reason,
    });

    const archive = result?.archive || null;
    if (!archive?.ok) {
        return {
            ok: false,
            error: archive?.error || 'Não consegui arquivar o player.',
            code: archive?.code || 'archive_failed',
            archive,
            community: result?.community || null,
            warnings: [],
            preserved: true,
        };
    }

    const warnings = [];
    await base.markCommunityStatus(db, player.id, false).catch((error) => {
        warnings.push(`status da comunidade não sincronizado: ${error?.message || error}`);
    });

    const hadCalledQueueEntry = (archive.before?.queueEntries || [])
        .some((entry) => entry.status === 'called');
    if (hadCalledQueueEntry && sock) {
        const removal = await removeSpellReviewParticipant(sock, db, player.id)
            .catch((error) => ({ ok: false, error }));
        if (!removal?.ok) {
            warnings.push('não consegui confirmar a remoção do grupo de avaliação');
        }
        await rotateSpellReviewInviteLink(sock, db).catch(() => {
            warnings.push('não consegui redefinir o link do grupo de avaliação');
        });
    }

    const previousSquad = archive.before?.player?.esquadrao;
    if (previousSquad && previousSquad !== '-' && sock) {
        await syncSquadGroupDescription({
            sock,
            db,
            squadKey: previousSquad,
        }).catch(() => {
            warnings.push('não consegui sincronizar a descrição do esquadrão anterior');
        });
    }

    return {
        ok: true,
        archive,
        community: result?.community || null,
        warnings,
        lifecycleCode: archive.lifecycleCode || null,
        preserved: true,
        legacyDestructiveResetDisabled: true,
    };
}

module.exports = {
    ...base,
    removePlayerForAntiGhost,
};
