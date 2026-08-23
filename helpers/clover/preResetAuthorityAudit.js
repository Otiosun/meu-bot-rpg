'use strict';

function auditPreResetAuthoritySources(sources = {}) {
    const character = String(sources.character || '');
    const shop = String(sources.shop || '');
    const conversion = String(sources.conversion || '');
    const returnPoints = String(sources.returnPoints || '');
    const access = String(sources.access || '');
    const blockers = [];
    const forbiddenRecruitment = /clover_pr_ledger|addRecruitmentPr|prService/i;
    if (forbiddenRecruitment.test([character, shop, conversion, returnPoints].join('\n'))) {
        blockers.push('recruitment_pr_reference');
    }
    if (/\bUPDATE\s+jogadores\b/i.test(character) || /\bINSERT\s+INTO\s+jogadores\b/i.test(character)) {
        blockers.push('future_character_active_player_write');
    }
    if (/jogadores\.raca|clover_inventory_items|inventoryService/i.test(shop)) {
        blockers.push('shop_active_character_delivery');
    }
    if (!/getPhLedgerAuthoritySnapshot/.test(conversion)
        || /ph_available|ph_accumulated|clover_character_stats/i.test(conversion)) {
        blockers.push('conversion_not_ledger_authority');
    }
    if (!/clover_return_points_ledger/.test(returnPoints)
        || /clover_pr_ledger/i.test(returnPoints)) {
        blockers.push('return_points_authority_invalid');
    }
    if (!/PRE_RESET_LAUNCH_ENABLED === 'true'/.test(access)) {
        blockers.push('mode_gate_not_fail_closed');
    }
    return Object.freeze({
        ok: blockers.length === 0,
        blockers: Object.freeze(blockers),
        recruitmentPrReferences: blockers.includes('recruitment_pr_reference') ? 1 : 0,
        activeCharacterWrites: blockers.filter((item) => /active|delivery/.test(item)).length,
    });
}

module.exports = { auditPreResetAuthoritySources };
