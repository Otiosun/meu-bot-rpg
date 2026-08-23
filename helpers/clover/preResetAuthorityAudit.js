'use strict';

function auditPreResetAuthoritySources(sources = {}) {
    const character = String(sources.character || '');
    const shop = String(sources.shop || '');
    const conversion = String(sources.conversion || '');
    const returnPoints = String(sources.returnPoints || '');
    const access = String(sources.access || '');
    const policy = sources.policy === undefined ? null : String(sources.policy || '');
    const api = sources.api === undefined ? null : String(sources.api || '');
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
        || /FROM\s+clover_character_stats/i.test(conversion)) {
        blockers.push('conversion_not_ledger_authority');
    }
    if (!/clover_return_points_ledger/.test(returnPoints)
        || /clover_pr_ledger/i.test(returnPoints)) {
        blockers.push('return_points_authority_invalid');
    }
    if (!/PRE_RESET_LAUNCH_ENABLED === 'true'/.test(access)) {
        blockers.push('mode_gate_not_fail_closed');
    }
    if (policy !== null && (!/DEFAULT_PRE_RESET_POLICY_REGISTRY/.test(policy)
        || !/NOT_CONFIGURED/.test(policy)
        || !/production_policy_configuration_forbidden/.test(policy))) {
        blockers.push('policy_registry_not_fail_closed');
    }
    if (api !== null && (!/authenticateSiteSession/.test(api)
        || !/getIntegratedAccessContext/.test(api)
        || !/assertPreResetMutationAllowed/.test(api)
        || !/rejectClientAuthority/.test(api))) {
        blockers.push('site_api_access_pipeline_missing');
    }
    if (api !== null && /clover_pr_ledger|jogadores\.raca|clover_inventory_items/i.test(api)) {
        blockers.push('site_api_active_or_recruitment_write_reference');
    }
    return Object.freeze({
        ok: blockers.length === 0,
        blockers: Object.freeze(blockers),
        recruitmentPrReferences: blockers.includes('recruitment_pr_reference') ? 1 : 0,
        activeCharacterWrites: blockers.filter((item) => /active|delivery/.test(item)).length,
    });
}

module.exports = { auditPreResetAuthoritySources };
