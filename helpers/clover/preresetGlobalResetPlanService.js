'use strict';

class PreresetGlobalResetPlanError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreresetGlobalResetPlanError';
        this.code = code;
        this.details = details;
    }
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function requireTable(db, tableName) {
    if (!await tableExists(db, tableName)) {
        throw new PreresetGlobalResetPlanError(
            'missing_prereset_table',
            `Tabela obrigatoria ausente: ${tableName}.`,
            { tableName }
        );
    }
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    return new Set(rows.map((row) => row.name));
}

async function getGate(db, campaignKey) {
    return db.get(
        `SELECT *
         FROM clover_return_point_shop_gate
         WHERE campaign_key = ?`,
        [campaignKey]
    );
}

function normalizeOutcome(value) {
    return String(value || '').trim().toLowerCase();
}

async function buildPreresetGlobalResetPlan(db, options = {}) {
    const campaignKey = String(options.campaignKey || 'mythic_launch_v1').trim();
    if (!campaignKey) {
        throw new PreresetGlobalResetPlanError(
            'missing_campaign_key',
            'Informe a campaignKey do pre-reset.'
        );
    }

    await requireTable(db, 'clover_return_point_shop_gate');
    await requireTable(db, 'clover_return_point_shop_eligible');

    const gate = await getGate(db, campaignKey);
    if (!gate) {
        throw new PreresetGlobalResetPlanError(
            'return_shop_gate_missing',
            'Gate da Return Shop nao encontrado.',
            { campaignKey }
        );
    }
    if (normalizeOutcome(gate.status) !== 'open') {
        throw new PreresetGlobalResetPlanError(
            'return_shop_gate_not_open',
            'Reset global exige Return Shop gate aberto/finalizado.',
            { campaignKey, status: gate.status }
        );
    }
    if (!gate.roster_revision || !gate.roster_hash) {
        throw new PreresetGlobalResetPlanError(
            'roster_not_finalized',
            'Roster finalizado precisa de revision e hash.'
        );
    }

    const eligibleColumns = await tableColumns(db, 'clover_return_point_shop_eligible');
    const orderClause = eligibleColumns.has('captured_at')
        ? 'ORDER BY outcome, captured_at, player_id'
        : 'ORDER BY outcome, player_id';
    const rows = await db.all(
        `SELECT *
         FROM clover_return_point_shop_eligible
         WHERE campaign_key = ?
           AND roster_revision = ?
           AND roster_hash = ?
         ${orderClause}`,
        [campaignKey, gate.roster_revision, gate.roster_hash]
    );

    const keepPlayerIds = rows
        .filter((row) => normalizeOutcome(row.outcome) === 'keep')
        .map((row) => row.player_id)
        .sort();
    const resetPlayerIds = rows
        .filter((row) => normalizeOutcome(row.outcome) === 'reset')
        .map((row) => row.player_id)
        .sort();
    const unknown = rows.filter((row) => !['keep', 'reset'].includes(normalizeOutcome(row.outcome)));
    if (unknown.length) {
        throw new PreresetGlobalResetPlanError(
            'invalid_roster_outcome',
            'Roster possui outcome invalido.',
            { outcomes: unknown.map((row) => row.outcome) }
        );
    }
    if (Number(gate.required_keep_count || 0) !== keepPlayerIds.length) {
        throw new PreresetGlobalResetPlanError(
            'keep_count_mismatch',
            'Quantidade KEEP diverge do gate.',
            {
                expected: Number(gate.required_keep_count || 0),
                actual: keepPlayerIds.length,
            }
        );
    }

    return {
        ok: true,
        campaignKey,
        rosterRevision: Number(gate.roster_revision),
        rosterHash: gate.roster_hash,
        gate: {
            status: gate.status,
            openedAt: gate.opened_at || null,
            openedBy: gate.opened_by || null,
        },
        counts: {
            keep: keepPlayerIds.length,
            reset: resetPlayerIds.length,
            total: keepPlayerIds.length + resetPlayerIds.length,
        },
        keepPlayerIds,
        resetPlayerIds,
        preservation: {
            returnPointsLedger: true,
            returnShopEntitlements: true,
            returnShopGateAndEligibility: true,
        },
    };
}

module.exports = {
    PreresetGlobalResetPlanError,
    buildPreresetGlobalResetPlan,
};
