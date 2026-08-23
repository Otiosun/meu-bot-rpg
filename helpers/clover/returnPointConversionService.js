'use strict';

const crypto = require('crypto');
const { getPhLedgerAuthoritySnapshot } = require('./phService');
const { appendReturnPointsInTransaction } = require('./returnPointsService');

const PH_CONVERSION_POLICY_STATUS = 'PRODUCT_DECISION_REQUIRED';

class ReturnPointConversionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ReturnPointConversionError';
        this.code = code;
        this.details = details;
    }
}

function cleanKey(value, label) {
    const key = String(value || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(key)) {
        throw new ReturnPointConversionError('invalid_policy_input', `${label} invalido.`);
    }
    return key;
}

function disabledConversionPolicy(options = {}) {
    return Object.freeze({
        enabled: false,
        status: PH_CONVERSION_POLICY_STATUS,
        policyVersion: options.policyVersion ? cleanKey(options.policyVersion, 'policyVersion') : 'unapproved',
        resetCycleKey: options.resetCycleKey ? cleanKey(options.resetCycleKey, 'resetCycleKey') : 'unassigned',
        reason: 'A formula, o cutoff e o ciclo de reset ainda nao foram aprovados.',
    });
}

function deterministicClaimKey(playerId, policy, snapshot) {
    const source = [playerId, policy.policyVersion, policy.resetCycleKey, snapshot.ledgerDigest].join('|');
    return `return-conversion:${crypto.createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

async function previewReturnPointConversion(db, playerId, options = {}) {
    const policy = options.policy?.enabled === true ? options.policy : disabledConversionPolicy(options);
    const snapshot = await getPhLedgerAuthoritySnapshot(db, playerId);
    const calculatedReturnPoints = policy.enabled
        ? (policy.rounding === 'ceil'
            ? Math.ceil((snapshot.available * policy.rate.numerator) / policy.rate.denominator)
            : Math.floor((snapshot.available * policy.rate.numerator) / policy.rate.denominator))
        : 0;
    return Object.freeze({
        ok: true,
        enabled: policy.enabled === true,
        status: policy.status,
        policyVersion: policy.policyVersion,
        resetCycleKey: policy.resetCycleKey,
        claimKey: deterministicClaimKey(playerId, policy, snapshot),
        sourcePh: Object.freeze({
            available: snapshot.available,
            accumulated: snapshot.accumulated,
            ledgerDigest: snapshot.ledgerDigest,
            entryCount: snapshot.entryCount,
        }),
        calculatedReturnPoints,
        reason: policy.reason,
    });
}

async function claimReturnPointConversion(db, playerId, options = {}) {
    const policy = options.policy?.enabled === true ? options.policy : null;
    if (!policy) {
        const preview = await previewReturnPointConversion(db, playerId, options);
        // No product policy currently has the authority to mint or consume.
        return Object.freeze({ ...preview, claimed: false, duplicate: false, mutation: 'none' });
    }
    if (policy.testOnly !== true || policy.phConsumption !== 'none') {
        throw new ReturnPointConversionError('policy_disabled', 'A conversao nao possui politica autorizada.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const preview = await previewReturnPointConversion(db, playerId, { policy });
        const existing = await db.get(
            `SELECT * FROM clover_return_point_conversion_claims
             WHERE player_id = ? AND policy_version = ? AND reset_cycle_key = ?`,
            [String(playerId), policy.policyVersion, policy.resetCycleKey]
        );
        if (existing) {
            if (existing.claim_key !== preview.claimKey || existing.source_ph_ledger_digest !== preview.sourcePh.ledgerDigest) {
                throw new ReturnPointConversionError('conversion_source_changed', 'A fonte PH mudou apos o primeiro claim.');
            }
            await db.exec('COMMIT');
            return Object.freeze({ ...preview, claimed: existing.status === 'claimed', duplicate: true, mutation: 'none', claim: existing });
        }
        const ledger = preview.calculatedReturnPoints > 0
            ? await appendReturnPointsInTransaction(db, playerId, {
                amount: preview.calculatedReturnPoints,
                entryKind: 'credit',
                operationKey: preview.claimKey,
                source: 'ph_return_conversion_test_only',
                reason: 'Conversao PH sintetica TEST-ONLY.',
                policyVersion: policy.policyVersion,
                resetCycleKey: policy.resetCycleKey,
                relatedId: preview.sourcePh.ledgerDigest,
                correlationId: preview.claimKey,
                createdBy: String(options.actorId || playerId),
                metadata: { test_only: true, cutoff: policy.cutoff, ph_consumption: 'none' },
            })
            : null;
        const inserted = await db.run(
            `INSERT INTO clover_return_point_conversion_claims
             (player_id, policy_version, reset_cycle_key, claim_key, source_ph_ledger_digest,
              source_ph_available, calculated_return_points, status, return_points_ledger_id, claimed_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, CURRENT_TIMESTAMP, ?)`,
            [String(playerId), policy.policyVersion, policy.resetCycleKey, preview.claimKey,
                preview.sourcePh.ledgerDigest, preview.sourcePh.available, preview.calculatedReturnPoints,
                ledger?.ledgerId || null, JSON.stringify({ test_only: true, ph_consumption: 'none' })]
        );
        const claim = await db.get('SELECT * FROM clover_return_point_conversion_claims WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return Object.freeze({ ...preview, claimed: true, duplicate: false, mutation: 'credit_return_points', claim, ledger });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function reconcileReturnPointConversions(db, playerId) {
    const rows = await db.all(
        `SELECT * FROM clover_return_point_conversion_claims WHERE player_id = ? ORDER BY id ASC`,
        [String(playerId)]
    );
    const snapshot = await getPhLedgerAuthoritySnapshot(db, playerId);
    const mismatches = rows.filter((row) => row.source_ph_ledger_digest !== snapshot.ledgerDigest);
    return Object.freeze({
        ok: mismatches.length === 0,
        claimCount: rows.length,
        mismatchCount: mismatches.length,
        currentLedgerDigest: snapshot.ledgerDigest,
    });
}

module.exports = {
    PH_CONVERSION_POLICY_STATUS,
    ReturnPointConversionError,
    claimReturnPointConversion,
    deterministicClaimKey,
    disabledConversionPolicy,
    previewReturnPointConversion,
    reconcileReturnPointConversions,
};
