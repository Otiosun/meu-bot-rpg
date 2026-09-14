const {assertLifecycleAllowed}=require('./clover/lifecyclePolicy');
function parsePayload(rawPayload) {
    if (!rawPayload) return {};
    try {
        const parsed = JSON.parse(rawPayload);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function ensurePlayerRecord(db, playerId, displayName = 'Cacador') {
    let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    const safeDisplayName = String(displayName || 'Cacador').trim() || 'Cacador';

    if (!player) {
        assertLifecycleAllowed({surface:'internal',operation:'player.create',mutationClass:'CURRENT_WORLD'});
        await db.run(
            `INSERT INTO jogadores (id, nome, display_name)
             VALUES (?, ?, ?)`,
            [playerId, safeDisplayName, safeDisplayName]
        );
        player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    } else if (!player.display_name || player.display_name === '-') {
        assertLifecycleAllowed({surface:'internal',operation:'player.identity_update',mutationClass:'CURRENT_WORLD'});
        await db.run('UPDATE jogadores SET display_name = ? WHERE id = ?', [safeDisplayName, playerId]);
        player.display_name = safeDisplayName;
    }

    return player;
}

async function getPlayerRecord(db, playerId) {
    return db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
}

async function ensureOnboardingState(db, playerId, step = 'inicio') {
    assertLifecycleAllowed({surface:'internal',operation:'ensureOnboardingState',mutationClass:'CURRENT_WORLD'});
    await db.run(
        `INSERT OR IGNORE INTO player_onboarding
         (player_id, current_step, step_payload, started_at, welcome_sent_at, last_seen_at)
         VALUES (?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [playerId, step]
    );

    await db.run(
        `UPDATE player_onboarding
         SET last_seen_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [playerId]
    );

    const onboarding = await db.get('SELECT * FROM player_onboarding WHERE player_id = ?', [playerId]);
    return {
        ...onboarding,
        step_payload: parsePayload(onboarding?.step_payload),
    };
}

async function updateOnboardingStep(db, playerId, step, payload = null) {
    assertLifecycleAllowed({surface:'internal',operation:'updateOnboardingStep',mutationClass:'CURRENT_WORLD'});
    const current = await ensureOnboardingState(db, playerId, step);
    const nextPayload = payload === null ? current.step_payload : payload;

    await db.run(
        `UPDATE player_onboarding
         SET current_step = ?, step_payload = ?, last_seen_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [step, JSON.stringify(nextPayload || {}), playerId]
    );
}

async function getOnboardingState(db, playerId) {
    return ensureOnboardingState(db, playerId, 'inicio');
}

async function getExistingOnboardingState(db, playerId) {
    const onboarding = await db.get('SELECT * FROM player_onboarding WHERE player_id = ?', [playerId]);
    if (!onboarding) return null;

    return {
        ...onboarding,
        step_payload: parsePayload(onboarding.step_payload),
    };
}

async function markWelcomeSent(db, playerId) {
    assertLifecycleAllowed({surface:'internal',operation:'markWelcomeSent',mutationClass:'CURRENT_WORLD'});
    await ensureOnboardingState(db, playerId, 'recepcao');
    await db.run('UPDATE jogadores SET ultima_recepcao_em = CURRENT_TIMESTAMP WHERE id = ?', [playerId]);
    await db.run(
        `UPDATE player_onboarding
         SET welcome_sent_at = CURRENT_TIMESTAMP, last_seen_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [playerId]
    );
}

async function getGroupWelcomeState(db, groupId, playerId) {
    return db.get(
        `SELECT group_id, player_id, welcome_sent_at, last_seen_at
         FROM group_member_welcomes
         WHERE group_id = ? AND player_id = ?`,
        [groupId, playerId]
    );
}

async function registerGroupJoin(db, groupId, playerId) {
    assertLifecycleAllowed({surface:'internal',operation:'registerGroupJoin',mutationClass:'CURRENT_WORLD'});
    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, welcome_sent_at, last_seen_at)
         VALUES (?, ?, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(group_id, player_id) DO UPDATE SET
             last_seen_at = CURRENT_TIMESTAMP`,
        [groupId, playerId]
    );
}

async function touchGroupMember(db, groupId, playerId) {
    assertLifecycleAllowed({surface:'group_event',operation:'touchGroupMember',mutationClass:'MAINTENANCE'});
    await db.run(
        `UPDATE group_member_welcomes
         SET last_seen_at = CURRENT_TIMESTAMP
         WHERE group_id = ? AND player_id = ?`,
        [groupId, playerId]
    );
}

async function markGroupWelcomeSent(db, groupId, playerId) {
    assertLifecycleAllowed({surface:'internal',operation:'markGroupWelcomeSent',mutationClass:'CURRENT_WORLD'});
    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, welcome_sent_at, last_seen_at)
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(group_id, player_id) DO UPDATE SET
             welcome_sent_at = CURRENT_TIMESTAMP,
             last_seen_at = CURRENT_TIMESTAMP`,
        [groupId, playerId]
    );
}

async function clearGroupMemberState(db, groupId, playerId) {
    assertLifecycleAllowed({surface:'group_event',operation:'clearGroupMemberState',mutationClass:'MAINTENANCE'});
    await db.run(
        'DELETE FROM group_member_welcomes WHERE group_id = ? AND player_id = ?',
        [groupId, playerId]
    );
}

module.exports = {
    clearGroupMemberState,
    ensurePlayerRecord,
    ensureOnboardingState,
    getExistingOnboardingState,
    getGroupWelcomeState,
    getOnboardingState,
    getPlayerRecord,
    markWelcomeSent,
    markGroupWelcomeSent,
    registerGroupJoin,
    touchGroupMember,
    updateOnboardingStep,
};
