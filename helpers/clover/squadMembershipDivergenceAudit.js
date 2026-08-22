'use strict';

const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');

const EMPTY_LEGACY_VALUES = new Set(['', '-']);

async function requireTables(db, tableNames) {
    const rows = await db.all(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableNames.map(() => '?').join(', ')})`,
        tableNames
    );
    const present = new Set(rows.map((row) => row.name));
    const missing = tableNames.filter((name) => !present.has(name));
    if (missing.length) {
        const error = new Error(`Squad divergence audit requires: ${missing.join(', ')}`);
        error.code = 'squad_divergence_missing_tables';
        error.details = { missing };
        throw error;
    }
}

function normalizedPlayerId(value) {
    return normalizeJid(value) || String(value ?? '').trim() || null;
}

function legacySquad(value) {
    const text = String(value ?? '').trim();
    if (EMPTY_LEGACY_VALUES.has(text)) return null;
    return normalizeSquadKey(text) || null;
}

function sortByPlayer(rows) {
    return [...rows].sort((left, right) => String(left.player_id).localeCompare(String(right.player_id)));
}

async function auditSquadMembershipDivergence(db, { exampleLimit = 20 } = {}) {
    await requireTables(db, ['jogadores', 'clover_squads', 'clover_squad_memberships']);
    const [players, squads, activeMemberships] = await Promise.all([
        db.all('SELECT id, esquadrao FROM jogadores ORDER BY id'),
        db.all('SELECT squad_key FROM clover_squads ORDER BY squad_key'),
        db.all("SELECT id, player_id, squad_key FROM clover_squad_memberships WHERE status = 'active' ORDER BY player_id, id"),
    ]);

    const validSquads = new Set(squads.map((row) => normalizeSquadKey(row.squad_key)).filter(Boolean));
    const playerRows = new Map(players.map((row) => [normalizedPlayerId(row.id), row]));
    const canonicalByPlayer = new Map();
    for (const membership of activeMemberships) {
        const playerId = normalizedPlayerId(membership.player_id);
        if (!playerId) continue;
        if (!canonicalByPlayer.has(playerId)) canonicalByPlayer.set(playerId, []);
        canonicalByPlayer.get(playerId).push(membership);
    }

    const playerIds = [...new Set([...playerRows.keys(), ...canonicalByPlayer.keys()])].filter(Boolean).sort();
    const rows = playerIds.map((playerId) => {
        const player = playerRows.get(playerId) || null;
        const memberships = canonicalByPlayer.get(playerId) || [];
        const canonicalKeys = [...new Set(memberships.map((row) => normalizeSquadKey(row.squad_key)).filter(Boolean))].sort();
        const legacyKey = legacySquad(player?.esquadrao);
        const invalidCanonical = memberships.length > 0 && (
            memberships.length !== 1
            || canonicalKeys.length !== 1
            || canonicalKeys.some((key) => !validSquads.has(key))
        );
        const invalidLegacy = legacyKey !== null && !validSquads.has(legacyKey);
        let classification;
        if (invalidCanonical) classification = 'INVALID_CANONICAL';
        else if (invalidLegacy) classification = 'INVALID_LEGACY';
        else if (canonicalKeys.length && legacyKey && canonicalKeys[0] === legacyKey) classification = 'MATCH';
        else if (canonicalKeys.length && legacyKey) classification = 'MISMATCH';
        else if (canonicalKeys.length) classification = 'CANONICAL_ONLY';
        else if (legacyKey) classification = 'LEGACY_ONLY';
        else classification = 'MATCH';
        return {
            player_id: playerId,
            classification,
            canonical_squad_keys: canonicalKeys,
            legacy_squad_key: legacyKey,
            active_membership_ids: memberships.map((row) => row.id).sort((a, b) => Number(a) - Number(b)),
        };
    });

    const summary = {
        players_checked: rows.length,
        canonical_only: rows.filter((row) => row.classification === 'CANONICAL_ONLY').length,
        legacy_only: rows.filter((row) => row.classification === 'LEGACY_ONLY').length,
        match: rows.filter((row) => row.classification === 'MATCH').length,
        mismatch: rows.filter((row) => row.classification === 'MISMATCH').length,
        duplicate_active_memberships: rows.filter((row) => row.active_membership_ids.length > 1).length,
        unknown_squad_keys: rows.filter((row) => (
            row.canonical_squad_keys.some((key) => !validSquads.has(key))
            || (row.legacy_squad_key !== null && !validSquads.has(row.legacy_squad_key))
        )).length,
    };
    summary.safe_to_cutover = summary.canonical_only === 0
        && summary.legacy_only === 0
        && summary.mismatch === 0
        && summary.duplicate_active_memberships === 0
        && summary.unknown_squad_keys === 0;
    return {
        ...summary,
        examples: sortByPlayer(rows).slice(0, Math.max(0, Math.min(100, Number(exampleLimit) || 20))),
    };
}

module.exports = {
    auditSquadMembershipDivergence,
    legacySquad,
};
