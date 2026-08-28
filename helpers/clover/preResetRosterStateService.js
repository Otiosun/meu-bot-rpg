'use strict';

const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');

function normalizedStatus(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

async function getAssignedPreResetState(db, playerId) {
    const id = String(playerId || '').trim();
    if (!id) return Object.freeze({ kind:'unassigned', reason:'missing_player_id' });

    const roster = await db.get(
        `SELECT campaign_key,status,revision,finalized_at
         FROM clover_prereset_launch_rosters
         WHERE campaign_key=?`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY]
    );
    if (!roster || roster.status !== 'finalized') {
        return Object.freeze({ kind:'unavailable', roster:roster || null });
    }

    const assignment = await db.get(
        `SELECT campaign_key,player_id,roster_revision,outcome,status
         FROM clover_prereset_launch_players
         WHERE campaign_key=? AND player_id=?`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY,id]
    );
    if (assignment?.outcome === 'keep') return Object.freeze({ kind:'keep', roster, assignment });
    if (assignment?.outcome === 'reset') return Object.freeze({ kind:'reset', roster, assignment });
    if (assignment) return Object.freeze({ kind:'unassigned', roster, assignment, reason:'invalid_roster_outcome' });

    const player = await db.get('SELECT id,ficha_status FROM jogadores WHERE id=?', [id]);
    const approvedLegacy = normalizedStatus(player?.ficha_status) === 'aprovada';
    if (!player || !approvedLegacy) return Object.freeze({ kind:'new_player', roster, player:player || null });

    return Object.freeze({ kind:'unassigned', roster, player, reason:'approved_player_missing_from_finalized_roster' });
}

function isPreResetBuildState(state) {
    return state?.kind === 'reset' || state?.kind === 'new_player';
}

module.exports = {
    getAssignedPreResetState,
    isPreResetBuildState,
};
