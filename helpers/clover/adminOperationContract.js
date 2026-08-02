'use strict';

const base = require('./adminOperationContractBase');

const OPERATION_STATUSES = Object.freeze([
    'draft',
    'simulated',
    'approved',
    'applying',
    'applied',
    'partially_applied',
    'retrying',
    'compensating',
    'compensated',
    'accepted_partial',
    'failed',
    'cancelled',
    'undone',
]);

const STATUS_TRANSITIONS = Object.freeze({
    draft: Object.freeze(['simulated', 'cancelled']),
    simulated: Object.freeze(['approved', 'cancelled']),
    approved: Object.freeze(['applying', 'cancelled']),
    applying: Object.freeze(['applied', 'partially_applied', 'failed']),
    applied: Object.freeze(['undone', 'compensating']),
    partially_applied: Object.freeze(['retrying', 'compensating', 'accepted_partial']),
    retrying: Object.freeze(['applied', 'partially_applied', 'failed']),
    compensating: Object.freeze(['compensated', 'partially_applied']),
    compensated: Object.freeze([]),
    accepted_partial: Object.freeze([]),
    failed: Object.freeze(['retrying']),
    cancelled: Object.freeze([]),
    undone: Object.freeze([]),
});

function canTransitionOperation(fromStatus, toStatus) {
    const from = String(fromStatus || '').trim();
    const to = String(toStatus || '').trim();
    if (!OPERATION_STATUSES.includes(from) || !OPERATION_STATUSES.includes(to)) return false;
    return (STATUS_TRANSITIONS[from] || []).includes(to);
}

module.exports = {
    ...base,
    OPERATION_STATUSES,
    STATUS_TRANSITIONS,
    canTransitionOperation,
};
