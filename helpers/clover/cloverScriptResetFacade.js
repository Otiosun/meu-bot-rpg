const squadService = require('./squadService');
const { normalizeSquadKey } = require('./cavalierService');

const originalSyncSquadGroupDescription = squadService.syncSquadGroupDescription;

if (!originalSyncSquadGroupDescription.__cloverResetCompat) {
    const compatibleSync = async (...args) => {
        if (args.length === 1 && args[0] && typeof args[0] === 'object' && args[0].db) {
            return originalSyncSquadGroupDescription(args[0]);
        }

        const [sock, db, squadValue] = args;
        return originalSyncSquadGroupDescription({
            sock,
            db,
            squadKey: normalizeSquadKey(squadValue),
        });
    };
    compatibleSync.__cloverResetCompat = true;
    squadService.syncSquadGroupDescription = compatibleSync;
}

module.exports = require('./cloverScriptResetService');
