'use strict';

const MANA_ACTIVATION_COSTS = Object.freeze([50, 100, 150, 320, 400, 720, 840, 1440, 1620, 2500, 2750, 3000, 3500]);
const RETENTION_DURATIONS = Object.freeze([
    'instantâneo ou até 1 ciclo',
    'até 2 ciclos',
    'até 3 ciclos',
    'até 5 ciclos',
    'até 8 ciclos',
    'até 12 ciclos ou cena curta',
    'cena prolongada enquanto houver Mana, fonte e coerência',
]);
const MAINTENANCE_RATES = Object.freeze({
    instant: 0,
    burst: 0,
    sustained_user: 0.2,
    field_structure: 0.3,
    multiple_operations: 0.3,
    caster_fed_autonomous: 0.4,
    detached: null,
});
const REUSE_RULES = Object.freeze({
    instant: Object.freeze({ kind: 'normal', cooldownCycles: 0, allowsDuplicateWhileActive: true }),
    sustained: Object.freeze({ kind: 'active_instance', cooldownCycles: 0, allowsDuplicateWhileActive: false }),
    reaction: Object.freeze({ kind: 'action_economy', cooldownCycles: 0, maxPerWindow: 1 }),
    overcharge: Object.freeze({ kind: 'declared_recovery', cooldownCycles: 1, requiresRegisteredJustification: true }),
    field: Object.freeze({ kind: 'active_instance', cooldownCycles: 0, allowsDuplicateWhileActive: false }),
    summon: Object.freeze({ kind: 'active_instance', cooldownCycles: 0, allowsDuplicateWhileActive: false }),
    special: Object.freeze({ kind: 'own_rule', cooldownCycles: null, special: true }),
});

// Integration point: call these rules only with a structured total Weight.
// The current spellbook stores free-form cost text, which must not be parsed heuristically.

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${label} precisa ser inteiro positivo.`);
    return parsed;
}

function getMinStageForWeight(weight) {
    const value = positiveInteger(weight, 'Peso');
    if (value <= 3) return 9;
    if (value === 4) return 8;
    if (value === 5) return 7;
    if (value === 6) return 6;
    if (value === 7) return 5;
    if (value <= 9) return 4;
    if (value === 10) return 3;
    if (value <= 12) return 2;
    return 1;
}

function canStageSupportWeight(stage, weight) {
    const stageText = String(stage ?? '').trim().toLowerCase();
    const parsedStage = stageText.includes('arcano')
        ? 0
        : Number(stageText.match(/\d+/)?.[0] ?? stage);
    const minimumStage = getMinStageForWeight(weight);
    if (parsedStage === 0) return { ok: false, special: true, minimumStage };
    if (!Number.isInteger(parsedStage) || parsedStage < 1 || parsedStage > 9) {
        throw new TypeError('Estagio precisa estar entre 0 e 9.');
    }
    return { ok: parsedStage <= minimumStage, special: false, minimumStage };
}

function getManaActivationCost(weight) {
    const value = positiveInteger(weight, 'Peso');
    return MANA_ACTIVATION_COSTS[value - 1] ?? null;
}

function getRetentionDuration(level) {
    const value = positiveInteger(level, 'Retencao');
    if (value > 7) throw new RangeError('Retencao precisa estar entre 1 e 7.');
    return RETENTION_DURATIONS[value - 1];
}

function getMaintenanceRate(profile) {
    if (!Object.prototype.hasOwnProperty.call(MAINTENANCE_RATES, profile)) {
        throw new TypeError('Perfil de manutencao invalido.');
    }
    return MAINTENANCE_RATES[profile];
}

function getMaintenanceCost(activationCost, profile) {
    const cost = Number(activationCost);
    if (!Number.isFinite(cost) || cost < 0) throw new TypeError('Custo de ativacao invalido.');
    const rate = getMaintenanceRate(profile);
    return rate === null ? null : cost * rate;
}

function getReuseRule(profile) {
    const rule = REUSE_RULES[profile];
    if (!rule) throw new TypeError('Perfil de reuso invalido.');
    return { ...rule };
}

module.exports = {
    MAINTENANCE_RATES,
    MANA_ACTIVATION_COSTS,
    RETENTION_DURATIONS,
    REUSE_RULES,
    canStageSupportWeight,
    getMaintenanceCost,
    getMaintenanceRate,
    getManaActivationCost,
    getMinStageForWeight,
    getRetentionDuration,
    getReuseRule,
};
