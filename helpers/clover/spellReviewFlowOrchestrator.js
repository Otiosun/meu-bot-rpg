const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./lifecyclePolicy');
'use strict';

const {
    getSpellReviewAutoFlowEnabled,
    fillSpellReviewSlots,
    concludeSpellReviewEntry,
} = require('./spellReviewFlowService');
const {
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
    sendSpellReviewInviteToPlayer,
} = require('./groupManager');

async function inviteCalledEntries(sock, db, entries, options = {}) {
    const invites = [];
    if (!entries?.length) return invites;

    let link = null;
    if (options.rotate !== false) {
        link = await rotateSpellReviewInviteLink(sock, db).catch((error) => {
            console.log('[spell-flow] não consegui atualizar o link antes do lote:', error?.message || error);
            return null;
        });
    }

    for (const entry of entries) {
        const invite = await sendSpellReviewInviteToPlayer(sock, db, entry.player_id, {
            rotate: false,
            queueFallback: false,
            link,
        }).catch((error) => ({
            ok: false,
            reason: 'unexpected_error',
            error: error?.message || String(error),
        }));
        invites.push({ entry, invite });
    }
    return invites;
}

async function fillAndInviteSpellReviewCapacity({
    sock,
    db,
    actorId = 'system',
    force = false,
    rotate = true,
    excludePlayerIds = [],
} = {}) {
    const denied = lifecycleSkip({surface:'scheduler',operation:'spell_review.fill',mutationClass:'CURRENT_WORLD'}); if (denied) return {...denied,called:[]};

    if (!sock || !db) return { ok: false, code: 'runtime_unavailable', called: [], invites: [] };

    const autoFlow = await getSpellReviewAutoFlowEnabled(db);
    if (!force && !autoFlow) {
        return { ok: false, code: 'auto_disabled', autoFlow, called: [], invites: [] };
    }

    const fill = await fillSpellReviewSlots(db, actorId, { excludePlayerIds });
    const invites = await inviteCalledEntries(sock, db, fill.called, { rotate });

    return {
        ok: true,
        autoFlow,
        ...fill,
        invites,
    };
}

async function removeSpellReviewParticipantSafely(sock, db, playerId) {
    if (!sock || !db || !playerId) return { ok: false, reason: 'missing_runtime' };
    return removeSpellReviewParticipant(sock, db, playerId).catch((error) => ({
        ok: false,
        reason: 'remove_failed',
        error: error?.message || String(error),
    }));
}

async function completeSpellReviewPostCommit({
    sock,
    db,
    playerId,
    actorId,
} = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'completeSpellReviewPostCommit',mutationClass:'CURRENT_WORLD'});
    const removal = await removeSpellReviewParticipantSafely(sock, db, playerId);
    const fill = await fillAndInviteSpellReviewCapacity({
        sock,
        db,
        actorId,
        force: false,
        rotate: true,
        excludePlayerIds: [playerId],
    });

    return {
        handled: true,
        concludedAlready: true,
        removal,
        fill,
    };
}

async function completeSpellReviewAfterSave({
    sock,
    db,
    playerId,
    actorId,
    reason = 'feitiço salvo pelo ADM',
} = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'completeSpellReviewAfterSave',mutationClass:'CURRENT_WORLD'});
    const concluded = await concludeSpellReviewEntry(db, playerId, actorId, reason);
    if (!concluded.ok) {
        return {
            handled: false,
            concluded,
            removal: null,
            fill: null,
        };
    }

    const postCommit = await completeSpellReviewPostCommit({
        sock,
        db,
        playerId,
        actorId,
    });

    return {
        ...postCommit,
        concluded,
    };
}

function startSpellReviewFlowScheduler(options = {}) {
    const denied = lifecycleSkip({surface:'module_load',operation:'spell_review.scheduler',mutationClass:'CURRENT_WORLD',env:options.env}); if (denied) return {...denied,timer:null};

    if (global.__cloverSpellReviewFlowScheduler) {
        return global.__cloverSpellReviewFlowScheduler;
    }

    const intervalMs = Math.max(15000, Number(options.intervalMs || 45000));
    const state = {
        running: false,
        timer: null,
        intervalMs,
    };

    state.timer = setInterval(async () => {
        if (state.running) return;
        const runtime = global.runtimeClover;
        const sock = runtime?.sockAtivo;
        const db = runtime?.dbAtivo;
        if (!sock || !db || runtime?.encerrando) return;

        state.running = true;
        try {
            const result = await fillAndInviteSpellReviewCapacity({
                sock,
                db,
                actorId: 'system:spell-flow-scheduler',
                force: false,
                rotate: false,
            });
            if (result?.called?.length) {
                console.log(`[spell-flow] vagas preenchidas automaticamente=${result.called.length}; capacidade=${result.capacity}; ativos=${result.state?.active}`);
            }
        } catch (error) {
            console.log('[spell-flow] falha no preenchimento automático:', error?.message || error);
        } finally {
            state.running = false;
        }
    }, intervalMs);

    state.timer.unref?.();
    global.__cloverSpellReviewFlowScheduler = state;
    return state;
}

module.exports = {
    completeSpellReviewAfterSave,
    completeSpellReviewPostCommit,
    fillAndInviteSpellReviewCapacity,
    inviteCalledEntries,
    removeSpellReviewParticipantSafely,
    startSpellReviewFlowScheduler,
};
