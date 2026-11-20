'use strict';

// Same canonical quoted-message identity used by traditional evaluation receipts.
// This is a transport reference, not proof that quoted text is authentic.
const { getMessageContextInfo } = require('../messageContext');
const { normalizeJid } = require('../groupAccess');

function quotedSceneKey(message, chatId) {
    const context = getMessageContextInfo(message);
    if (!context?.stanzaId) return null;
    return [
        normalizeJid(context.remoteJid || chatId || ''),
        normalizeJid(context.participant || ''),
        context.stanzaId,
    ].join(':');
}
async function tableExists(db, name) {
    return Boolean(await db.get("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?", [name]));
}
async function findMissionSceneClaim(db, sceneKey) {
    if (!sceneKey || !await tableExists(db, 'clover_mission_scene_claims')) return null;
    return (await db.get('SELECT mission_key,player_id FROM clover_mission_scene_claims WHERE scene_key=?', [sceneKey])) ?? null;
}
async function findLegacySceneEvaluation(db, sceneKey) {
    if (!sceneKey || !await tableExists(db, 'clover_quick_evaluations')) return null;
    return (await db.get('SELECT id FROM clover_quick_evaluations WHERE quoted_message_key=?', [sceneKey])) ?? null;
}
module.exports = { quotedSceneKey, findMissionSceneClaim, findLegacySceneEvaluation };
