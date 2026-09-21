'use strict';

const ACCENTS = Object.freeze(['gold', 'crimson', 'azure', 'violet', 'emerald']);
const HERO_STYLES = Object.freeze(['portrait', 'cover']);
const HERO_FACTS = Object.freeze(['magic', 'kingdom', 'race', 'grimoire', 'socialClass', 'family', 'rank']);
const FEATURED_KINDS = Object.freeze(['auto', 'trait', 'history', 'none']);
const PROFILE_SECTIONS = Object.freeze(['identity', 'links', 'traits', 'history', 'effects']);
const MAX_MOTTO_LENGTH = 120;
const MAX_FEATURED_ID_LENGTH = 240;
const MAX_SERIALIZED_BYTES = 4096;

class ProfilePresentationPreferencesError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ProfilePresentationPreferencesError';
        this.code = code;
        this.details = details;
    }
}

function defaultProfilePresentationPreferences() {
    return {
        accent: 'gold',
        heroStyle: 'portrait',
        heroFacts: ['magic', 'kingdom', 'race', 'grimoire'],
        motto: '',
        featured: 'auto',
        featuredId: null,
        sectionOrder: [...PROFILE_SECTIONS],
        hiddenSections: [],
    };
}

function uniqueKnownList(value, allowed, fallback = []) {
    if (!Array.isArray(value)) return [...fallback];
    const allowedSet = new Set(allowed);
    return [...new Set(value.filter((entry) => typeof entry === 'string' && allowedSet.has(entry)))];
}

function normalizeSectionOrder(value) {
    const selected = uniqueKnownList(value, PROFILE_SECTIONS);
    return [...selected, ...PROFILE_SECTIONS.filter((entry) => !selected.includes(entry))];
}

function normalizeProfilePresentationPreferences(value, { strict = true } = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaults = defaultProfilePresentationPreferences();

    const accent = ACCENTS.includes(input.accent) ? input.accent : defaults.accent;
    const heroStyle = HERO_STYLES.includes(input.heroStyle) ? input.heroStyle : defaults.heroStyle;
    const featured = FEATURED_KINDS.includes(input.featured) ? input.featured : defaults.featured;

    const motto = typeof input.motto === 'string' ? input.motto.trim() : '';
    if (strict && motto.length > MAX_MOTTO_LENGTH) {
        throw new ProfilePresentationPreferencesError(
            'motto_too_long',
            `A frase do personagem pode ter no máximo ${MAX_MOTTO_LENGTH} caracteres.`
        );
    }

    const featuredId = typeof input.featuredId === 'string' && input.featuredId.trim()
        ? input.featuredId.trim()
        : null;
    if (strict && featuredId && featuredId.length > MAX_FEATURED_ID_LENGTH) {
        throw new ProfilePresentationPreferencesError(
            'featured_id_too_long',
            'O identificador do destaque é grande demais.'
        );
    }

    const normalized = {
        accent,
        heroStyle,
        heroFacts: uniqueKnownList(input.heroFacts, HERO_FACTS, defaults.heroFacts),
        motto: motto.slice(0, MAX_MOTTO_LENGTH),
        featured,
        featuredId: featuredId ? featuredId.slice(0, MAX_FEATURED_ID_LENGTH) : null,
        sectionOrder: normalizeSectionOrder(input.sectionOrder),
        hiddenSections: uniqueKnownList(input.hiddenSections, PROFILE_SECTIONS),
    };

    const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
    if (strict && bytes > MAX_SERIALIZED_BYTES) {
        throw new ProfilePresentationPreferencesError(
            'profile_presentation_too_large',
            'As preferências de apresentação ultrapassam o limite permitido.',
            { maximumBytes: MAX_SERIALIZED_BYTES, receivedBytes: bytes }
        );
    }
    return normalized;
}

function parseStoredPreferences(raw) {
    if (!raw) return defaultProfilePresentationPreferences();
    try {
        return normalizeProfilePresentationPreferences(JSON.parse(raw), { strict: false });
    } catch {
        return defaultProfilePresentationPreferences();
    }
}

async function getProfilePresentationPreferences(db, playerId) {
    const row = await db.get(
        `SELECT site_profile_presentation_json, site_profile_presentation_updated_at
         FROM jogadores WHERE id = ?`,
        [playerId]
    );
    if (!row) {
        throw new ProfilePresentationPreferencesError('player_not_found', 'Jogador não encontrado.');
    }
    return {
        ok: true,
        preferences: parseStoredPreferences(row.site_profile_presentation_json),
        updatedAt: row.site_profile_presentation_updated_at || null,
    };
}

async function saveProfilePresentationPreferences(db, playerId, value) {
    const preferences = normalizeProfilePresentationPreferences(value, { strict: true });
    const serialized = JSON.stringify(preferences);
    const result = await db.run(
        `UPDATE jogadores
         SET site_profile_presentation_json = ?,
             site_profile_presentation_updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [serialized, playerId]
    );
    if (!Number(result?.changes || 0)) {
        throw new ProfilePresentationPreferencesError('player_not_found', 'Jogador não encontrado.');
    }
    const row = await db.get(
        `SELECT site_profile_presentation_updated_at
         FROM jogadores WHERE id = ?`,
        [playerId]
    );
    return {
        ok: true,
        preferences,
        updatedAt: row?.site_profile_presentation_updated_at || null,
    };
}

module.exports = {
    ACCENTS,
    FEATURED_KINDS,
    HERO_FACTS,
    HERO_STYLES,
    MAX_FEATURED_ID_LENGTH,
    MAX_MOTTO_LENGTH,
    MAX_SERIALIZED_BYTES,
    PROFILE_SECTIONS,
    ProfilePresentationPreferencesError,
    defaultProfilePresentationPreferences,
    getProfilePresentationPreferences,
    normalizeProfilePresentationPreferences,
    parseStoredPreferences,
    saveProfilePresentationPreferences,
};
