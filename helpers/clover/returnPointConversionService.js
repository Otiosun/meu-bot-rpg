'use strict';

const crypto = require('crypto');
const { getPhLedgerAuthoritySnapshot } = require('./phService');

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
    const policy = disabledConversionPolicy(options);
    const snapshot = await getPhLedgerAuthoritySnapshot(db, playerId);
    return Object.freeze({
        ok: true,
        enabled: false,
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
        calculatedReturnPoints: 0,
        reason: policy.reason,
    });
}

async function claimReturnPointConversion(db, playerId, options = {}) {
    const preview = await previewReturnPointConversion(db, playerId, options);
    // No policy currently has the authority to mint or consume anything. This
    // explicit no-op is intentionally idempotent because it writes no claim and
    // no Return Points ledger entry while the policy is disabled.
    return Object.freeze({ ...preview, claimed: false, duplicate: false, mutation: 'none' });
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
