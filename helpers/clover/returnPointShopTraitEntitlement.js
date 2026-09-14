'use strict';

const { resolveOption } = require('./traitManager');

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

    const manual = await require('./returnPointShopManualService').manualRows(db,id);
    rows.push(...manual.filter(row => row.status === 'active'));
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

function removeCategoryAttemptErrors(errors, category) {
    const prefixes = {
        rare_aptitude: [
            'Aptidao rara so pode',
            'Aptidao rara ja foi vinculada',
        ],
        rare_mark: [
            'Marca rara so pode',
            'Marca rara ja foi vinculada',
        ],
        anomaly: [
            'Anomalia so pode',
            'Anomalia ja foi vinculada',
        ],
    }[category] || [];

    return errors.filter((error) => !prefixes.some((prefix) => String(error).startsWith(prefix)));
}

async function applyReturnPointTraitEntitlements(db, playerId, rollNumber, fields, validation) {
    const rights = await getReturnPointTraitEntitlements(db, playerId, rollNumber);
    const payload = { ...(validation?.payload || {}) };
    let errors = [...(validation?.errors || [])];

    const rareAptitude = resolveOption('rareAptitudes', fields.aptidao_rara)
        || resolveOption('rareAptitudes', fields.aptidao_comum);
    if (rights.rare_aptitude && rareAptitude) {
        errors = removeCategoryAttemptErrors(errors, 'rare_aptitude');
        payload.rareAptitude = rareAptitude;
        if (resolveOption('rareAptitudes', fields.aptidao_comum)) payload.commonAptitude = null;
    }

    const rareMark = resolveOption('rareMarks', fields.marca_rara)
        || resolveOption('rareMarks', fields.marca_comum);
    if (rights.rare_mark && rareMark) {
        errors = removeCategoryAttemptErrors(errors, 'rare_mark');
        payload.rareMark = rareMark;
        if (resolveOption('rareMarks', fields.marca_comum)) payload.commonMark = null;
    }

    const anomaly = resolveOption('anomalies', fields.anomalia);
    if (rights.anomaly && anomaly) {
        errors = removeCategoryAttemptErrors(errors, 'anomaly');
        payload.anomaly = anomaly;
    }

    return {
        ...(validation || {}),
        ok: errors.length === 0,
        errors,
        payload,
        returnPointShopEntitlements: rights,
    };
}

module.exports = {
    EFFECT_KINDS,
    applyReturnPointTraitEntitlements,
    getReturnPointTraitEntitlements,
};
