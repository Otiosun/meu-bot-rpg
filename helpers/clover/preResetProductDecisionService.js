'use strict';

const fs = require('fs');
const path = require('path');
const { createPreResetPolicyRegistry } = require('./preResetPolicyRegistryService');

const DECISION_SCHEMA_VERSION = 'prereset-product-decisions-v1';
const DECISION_IDS = Object.freeze(['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09']);
const DECISION_KEYS = Object.freeze({
    D01: 'PH_RETURN_CONVERSION_FORMULA_SOURCE',
    D02: 'PH_RETURN_CONVERSION_CUTOFF',
    D03: 'RESET_CYCLE_VERSION',
    D04: 'PH_RETURN_CONVERSION_ROUNDING',
    D05: 'PH_CONSUMPTION_BEHAVIOR',
    D06: 'RESET_SHOP_CATALOG_PRICES',
    D07: 'LIMITED_CAPACITY_PURCHASE_LIMITS',
    D08: 'REFUND_POLICY',
    D09: 'SESSION_ELIGIBILITY',
});
const DECISION_STATUSES = Object.freeze(['UNRESOLVED', 'APPROVED']);
const CANONICAL_MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'data', 'clover', 'preResetProductDecisions.json');

const SUPPORT_MATRIX = Object.freeze({
    D01: Object.freeze({ status: 'PARTIALLY_SUPPORTED', detail: 'Taxa racional existe; o runtime de conversao atualmente usa PH disponivel como fonte.' }),
    D02: Object.freeze({ status: 'PARTIALLY_SUPPORTED', detail: 'Cutoff possui campo de policy/proveniencia, mas o snapshot PH atual nao filtra historico pelo cutoff.' }),
    D03: Object.freeze({ status: 'SUPPORTED_NOW', detail: 'resetCycleKey ja participa da identidade, claim e ledger da conversao.' }),
    D04: Object.freeze({ status: 'SUPPORTED_NOW', detail: 'floor e ceil ja sao aplicados pela conversao.' }),
    D05: Object.freeze({ status: 'PARTIALLY_SUPPORTED', detail: 'A fundacao TEST-ONLY aceita phConsumption=none; consumo real de PH continua proibido.' }),
    D06: Object.freeze({ status: 'SUPPORTED_NOW', detail: 'Catalogo server-authoritative com itemKey, entitlementKey e preco inteiro positivo ja existe.' }),
    D07: Object.freeze({ status: 'REQUIRES_FUTURE_IMPLEMENTATION', detail: 'Existe unicidade de entitlement por jogador, mas capacidade global/limites de produto ainda nao possuem owner runtime completo.' }),
    D08: Object.freeze({ status: 'REQUIRES_FUTURE_IMPLEMENTATION', detail: 'Refund permanece deliberadamente bloqueado ate decisao de produto.' }),
    D09: Object.freeze({ status: 'PARTIALLY_SUPPORTED', detail: 'Sessao canonica + released=true ja sao verificadas; criterios adicionais dependem da decisao final.' }),
});

class PreResetProductDecisionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetProductDecisionError';
        this.code = code;
        this.details = details;
    }
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, label, max = 160) {
    const text = String(value || '').trim();
    if (!text || text.length > max) throw new PreResetProductDecisionError('invalid_decision_value', `${label} invalido.`);
    return text;
}

function validVersion(value, label) {
    const text = requiredText(value, label, 120);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(text)) {
        throw new PreResetProductDecisionError('invalid_decision_value', `${label} invalido.`);
    }
    return text;
}

function validateApprovedValue(id, value) {
    if (!plainObject(value)) throw new PreResetProductDecisionError('invalid_decision_value', `${id} aprovado sem valor estruturado.`);
    if (id === 'D01') {
        const source = requiredText(value.source, 'D01.source');
        if (!['available', 'accumulated'].includes(source)) throw new PreResetProductDecisionError('invalid_decision_value', 'D01.source invalido.');
        const numerator = Number(value.rate?.numerator);
        const denominator = Number(value.rate?.denominator);
        if (!Number.isInteger(numerator) || numerator < 0 || !Number.isInteger(denominator) || denominator <= 0) {
            throw new PreResetProductDecisionError('invalid_decision_value', 'D01.rate invalida.');
        }
        return;
    }
    if (id === 'D02') { requiredText(value.cutoff, 'D02.cutoff'); return; }
    if (id === 'D03') { validVersion(value.resetCycleKey, 'D03.resetCycleKey'); return; }
    if (id === 'D04') {
        if (!['floor', 'ceil'].includes(value.rounding)) throw new PreResetProductDecisionError('invalid_decision_value', 'D04.rounding invalido.');
        return;
    }
    if (id === 'D05') { requiredText(value.phConsumption, 'D05.phConsumption'); return; }
    if (id === 'D06') {
        validVersion(value.catalogVersion, 'D06.catalogVersion');
        if (!Array.isArray(value.products)) throw new PreResetProductDecisionError('invalid_decision_value', 'D06.products invalido.');
        const keys = new Set();
        for (const item of value.products) {
            const itemKey = requiredText(item?.itemKey, 'D06.itemKey', 120);
            requiredText(item?.entitlementKey, 'D06.entitlementKey', 120);
            if (keys.has(itemKey)) throw new PreResetProductDecisionError('invalid_decision_value', 'D06 possui itemKey duplicado.');
            keys.add(itemKey);
            const price = Number(item?.priceReturnPoints);
            if (!Number.isInteger(price) || price <= 0) throw new PreResetProductDecisionError('invalid_decision_value', 'D06 possui preco invalido.');
        }
        return;
    }
    if (id === 'D07' || id === 'D08') { requiredText(value.mode, `${id}.mode`); return; }
    if (id === 'D09') {
        if (typeof value.eligibleReleasedSessions !== 'boolean') throw new PreResetProductDecisionError('invalid_decision_value', 'D09.eligibleReleasedSessions invalido.');
    }
}

function validatePreResetProductDecisionManifest(input, options = {}) {
    if (!plainObject(input)) throw new PreResetProductDecisionError('invalid_manifest', 'Manifesto pre-reset invalido.');
    if (input.schemaVersion !== DECISION_SCHEMA_VERSION) throw new PreResetProductDecisionError('invalid_manifest', 'schemaVersion pre-reset invalida.');
    requiredText(input.decisionSetVersion, 'decisionSetVersion', 120);
    if (!Array.isArray(input.decisions)) throw new PreResetProductDecisionError('invalid_manifest', 'Lista D01-D09 ausente.');
    if (input.decisions.length !== DECISION_IDS.length) throw new PreResetProductDecisionError('incomplete_manifest', 'O manifesto precisa conter exatamente D01-D09.');

    const seen = new Set();
    const byId = new Map();
    for (const decision of input.decisions) {
        const id = String(decision?.id || '').trim().toUpperCase();
        if (!DECISION_IDS.includes(id)) throw new PreResetProductDecisionError('unknown_decision', `Decisao desconhecida: ${id || '(vazia)'}.`);
        if (seen.has(id)) throw new PreResetProductDecisionError('duplicate_decision', `Decisao duplicada: ${id}.`);
        seen.add(id);
        const key = String(decision?.key || '').trim();
        if (key !== DECISION_KEYS[id]) throw new PreResetProductDecisionError('decision_key_mismatch', `Chave canonica invalida em ${id}.`);
        const status = String(decision?.status || '').trim().toUpperCase();
        if (!DECISION_STATUSES.includes(status)) throw new PreResetProductDecisionError('invalid_decision_status', `Status invalido em ${id}.`);
        if (status === 'UNRESOLVED') {
            if (decision.value !== null && decision.value !== undefined) throw new PreResetProductDecisionError('unresolved_has_value', `${id} nao pode esconder valor enquanto UNRESOLVED.`);
        } else {
            validateApprovedValue(id, decision.value);
        }
        byId.set(id, Object.freeze({ ...decision, id, key, status }));
    }
    for (const id of DECISION_IDS) {
        if (!seen.has(id)) throw new PreResetProductDecisionError('incomplete_manifest', `Decisao ausente: ${id}.`);
    }
    if (options.requireAllApproved && DECISION_IDS.some((id) => byId.get(id).status !== 'APPROVED')) {
        throw new PreResetProductDecisionError('product_decisions_unresolved', 'D01-D09 ainda possuem decisoes nao aprovadas.');
    }
    return Object.freeze({
        schemaVersion: input.schemaVersion,
        decisionSetVersion: input.decisionSetVersion,
        testOnly: input.testOnly === true,
        decisions: Object.freeze(DECISION_IDS.map((id) => byId.get(id))),
    });
}

function loadPreResetProductDecisionManifest(filename = CANONICAL_MANIFEST_PATH, options = {}) {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return validatePreResetProductDecisionManifest(parsed, options);
}

function summarizePreResetProductDecisions(manifest) {
    const validated = validatePreResetProductDecisionManifest(manifest);
    const approved = validated.decisions.filter((item) => item.status === 'APPROVED').map((item) => item.id);
    const unresolved = validated.decisions.filter((item) => item.status === 'UNRESOLVED').map((item) => item.id);
    return Object.freeze({
        decisionTotal: validated.decisions.length,
        decisionApproved: approved.length,
        decisionUnresolved: unresolved.length,
        approved: Object.freeze(approved),
        unresolved: Object.freeze(unresolved),
        configurationSchemaReady: true,
        productDecisionsResolved: unresolved.length === 0,
        activationAuthorized: false,
    });
}

function decisionMap(validated) {
    return new Map(validated.decisions.map((item) => [item.id, item]));
}

function buildPolicyPlan(manifest, options = {}) {
    const validated = validatePreResetProductDecisionManifest(manifest, { requireAllApproved: true });
    if (options.testOnly !== true || validated.testOnly !== true) {
        throw new PreResetProductDecisionError('production_policy_configuration_forbidden', 'Compilacao de policy real ainda nao esta autorizada.');
    }
    const d = decisionMap(validated);
    const d01 = d.get('D01').value;
    const d02 = d.get('D02').value;
    const d03 = d.get('D03').value;
    const d04 = d.get('D04').value;
    const d05 = d.get('D05').value;
    const d06 = d.get('D06').value;
    const d09 = d.get('D09').value;
    if (d01.source !== 'available') {
        throw new PreResetProductDecisionError('unsupported_selected_semantics', 'O runtime atual ainda nao suporta D01.source diferente de available.');
    }
    if (d05.phConsumption !== 'none') {
        throw new PreResetProductDecisionError('unsupported_selected_semantics', 'O runtime atual ainda nao suporta consumo real de PH.');
    }
    return Object.freeze({
        policies: Object.freeze({
            PRE_RESET_MODE: Object.freeze({ status: 'ENABLED', policyVersion: validVersion(validated.decisionSetVersion, 'decisionSetVersion') }),
            PH_RETURN_CONVERSION: Object.freeze({ status: 'ENABLED', policyVersion: `${validVersion(validated.decisionSetVersion, 'decisionSetVersion')}:conversion`, resetCycleKey: d03.resetCycleKey, cutoff: d02.cutoff, rate: Object.freeze({ numerator: d01.rate.numerator, denominator: d01.rate.denominator }), rounding: d04.rounding, phConsumption: d05.phConsumption }),
            RESET_SHOP: Object.freeze({ status: 'ENABLED', policyVersion: `${validVersion(validated.decisionSetVersion, 'decisionSetVersion')}:shop`, catalogVersion: d06.catalogVersion, products: Object.freeze(d06.products.map((item) => Object.freeze({ ...item }))) }),
            LIMITED_CHOICES: Object.freeze({ status: 'ENABLED', policyVersion: `${validVersion(validated.decisionSetVersion, 'decisionSetVersion')}:limits` }),
            REFUND: Object.freeze({ status: 'ENABLED', policyVersion: `${validVersion(validated.decisionSetVersion, 'decisionSetVersion')}:refund` }),
            SESSION_ELIGIBILITY: Object.freeze({ status: 'ENABLED', policyVersion: `${validVersion(validated.decisionSetVersion, 'decisionSetVersion')}:eligibility`, eligibleReleasedSessions: d09.eligibleReleasedSessions }),
        }),
        supportMatrix: SUPPORT_MATRIX,
        behaviorallyComplete: Object.values(SUPPORT_MATRIX).every((item) => item.status === 'SUPPORTED_NOW'),
    });
}

function compileTestOnlyPreResetPolicyRegistry(manifest) {
    const plan = buildPolicyPlan(manifest, { testOnly: true });
    return Object.freeze({ registry: createPreResetPolicyRegistry({ testOnly: true, policies: plan.policies }), supportMatrix: plan.supportMatrix, behaviorallyComplete: plan.behaviorallyComplete });
}

function compileProductionPreResetPolicyRegistry() {
    throw new PreResetProductDecisionError('activation_not_authorized', 'Ativacao de policy pre-reset de producao nao esta autorizada nesta fundacao.');
}

module.exports = {
    CANONICAL_MANIFEST_PATH,
    DECISION_IDS,
    DECISION_KEYS,
    DECISION_SCHEMA_VERSION,
    DECISION_STATUSES,
    SUPPORT_MATRIX,
    PreResetProductDecisionError,
    buildPolicyPlan,
    compileProductionPreResetPolicyRegistry,
    compileTestOnlyPreResetPolicyRegistry,
    loadPreResetProductDecisionManifest,
    summarizePreResetProductDecisions,
    validatePreResetProductDecisionManifest,
};