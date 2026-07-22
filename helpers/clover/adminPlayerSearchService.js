'use strict';

const { normalizeText } = require('../textUtils');
const {
    findPlayersByIdentifier,
    getCanonicalPlayer,
    isEmptyCharacterPlayer,
} = require('./targetResolver');

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

function normalizeSearch(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function levenshtein(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    if (!a) return b.length;
    if (!b) return a.length;

    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + cost
            );
        }
        for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
    }

    return previous[b.length];
}

function similarity(left, right) {
    const a = normalizeSearch(left);
    const b = normalizeSearch(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const longest = Math.max(a.length, b.length);
    return longest ? 1 - (levenshtein(a, b) / longest) : 0;
}

function maskPhoneFromPlayerId(playerId) {
    const text = String(playerId || '');
    if (!text.endsWith('@s.whatsapp.net')) return null;
    const digits = text.replace(/\D/g, '');
    if (digits.length < 7) return null;
    return `${digits.slice(0, 4)}••••${digits.slice(-4)}`;
}

function playerNames(player = {}) {
    return [
        player.personagem_nome,
        player.display_name,
        player.nome,
    ].map((value) => String(value || '').trim()).filter(Boolean);
}

function playerSearchResult(player, extras = {}) {
    return {
        playerId: String(player?.id || ''),
        characterName: String(player?.personagem_nome || player?.display_name || player?.nome || '-'),
        displayName: String(player?.display_name || player?.nome || '') || null,
        phoneMasked: maskPhoneFromPlayerId(player?.id),
        squad: String(player?.esquadrao || '') || null,
        gameStatus: String(player?.jogo_status || '') || null,
        lifecycleStatus: String(player?.lifecycle_status || '') || null,
        canonical: Number(player?.is_shadow || 0) !== 1 && !player?.merged_into,
        hasCharacter: !isEmptyCharacterPlayer(player),
        ...extras,
    };
}

function fuzzyScore(query, player) {
    const normalizedQuery = normalizeSearch(query);
    if (!normalizedQuery) return 0;
    let best = 0;
    for (const name of playerNames(player)) {
        const normalizedName = normalizeSearch(name);
        if (!normalizedName) continue;
        if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
            best = Math.max(best, 0.82);
        }
        best = Math.max(best, similarity(normalizedQuery, normalizedName));
    }
    return best;
}

async function defaultListPlayers(db) {
    return db.all(`
        SELECT id, personagem_nome, display_name, nome, esquadrao,
               jogo_status, lifecycle_status, is_shadow, merged_into,
               canonical_player_id
        FROM jogadores
        WHERE id IS NOT NULL
    `);
}

async function searchAdminPlayers(db, query, options = {}) {
    const rawQuery = String(query || '').trim();
    const normalizedQuery = normalizeSearch(rawQuery);
    if (normalizedQuery.length < 2 && rawQuery.replace(/\D/g, '').length < 4) {
        const error = new Error('Digite pelo menos dois caracteres ou quatro números.');
        error.code = 'search_query_too_short';
        error.status = 400;
        throw error;
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit || DEFAULT_LIMIT)));
    const findMatches = options.findMatches || findPlayersByIdentifier;
    const listPlayers = options.listPlayers || defaultListPlayers;
    const resolveCanonical = options.getCanonical || getCanonicalPlayer;

    const rawMatches = await findMatches(db, rawQuery, options.resolverOptions || {});
    const exact = [];
    const exactIds = new Set();

    for (const match of rawMatches) {
        if (Number(match.score || 0) < 85) continue;
        const player = match.player;
        if (!player?.id || exactIds.has(player.id)) continue;
        exactIds.add(player.id);
        exact.push(playerSearchResult(player, {
            source: match.source || 'resolved',
            score: Number(match.score || 0),
            redirectedFrom: match.redirectedFrom || null,
        }));
        if (exact.length >= limit) break;
    }

    const candidates = await listPlayers(db);
    const canonicalById = new Map();
    for (const row of candidates || []) {
        const canonical = await resolveCanonical(db, row, { skipSelfHydrate: true }) || row;
        if (!canonical?.id || canonicalById.has(canonical.id)) continue;
        canonicalById.set(canonical.id, canonical);
    }

    const suggestions = [...canonicalById.values()]
        .filter((player) => !exactIds.has(player.id) && !isEmptyCharacterPlayer(player))
        .map((player) => ({ player, score: fuzzyScore(rawQuery, player) }))
        .filter((entry) => entry.score >= 0.55)
        .sort((left, right) => right.score - left.score || String(left.player.id).localeCompare(String(right.player.id)))
        .slice(0, limit)
        .map((entry) => playerSearchResult(entry.player, {
            source: 'fuzzy',
            score: Math.round(entry.score * 100),
            redirectedFrom: null,
        }));

    const ambiguous = exact.length > 1
        && Math.abs(Number(exact[0].score || 0) - Number(exact[1].score || 0)) <= 10;

    return {
        ok: true,
        query: rawQuery,
        exact,
        suggestions,
        ambiguous,
    };
}

module.exports = {
    fuzzyScore,
    levenshtein,
    maskPhoneFromPlayerId,
    normalizeSearch,
    playerSearchResult,
    searchAdminPlayers,
    similarity,
};
