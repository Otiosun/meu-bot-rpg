const base = require('./antiGhostService');
const {
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
} = require('./groupManager');
const { syncSquadGroupDescription } = require('./squadService');

function lifecycleResult(archive) {
    return archive?.lifecycle?.lifecycle || archive?.lifecycle || archive || null;
}

function lifecycleCode(archive) {
    const lifecycle = lifecycleResult(archive);
    return lifecycle?.code || archive?.lifecycleCode || null;
}

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
    const lifecycle = lifecycleResult(archive);
    const archived = Boolean(result?.ok || archive?.ok || lifecycle?.ok || archive?.alreadyArchived);
    if (!archived) {
        return {
            ok: false,
            error: lifecycle?.error || archive?.error || result?.reason || 'Não consegui arquivar o player.',
            code: lifecycle?.code || archive?.code || 'archive_failed',
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

    const before = lifecycle?.before || archive?.before || null;
    const hadCalledQueueEntry = (before?.queueEntries || [])
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

    const previousSquad = before?.player?.esquadrao;
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
        lifecycleCode: lifecycleCode(archive),
        preserved: true,
        legacyDestructiveResetDisabled: true,
    };
}

module.exports = {
    ...base,
    lifecycleCode,
    lifecycleResult,
    removePlayerForAntiGhost,
};
