'use strict';

const EXECUTION_POLICIES = Object.freeze(['atomic', 'per_target']);

class AdminOperationPolicyError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminOperationPolicyError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function normalizeExecutionPolicy(value, fallback = 'per_target') {
    const policy = String(value || fallback).trim().toLowerCase();
    if (!EXECUTION_POLICIES.includes(policy)) {
        throw new AdminOperationPolicyError(
            'invalid_execution_policy',
            'A política da operação precisa ser atomic ou per_target.',
            400,
            { policy: value || null, allowed: EXECUTION_POLICIES }
        );
    }
    return policy;
}

function requestedExecutionPolicy(input = {}) {
    const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? input.metadata
        : {};
    const raw = input.executionPolicy
        ?? input.execution_policy
        ?? metadata.executionPolicy
        ?? metadata.execution_policy;
    return {
        policy: normalizeExecutionPolicy(raw, 'per_target'),
        declared: raw !== undefined && raw !== null && String(raw).trim() !== '',
    };
}

function operationExecutionPolicy(operation = {}) {
    return requestedExecutionPolicy(operation).policy;
}

function withExecutionPolicy(input = {}) {
    const resolved = requestedExecutionPolicy(input);
    return {
        ...input,
        metadata: {
            ...(input.metadata || {}),
            executionPolicy: resolved.policy,
            executionPolicyDeclared: resolved.declared,
        },
    };
}

function getExecutor(registry, actionType) {
    if (!registry) return null;
    if (registry instanceof Map) return registry.get(actionType) || null;
    return registry[actionType] || null;
}

function assertAtomicExecutors(actions, registry) {
    const unsupported = [];
    for (const action of actions || []) {
        const type = String(action?.type || '').trim();
        const executor = getExecutor(registry, type);
        if (!executor?.apply || executor.atomicSafe !== true) unsupported.push(type || '(vazia)');
    }
    if (unsupported.length) {
        throw new AdminOperationPolicyError(
            'atomic_policy_unsupported',
            'Uma ou mais ações não possuem executor auditado para aplicação atômica.',
            409,
            { unsupported: [...new Set(unsupported)] }
        );
    }
    return true;
}

module.exports = {
    EXECUTION_POLICIES,
    AdminOperationPolicyError,
    assertAtomicExecutors,
    getExecutor,
    normalizeExecutionPolicy,
    operationExecutionPolicy,
    requestedExecutionPolicy,
    withExecutionPolicy,
};
