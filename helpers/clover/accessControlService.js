'use strict';

const legacy = require('./accessControlLegacyService');
const {
    authorizeCanonicalGlobalPermission,
} = require('./canonicalGlobalAccessService');

async function hasAccessPermission(db, actorId, permission) {
    const canonical = await authorizeCanonicalGlobalPermission(db, {
        actorId,
        permission,
    });

    if (canonical.ok) return true;
    if (canonical.fallbackAllowed !== true) return false;
    return legacy.hasAccessPermission(db, actorId, permission);
}

module.exports = {
    ...legacy,
    hasAccessPermission,
};
