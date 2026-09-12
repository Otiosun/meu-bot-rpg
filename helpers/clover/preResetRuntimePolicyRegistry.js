'use strict';

const {
    DEFAULT_PRE_RESET_POLICY_REGISTRY,
    createPreResetPolicyRegistry,
} = require('./preResetPolicyRegistryService');
const {
    RETURN_POINT_SHOP_CATALOG,
    RETURN_POINT_SHOP_CATALOG_VERSION,
} = require('./returnPointShopCatalog');

function createRuntimePreResetPolicyRegistry(env = process.env) {
    if (env?.PRE_RESET_RUNTIME_POLICY_ENABLED !== 'true') {
        return DEFAULT_PRE_RESET_POLICY_REGISTRY;
    }

    return createPreResetPolicyRegistry({
        productionApproval: {
            approvedBy: env.PRE_RESET_POLICY_APPROVED_BY,
            approvalId: env.PRE_RESET_POLICY_APPROVAL_ID,
            approvedAt: env.PRE_RESET_POLICY_APPROVED_AT,
        },
        policies: {
            PRE_RESET_MODE: {
                status: 'ENABLED',
                policyVersion: env.PRE_RESET_POLICY_VERSION,
            },
            SESSION_ELIGIBILITY: {
                status: 'ENABLED',
                policyVersion: env.PRE_RESET_SESSION_POLICY_VERSION,
                eligibleReleasedSessions: true,
            },
            RESET_SHOP: {
                status: 'ENABLED',
                policyVersion: env.PRE_RESET_POLICY_VERSION,
                catalogVersion: RETURN_POINT_SHOP_CATALOG_VERSION,
                products: RETURN_POINT_SHOP_CATALOG,
            },
        },
    });
}

module.exports = {
    createRuntimePreResetPolicyRegistry,
};
