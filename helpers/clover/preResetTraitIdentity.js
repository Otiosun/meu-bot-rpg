'use strict';

const crypto = require('crypto');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');

function getFutureTraitIdentity(playerId, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    const id = String(playerId || '').trim();
    if (!id) throw new Error('player_id futuro obrigatorio para tentativa de traco.');
    const digest = crypto.createHash('sha256')
        .update(`${campaignKey}|${id}`)
        .digest('hex');
    return `prereset:${campaignKey}:${digest}`;
}

module.exports = { getFutureTraitIdentity };