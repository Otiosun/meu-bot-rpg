'use strict';

const DEFAULT_CAMPAIGN_KEY = 'mythic_launch_v1';

function safeJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '');
    } catch {
        return fallback;
    }
}

function filled(value) {
    const normalized = String(value ?? '').trim();
    return normalized && normalized !== '-' ? normalized : null;
}

function normalizeRarity(value) {
    const rarity = String(value || '').trim().toLowerCase();
    if (['rare', 'rara', 'raro'].includes(rarity)) return 'rare';
    if (['common', 'comum'].includes(rarity)) return 'common';
    return null;
}

function traitChoice(value) {
    if (!value || typeof value !== 'object') return null;
    const key = filled(value.key);
    const name = filled(value.name);
    if (!key && !name) return null;
    return { key, name, rarity: normalizeRarity(value.rarity) };
}

function futureTraits(draft = {}) {
    const traits = draft?.traits && typeof draft.traits === 'object' ? draft.traits : {};
    return {
        aptitude: traitChoice(traits.aptitude),
        mark: traitChoice(traits.mark),
        anomaly: traitChoice(traits.anomaly),
    };
}

function canonicalTraits(player = {}) {
    const aptitudeRare = filled(player.aptidao_rara);
    const aptitudeCommon = filled(player.aptidao_comum);
    const markRare = filled(player.marca_rara);
    const markCommon = filled(player.marca_comum);
    return {
        aptitude: aptitudeRare || aptitudeCommon ? {
            key: filled(aptitudeRare ? player.aptidao_rara_key : player.aptidao_comum_key),
            name: aptitudeRare || aptitudeCommon,
            rarity: aptitudeRare ? 'rare' : 'common',
        } : null,
        mark: markRare || markCommon ? {
            key: filled(markRare ? player.marca_rara_key : player.marca_comum_key),
            name: markRare || markCommon,
            rarity: markRare ? 'rare' : 'common',
        } : null,
        anomaly: filled(player.anomalia) ? {
            key: filled(player.anomalia_key),
            name: filled(player.anomalia),
            rarity: 'rare',
        } : null,
    };
}

function sameTrait(expected, actual) {
    if (!expected && !actual) return true;
    if (!expected || !actual) return false;
    if (expected.key && actual.key) return expected.key === actual.key;
    return expected.name === actual.name && (!expected.rarity || expected.rarity === actual.rarity);
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function readRows(db, tableName, sql, params = []) {
    return await tableExists(db, tableName) ? db.all(sql, params) : [];
}

function statusCounts(records) {
    return records.reduce((counts, record) => {
        counts[record.status] = (counts[record.status] || 0) + 1;
        return counts;
    }, {});
}

async function auditPreresetCharacterStates(db, options = {}) {
    const campaignKey = String(options.campaignKey || DEFAULT_CAMPAIGN_KEY);
    if (!await tableExists(db, 'clover_prereset_characters')) {
        return { campaignKey, counts: {}, records: [], issues: ['future_character_table_missing'] };
    }

    const characters = await db.all('SELECT * FROM clover_prereset_characters ORDER BY player_id');
    const players = await readRows(db, 'jogadores', 'SELECT * FROM jogadores ORDER BY id');
    const rolls = await readRows(
        db,
        'clover_prereset_future_rolls',
        'SELECT * FROM clover_prereset_future_rolls WHERE campaign_key=? ORDER BY player_id,roll_number',
        [campaignKey]
    );
    const memberships = await readRows(
        db,
        'clover_squad_memberships',
        "SELECT * FROM clover_squad_memberships WHERE status='active' ORDER BY player_id,id"
    );
    const playerById = new Map(players.map((row) => [String(row.id), row]));
    const rollByPlayerAndNumber = new Map(rolls.map((row) => [
        `${row.player_id}:${Number(row.roll_number)}`,
        row,
    ]));
    const membershipByPlayer = new Map();
    for (const row of memberships) {
        const key = String(row.player_id);
        if (!membershipByPlayer.has(key)) membershipByPlayer.set(key, []);
        membershipByPlayer.get(key).push(row);
    }

    const records = characters.map((character) => {
        const playerId = String(character.player_id);
        const draft = safeJson(character.draft_json, null);
        const player = playerById.get(playerId) || null;
        const rollNumber = Number(draft?.rollNumber || 0);
        const selectedRoll = rollByPlayerAndNumber.get(`${playerId}:${rollNumber}`) || null;
        const expectedTraits = futureTraits(draft || {});
        const currentTraits = canonicalTraits(player || {});
        const activeMemberships = membershipByPlayer.get(playerId) || [];
        const isCanonicalCharacter = Boolean(player && draft
            && filled(player.personagem_nome) === filled(draft.name)
            && Number(player.numero_roll_escolhido || 0) === rollNumber);
        const traitMismatches = ['aptitude', 'mark', 'anomaly']
            .filter((category) => !sameTrait(expectedTraits[category], currentTraits[category]));
        const issues = [];
        if (!draft) issues.push('invalid_draft_json');
        if (draft && rollNumber && !selectedRoll) issues.push('selected_roll_missing');
        if (filled(player?.esquadrao)) issues.push('legacy_squad_present');
        if (activeMemberships.length) issues.push('active_squad_membership');
        if (isCanonicalCharacter && traitMismatches.length) issues.push('canonical_traits_mismatch');

        let promotionState = 'not_eligible';
        if (['approved', 'locked'].includes(String(character.status))) {
            if (!isCanonicalCharacter) promotionState = 'ready_for_promotion';
            else if (traitMismatches.length) promotionState = 'promoted_traits_missing';
            else promotionState = 'promoted_complete';
        }

        return {
            playerId,
            displayName: filled(player?.display_name) || filled(player?.nome),
            status: String(character.status || 'unknown'),
            revision: Number(character.revision || 0),
            characterName: filled(draft?.name),
            rollNumber: rollNumber || null,
            selectedRoll: selectedRoll ? {
                kingdom: filled(selectedRoll.kingdom),
                socialClass: filled(selectedRoll.social_class),
                race: filled(selectedRoll.race),
                grimoire: filled(selectedRoll.grimoire),
            } : null,
            traits: expectedTraits,
            canonicalTraits: currentTraits,
            canonicalCharacterName: filled(player?.personagem_nome),
            canonicalSquad: filled(player?.esquadrao),
            activeSquads: activeMemberships.map((row) => filled(row.squad_key)).filter(Boolean),
            traitMismatches,
            promotionState,
            issues,
        };
    });

    return {
        campaignKey,
        counts: statusCounts(records),
        records,
        issues: [...new Set(records.flatMap((record) => record.issues))].sort(),
    };
}

module.exports = {
    DEFAULT_CAMPAIGN_KEY,
    auditPreresetCharacterStates,
    canonicalTraits,
    futureTraits,
    normalizeRarity,
    sameTrait,
};
