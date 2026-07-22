'use strict';

const {
    TRAIT_SLOTS,
    ensureAdminTraitSchema,
    getPlayerTraitState,
    getTraitTemplate,
} = require('./adminTraitService');

async function getAdminPlayerTraitOverview(db, playerId) {
    await ensureAdminTraitSchema(db);

    const slots = [];
    for (const slotKey of TRAIT_SLOTS) {
        const state = await getPlayerTraitState(db, playerId, slotKey);
        const trait = state.assignment?.traitId
            ? await getTraitTemplate(db, state.assignment.traitId, { nullIfMissing: true })
            : null;

        slots.push({
            ...state,
            trait,
            source: trait ? 'catalog' : state.value ? 'legacy' : 'empty',
        });
    }

    return {
        available: true,
        status: 'active',
        slots,
    };
}

module.exports = {
    getAdminPlayerTraitOverview,
};
