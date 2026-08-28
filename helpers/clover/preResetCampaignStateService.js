'use strict';

const crypto = require('crypto');
const {
    assertPreResetAdminCapability,
    assertPreResetAdminMutationAllowed,
} = require('./preResetAccessService');

const DEFAULT_PRE_RESET_CAMPAIGN_KEY = 'mythic_launch_v1';

class PreResetCampaignError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetCampaignError';
        this.code = code;
        this.details = details;
    }
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function requiredOperationKey(value) {
    const key = String(value || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{8,180}$/.test(key)) {
        throw new PreResetCampaignError('invalid_operation_key', 'Chave de operacao invalida.');
    }
    return key;
}

function normalizeCampaignKey(value) {
    const key = String(value || DEFAULT_PRE_RESET_CAMPAIGN_KEY).trim();
    if (!/^[a-zA-Z0-9_.:-]{3,120}$/.test(key)) {
        throw new PreResetCampaignError('invalid_campaign_key', 'Chave de campanha invalida.');
    }
    return key;
}

function parseInstant(value, code = 'invalid_instant') {
    const instant = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(instant.getTime())) {
        throw new PreResetCampaignError(code, 'Data/hora invalida.');
    }
    return instant;
}

async function hasTable(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?",
        [String(tableName)]
    );
    return Boolean(row?.ok);
}

function parseCampaignRow(row, now = new Date()) {
    if (!row) return null;
    const deadline = parseInstant(row.deadline_at, 'invalid_campaign_deadline');
    return Object.freeze({
        campaignKey: row.campaign_key,
        status: row.status,
        deadlineAt: deadline.toISOString(),
        deadlineReached: now.getTime() >= deadline.getTime(),
        closureOperationKey: row.closure_operation_key || null,
        configuredBy: row.configured_by || null,
        closingStartedAt: row.closing_started_at || null,
        closedAt: row.closed_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    });
}

async function getPreResetCampaignState(db, options = {}) {
    const now = parseInstant(options.now || Date.now());
    if (!await hasTable(db, 'clover_prereset_campaigns')) {
        return Object.freeze({ managed: false, configured: false, campaign: null });
    }
    const campaignKey = normalizeCampaignKey(options.campaignKey);
    const row = await db.get(
        'SELECT * FROM clover_prereset_campaigns WHERE campaign_key = ?',
        [campaignKey]
    );
    return Object.freeze({
        managed: true,
        configured: Boolean(row),
        campaign: parseCampaignRow(row, now),
    });
}

async function assertPreResetDecisionWindowOpen(db, options = {}) {
    const state = await getPreResetCampaignState(db, options);
    if (!state.managed) return Object.freeze({ managed: false, legacyUnmanaged: true });
    if (!state.configured) {
        throw new PreResetCampaignError(
            'campaign_not_configured',
            'A janela global do pre-reset ainda nao foi configurada.'
        );
    }
    if (state.campaign.status !== 'open' || state.campaign.deadlineReached) {
        throw new PreResetCampaignError(
            'decision_window_closed',
            'A janela de decisao do pre-reset esta fechada.',
            { status: state.campaign.status, deadlineAt: state.campaign.deadlineAt }
        );
    }
    return state.campaign;
}

function adminMutationGuard(context = {}) {
    try {
        assertPreResetAdminMutationAllowed(context);
        assertPreResetAdminCapability(context, 'prereset.review');
    } catch (error) {
        throw new PreResetCampaignError(error.code || 'capability_denied', error.message);
    }
}

async function configurePreResetCampaign(db, context = {}, request = {}) {
    adminMutationGuard(context);
    const actorId = String(context.actorId || '').trim();
    if (!actorId) throw new PreResetCampaignError('missing_actor', 'Autor da configuracao obrigatorio.');
    const campaignKey = normalizeCampaignKey(request.campaignKey);
    const operationKey = requiredOperationKey(request.operationKey);
    const now = parseInstant(request.now || Date.now());
    const deadline = parseInstant(request.deadlineAt, 'invalid_campaign_deadline');
    if (deadline.getTime() <= now.getTime()) {
        throw new PreResetCampaignError('deadline_must_be_future', 'O deadline precisa estar no futuro ao configurar a campanha.');
    }
    const requestHash = hash({ campaignKey, deadlineAt: deadline.toISOString() });

    await db.exec('BEGIN IMMEDIATE');
    try {
        const replay = await db.get(
            'SELECT * FROM clover_prereset_campaign_events WHERE operation_key = ?',
            [operationKey]
        );
        if (replay) {
            if (replay.event_type !== 'configure' || replay.campaign_key !== campaignKey || replay.request_hash !== requestHash) {
                throw new PreResetCampaignError('idempotency_conflict', 'Chave de configuracao reutilizada com outro pedido.');
            }
            await db.exec('COMMIT');
            return Object.freeze({ ok: true, duplicate: true, ...(await getPreResetCampaignState(db, { campaignKey, now })) });
        }

        const current = await db.get(
            'SELECT * FROM clover_prereset_campaigns WHERE campaign_key = ?',
            [campaignKey]
        );
        if (current && current.status !== 'open') {
            throw new PreResetCampaignError('campaign_not_editable', 'A campanha nao pode mais ter o deadline alterado.', {
                status: current.status,
            });
        }
        if (current) {
            await db.run(
                `UPDATE clover_prereset_campaigns
                 SET deadline_at = ?, configured_by = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE campaign_key = ?`,
                [deadline.toISOString(), actorId, campaignKey]
            );
        } else {
            await db.run(
                `INSERT INTO clover_prereset_campaigns
                 (campaign_key, status, deadline_at, configured_by)
                 VALUES (?, 'open', ?, ?)`,
                [campaignKey, deadline.toISOString(), actorId]
            );
        }
        await db.run(
            `INSERT INTO clover_prereset_campaign_events
             (operation_key, campaign_key, event_type, actor_id, request_hash, payload_json)
             VALUES (?, ?, 'configure', ?, ?, ?)`,
            [operationKey, campaignKey, actorId, requestHash, JSON.stringify({ deadlineAt: deadline.toISOString() })]
        );
        await db.exec('COMMIT');
        return Object.freeze({ ok: true, duplicate: false, ...(await getPreResetCampaignState(db, { campaignKey, now })) });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    DEFAULT_PRE_RESET_CAMPAIGN_KEY,
    PreResetCampaignError,
    assertPreResetDecisionWindowOpen,
    configurePreResetCampaign,
    getPreResetCampaignState,
    hasTable,
    hash,
    normalizeCampaignKey,
    parseInstant,
    requiredOperationKey,
    stable,
};
