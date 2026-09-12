'use strict';

const { contextCanAnywhere } = require('./integratedAccessContextService');

const PRE_RESET_ADMIN_LEVEL_EQUIVALENCE = Object.freeze({
    3: 'admin',
    4: 'owner',
});

function resolvePreResetAdminLevel(context = {}) {
    if (context?.owner === true) return 4;
    const hasGlobalAdmin = (context?.assignments || []).some((assignment) => (
        assignment?.scope_type === 'global'
        && assignment?.role_key === 'admin'
    ));
    return hasGlobalAdmin ? 3 : null;
}

function canReviewPreResetAppearance(context = {}) {
    const level = resolvePreResetAdminLevel(context);
    if (level !== 3 && level !== 4) return false;
    return contextCanAnywhere(context, 'prereset.review');
}

module.exports = {
    PRE_RESET_ADMIN_LEVEL_EQUIVALENCE,
    canReviewPreResetAppearance,
    resolvePreResetAdminLevel,
};
