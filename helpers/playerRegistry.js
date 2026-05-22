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
        await db.run(
            `INSERT INTO jogadores (id, nome, display_name)
             VALUES (?, ?, ?)`,
            [playerId, safeDisplayName, safeDisplayName]
        );
        player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    } else if (!player.display_name || player.display_name === '-') {
        await db.run('UPDATE jogadores SET display_name = ? WHERE id = ?', [safeDisplayName, playerId]);
        player.display_name = safeDisplayName;
    }

    return player;
}

async function ensureOnboardingState(db, playerId, step = 'inicio') {
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

module.exports = {
    ensurePlayerRecord,
    ensureOnboardingState,
    getOnboardingState,
    updateOnboardingStep,
};
