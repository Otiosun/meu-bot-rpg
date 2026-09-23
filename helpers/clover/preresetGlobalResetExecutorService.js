'use strict';

const {
    buildPreresetGlobalResetPlan,
} = require('./preresetGlobalResetPlanService');
const {
    resetPlayer,
} = require('./playerResetService');

class PreresetGlobalResetExecutorError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreresetGlobalResetExecutorError';
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

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    return new Set(rows.map((row) => row.name));
}

async function countRows(db, tableName, whereSql = '', params = []) {
    if (!await tableExists(db, tableName)) return 0;
    const row = await db.get(
        `SELECT COUNT(*) AS total FROM ${quoteIdentifier(tableName)} ${whereSql}`,
        params
    );
    return Number(row?.total || 0);
}

async function sumAmount(db, tableName) {
    if (!await tableExists(db, tableName)) return 0;
    const columns = await tableColumns(db, tableName);
    if (!columns.has('amount')) return 0;
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM ${quoteIdentifier(tableName)}`
    );
    return Number(row?.total || 0);
}

async function capturePreservationSnapshot(db, campaignKey) {
    return {
        campaignKey,
        returnPointsLedger: {
            rows: await countRows(db, 'clover_return_points_ledger'),
            amount: await sumAmount(db, 'clover_return_points_ledger'),
        },
        preresetPurchases: {
            rows: await countRows(db, 'clover_prereset_purchases'),
        },
        preresetEntitlements: {
            rows: await countRows(db, 'clover_prereset_entitlements'),
            activeRows: await countRows(
                db,
                'clover_prereset_entitlements',
                "WHERE status = 'active'"
            ),
        },
        returnShopEligibility: {
            rows: await countRows(
                db,
                'clover_return_point_shop_eligible',
                'WHERE campaign_key = ?',
                [campaignKey]
            ),
        },
        returnShopGate: {
            rows: await countRows(
                db,
                'clover_return_point_shop_gate',
                'WHERE campaign_key = ?',
                [campaignKey]
            ),
        },
    };
}

function snapshotsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function requireApplyOptions(options) {
    if (!String(options.reason || '').trim()) {
        throw new PreresetGlobalResetExecutorError(
            'missing_reason',
            'Reset global precisa de motivo.'
        );
    }
    if (!String(options.actorId || '').trim()) {
        throw new PreresetGlobalResetExecutorError(
            'missing_actor',
            'Reset global precisa de actorId.'
        );
    }
}

function operationCode(prefix, index) {
    const cleanPrefix = String(prefix || 'RG')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        || 'RG';
    return `${cleanPrefix}-${String(index + 1).padStart(4, '0')}`;
}

async function executePreresetGlobalReset(db, options = {}) {
    const campaignKey = String(options.campaignKey || 'mythic_launch_v1').trim();
    const plan = await buildPreresetGlobalResetPlan(db, { campaignKey });
    const preservationBefore = await capturePreservationSnapshot(db, campaignKey);

    if (!options.apply) {
        return {
            ok: true,
            applied: false,
            plan,
            preservationBefore,
            preservationAfter: preservationBefore,
            resetResults: [],
            skippedKeepPlayerIds: plan.keepPlayerIds,
        };
    }

    requireApplyOptions(options);

    const resetResults = [];
    for (const [index, playerId] of plan.resetPlayerIds.entries()) {
        const result = await resetPlayer(db, {
            playerId,
            reason: options.reason,
            actorId: options.actorId,
            operationCode: operationCode(options.operationPrefix, index),
        });
        if (!result.ok && result.code === 'missing_character') {
            resetResults.push({
                playerId,
                operationCode: null,
                deletedRows: 0,
                skipped: true,
                reason: 'already_reset',
            });
            continue;
        }
        if (!result.ok) {
            throw new PreresetGlobalResetExecutorError(
                'player_reset_failed',
                'Falha ao resetar jogador do roster global.',
                { playerId, result }
            );
        }
        resetResults.push({
            playerId,
            operationCode: result.code,
            deletedRows: result.result?.deletedRows || 0,
        });
    }

    const preservationAfter = await capturePreservationSnapshot(db, campaignKey);
    if (!snapshotsEqual(preservationBefore, preservationAfter)) {
        throw new PreresetGlobalResetExecutorError(
            'preservation_changed',
            'Reset global alterou dados que deveriam ser preservados.',
            { before: preservationBefore, after: preservationAfter }
        );
    }

    return {
        ok: true,
        applied: true,
        plan,
        preservationBefore,
        preservationAfter,
        resetResults,
        skippedKeepPlayerIds: plan.keepPlayerIds,
    };
}

module.exports = {
    PreresetGlobalResetExecutorError,
    capturePreservationSnapshot,
    executePreresetGlobalReset,
};
