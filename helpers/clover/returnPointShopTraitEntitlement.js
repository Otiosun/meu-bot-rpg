'use strict';

function parseJson(raw, fallback = {}) {
    try {
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

const EFFECT_KINDS = Object.freeze({
    rare_aptitude: 'rare_aptitude_entitlement',
    rare_mark: 'rare_mark_entitlement',
    anomaly: 'anomaly_entitlement',
});

async function getReturnPointTraitEntitlements(db, playerId, rollNumber) {
    const id = String(playerId || '').trim();
    const target = Number(rollNumber || 0);
    if (!id || !Number.isInteger(target) || target <= 0) {
        return {
            rare_aptitude: false,
            rare_mark: false,
            anomaly: false,
        };
    }

    const rows = await db.all(
        `SELECT e.metadata_json
         FROM clover_prereset_entitlements e
         JOIN clover_prereset_purchases p ON p.id = e.purchase_id
         WHERE e.player_id = ?
           AND e.status = 'active'
           AND p.status = 'completed'`,
        [id]
    );

    const activeEffects = new Set();
    for (const row of rows) {
        const metadata = parseJson(row.metadata_json, {});
        if (Number(metadata.targetRollNumber || 0) !== target) continue;
        if (metadata.effectKind) activeEffects.add(String(metadata.effectKind));
    }

    return {
        rare_aptitude: activeEffects.has(EFFECT_KINDS.rare_aptitude),
        rare_mark: activeEffects.has(EFFECT_KINDS.rare_mark),
        anomaly: activeEffects.has(EFFECT_KINDS.anomaly),
    };
}

module.exports = {
    EFFECT_KINDS,
    getReturnPointTraitEntitlements,
};
