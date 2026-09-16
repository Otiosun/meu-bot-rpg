'use strict';

const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');

function normalized(value) {
    return String(value || '').trim().toLowerCase();
}

function isMissingLaunchSchema(error) {
    return /no such table:\s*clover_prereset_launch_(players|rosters)/i.test(String(error?.message || error));
}

async function readPlayerAndLaunch(db, playerId, campaignKey) {
    try {
        return await db.get(
            `SELECT j.*,
                    lp.outcome AS launch_outcome,
                    lp.status AS launch_player_status,
                    lp.last_error_code AS launch_error_code,
                    lp.completed_at AS launch_completed_at,
                    lr.status AS launch_roster_status
             FROM jogadores j
             LEFT JOIN clover_prereset_launch_players lp
               ON lp.campaign_key=? AND lp.player_id=j.id
             LEFT JOIN clover_prereset_launch_rosters lr
               ON lr.campaign_key=lp.campaign_key
             WHERE j.id=?`,
            [campaignKey, String(playerId)]
        );
    } catch (error) {
        if (!isMissingLaunchSchema(error)) throw error;
        return db.get('SELECT * FROM jogadores WHERE id=?', [String(playerId)]);
    }
}

async function getCanonicalPlayerPlayability(db, playerId, options = {}) {
    const campaignKey = options.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY;
    const player = await readPlayerAndLaunch(db, playerId, campaignKey);
    const launchStatus = player?.launch_player_status || null;
    const rosterStatus = player?.launch_roster_status || null;
    const outcome = player?.launch_outcome || null;

    if (normalized(player?.lifecycle_status) === 'archived' || normalized(player?.jogo_status) === 'arquivado') {
        return { playable:false, authoritative:true, reason:'archived', source:'player_lifecycle', player, launchStatus, rosterStatus, outcome };
    }

    const deferred = outcome === 'reset'
        && launchStatus !== 'completed'
        && player?.launch_error_code === 'reset_deferred';
    if (deferred) {
        return { playable:false, authoritative:true, reason:'future_character_pending', source:'launch', player, launchStatus, rosterStatus, outcome };
    }

    const launchCompleted = launchStatus === 'completed' && rosterStatus === 'completed';
    if (launchCompleted) {
        return { playable:true, authoritative:true, reason:'launch_completed', source:'launch', player, launchStatus, rosterStatus, outcome };
    }

    return { playable:false, authoritative:false, reason:'legacy_fallback', source:'legacy_reception', player, launchStatus, rosterStatus, outcome };
}

module.exports = { getCanonicalPlayerPlayability };
