'use strict';

const {
    assertPreResetAdminCapability,
    assertPreResetAdminMutationAllowed,
} = require('./preResetAccessService');
const {
    PreResetCampaignError,
    DEFAULT_PRE_RESET_CAMPAIGN_KEY,
    getPreResetCampaignState,
    hash,
    normalizeCampaignKey,
    parseInstant,
    requiredOperationKey,
} = require('./preResetCampaignStateService');
const {
    assertTransitionLaunchEnabled,
    decideTransition,
} = require('./preResetTransitionService');
const { isPreResetPlayerPurged } = require('./preResetPurgeStateService');

function closeMutationGuard(context = {}) {
    try {
        assertPreResetAdminMutationAllowed(context);
        assertPreResetAdminCapability(context, 'prereset.review');
        assertPreResetAdminCapability(context, 'operation.apply');
        assertTransitionLaunchEnabled(context.env || process.env);
    } catch (error) {
        throw new PreResetCampaignError(error.code || 'capability_denied', error.message);
    }
}

async function listUndecidedApprovedPlayers(db) {
    const rows = await db.all(
        `SELECT p.id
         FROM jogadores p
         LEFT JOIN clover_prereset_transition_decisions d ON d.player_id = p.id
         WHERE p.ficha_status = 'aprovada'
           AND (d.player_id IS NULL OR d.status = 'pending')
         ORDER BY p.id ASC`
    );
    const result = [];
    for (const row of rows) {
        if (!await isPreResetPlayerPurged(db, row.id)) result.push(row);
    }
    return result;
}

async function claimClosing(db, campaignKey, actorId, operationKey, now) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const row = await db.get(
            'SELECT * FROM clover_prereset_campaigns WHERE campaign_key = ?',
            [campaignKey]
        );
        if (!row) throw new PreResetCampaignError('campaign_not_configured', 'A campanha pre-reset nao foi configurada.');
        if (row.status === 'closed') {
            if (row.closure_operation_key !== operationKey) {
                throw new PreResetCampaignError('closure_operation_conflict', 'A campanha ja foi fechada por outra operacao.');
            }
            await db.exec('COMMIT');
            return Object.freeze({ duplicate: true, closed: true });
        }
        if (row.status === 'closing') {
            if (row.closure_operation_key !== operationKey) {
                throw new PreResetCampaignError('closure_operation_conflict', 'O fechamento ja esta em andamento com outra chave.');
            }
            await db.exec('COMMIT');
            return Object.freeze({ duplicate: true, closed: false });
        }
        const deadline = parseInstant(row.deadline_at, 'invalid_campaign_deadline');
        if (now.getTime() < deadline.getTime()) {
            throw new PreResetCampaignError('deadline_not_reached', 'O deadline do pre-reset ainda nao foi atingido.', {
                deadlineAt: deadline.toISOString(),
            });
        }
        const requestHash = hash({ campaignKey, closureOperationKey: operationKey, deadlineAt: deadline.toISOString() });
        await db.run(
            `UPDATE clover_prereset_campaigns
             SET status = 'closing', closure_operation_key = ?, closing_started_at = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE campaign_key = ? AND status = 'open'`,
            [operationKey, now.toISOString(), campaignKey]
        );
        await db.run(
            `INSERT INTO clover_prereset_campaign_events
             (operation_key, campaign_key, event_type, actor_id, request_hash, payload_json)
             VALUES (?, ?, 'begin_close', ?, ?, ?)`,
            [
                `${operationKey}:begin`,
                campaignKey,
                actorId,
                requestHash,
                JSON.stringify({ deadlineAt: deadline.toISOString(), startedAt: now.toISOString() }),
            ]
        );
        await db.exec('COMMIT');
        return Object.freeze({ duplicate: false, closed: false });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function markClosed(db, campaignKey, actorId, operationKey, now, processedTotal) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const row = await db.get(
            'SELECT * FROM clover_prereset_campaigns WHERE campaign_key = ?',
            [campaignKey]
        );
        if (!row || row.status !== 'closing' || row.closure_operation_key !== operationKey) {
            throw new PreResetCampaignError('campaign_close_state_conflict', 'Estado do fechamento mudou durante a conclusao.');
        }
        const remaining = await listUndecidedApprovedPlayers(db);
        if (remaining.length) {
            throw new PreResetCampaignError('campaign_close_incomplete', 'Ainda existem decisoes pendentes.', {
                remaining: remaining.map((entry) => entry.id),
            });
        }
        await db.run(
            `UPDATE clover_prereset_campaigns
             SET status = 'closed', closed_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE campaign_key = ? AND status = 'closing' AND closure_operation_key = ?`,
            [now.toISOString(), campaignKey, operationKey]
        );
        await db.run(
            `INSERT INTO clover_prereset_campaign_events
             (operation_key, campaign_key, event_type, actor_id, request_hash, payload_json)
             VALUES (?, ?, 'close', ?, ?, ?)`,
            [
                `${operationKey}:closed`,
                campaignKey,
                actorId,
                hash({ campaignKey, operationKey, processedTotal }),
                JSON.stringify({ processedTotal, closedAt: now.toISOString() }),
            ]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function closePreResetCampaign(db, context = {}, request = {}, options = {}) {
    closeMutationGuard(context);
    const actorId = String(context.actorId || '').trim();
    if (!actorId) throw new PreResetCampaignError('missing_actor', 'Autor do fechamento obrigatorio.');
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const operationKey = requiredOperationKey(request.operationKey);
    const now = parseInstant(request.now || Date.now());

    const claim = await claimClosing(db, campaignKey, actorId, operationKey, now);
    if (claim.closed) {
        return Object.freeze({
            ok: true,
            duplicate: true,
            resumed: true,
            processedTotal: 0,
            ...(await getPreResetCampaignState(db, { campaignKey, now })),
        });
    }

    const players = await listUndecidedApprovedPlayers(db);
    const processed = [];
    try {
        for (const player of players) {
            if (typeof options.beforePlayer === 'function') {
                await options.beforePlayer(player, processed.length);
            }
            const autoOperationKey = `prereset:auto_reset:${hash(`${campaignKey}:${player.id}`).slice(0, 24)}`;
            const result = await decideTransition(db, player.id, actorId, {
                decision: 'auto_reset',
                operationKey: autoOperationKey,
                source: 'deadline',
                allowAutoReset: true,
                now,
            });
            processed.push(result);
        }
    } catch (error) {
        throw new PreResetCampaignError('campaign_close_interrupted', 'Fechamento interrompido; a campanha permanece em closing e pode ser retomada.', {
            processedTotal: processed.length,
            causeCode: error?.code || null,
            causeMessage: error?.message || String(error),
        });
    }

    await markClosed(db, campaignKey, actorId, operationKey, now, processed.length);
    return Object.freeze({
        ok: true,
        duplicate: Boolean(claim.duplicate),
        resumed: Boolean(claim.duplicate),
        processedTotal: processed.length,
        ...(await getPreResetCampaignState(db, { campaignKey, now })),
    });
}

module.exports = {
    closePreResetCampaign,
    listUndecidedApprovedPlayers,
};
