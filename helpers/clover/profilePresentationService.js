'use strict';

const PROFILE_PRESENTATION_SCHEMA_VERSION = 'profile-presentation.v2';

const PROFILE_SKINS = Object.freeze(['arcane', 'grimoire', 'royal', 'stained', 'dossier', 'oneiric']);
const PROFILE_PALETTES = Object.freeze(['gold', 'crimson', 'azure', 'violet', 'emerald', 'silver', 'amber', 'teal']);
const PROFILE_HERO_LAYOUTS = Object.freeze(['portrait', 'cover', 'split']);

// Legacy V1 aliases remain accepted on read so no saved profile is reset.
const PROFILE_ACCENTS = Object.freeze(['gold', 'crimson', 'azure', 'violet', 'emerald']);
const PROFILE_HERO_STYLES = Object.freeze(['portrait', 'cover']);

const PROFILE_HERO_FACT_KEYS = Object.freeze(['magic', 'kingdom', 'race', 'grimoire', 'socialClass', 'family', 'rank']);
const PROFILE_SECTION_KEYS = Object.freeze(['identity', 'links', 'traits', 'history', 'effects']);
const PROFILE_FEATURED_KINDS = Object.freeze(['auto', 'trait', 'history', 'none']);
const PROFILE_SECTION_STYLES = Object.freeze(['cards', 'minimal']);

const DEFAULT_PROFILE_PRESENTATION_PREFERENCES = Object.freeze({
    skin: 'arcane',
    palette: 'gold',
    heroLayout: 'portrait',
    heroFacts: Object.freeze(['magic', 'kingdom', 'race', 'grimoire']),
    motto: '',
    featured: 'auto',
    featuredId: null,
    sectionOrder: PROFILE_SECTION_KEYS,
    hiddenSections: Object.freeze([]),
    sectionStyle: 'cards',
    showSectionIcons: true,
    showActiveTitle: true,
});

class ProfilePresentationServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ProfilePresentationServiceError';
        this.code = code;
        this.details = details;
    }
}

function cloneDefaults() {
    return {
        ...DEFAULT_PROFILE_PRESENTATION_PREFERENCES,
        heroFacts: [...DEFAULT_PROFILE_PRESENTATION_PREFERENCES.heroFacts],
        sectionOrder: [...DEFAULT_PROFILE_PRESENTATION_PREFERENCES.sectionOrder],
        hiddenSections: [],
    };
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function allowedString(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function uniqueKnown(value, allowed, fallback = []) {
    if (!Array.isArray(value)) return [...fallback];
    const allowedSet = new Set(allowed);
    return [...new Set(value.filter((entry) => typeof entry === 'string' && allowedSet.has(entry)))];
}

function normalizeSectionOrder(value) {
    const selected = uniqueKnown(value, PROFILE_SECTION_KEYS);
    return [...selected, ...PROFILE_SECTION_KEYS.filter((key) => !selected.includes(key))];
}

function normalizeProfilePresentationPreferences(value) {
    const source = object(value);
    const legacyPalette = allowedString(
        source.accent,
        PROFILE_ACCENTS,
        DEFAULT_PROFILE_PRESENTATION_PREFERENCES.palette
    );
    const legacyHeroLayout = allowedString(
        source.heroStyle,
        PROFILE_HERO_STYLES,
        DEFAULT_PROFILE_PRESENTATION_PREFERENCES.heroLayout
    );

    return {
        skin: allowedString(source.skin, PROFILE_SKINS, DEFAULT_PROFILE_PRESENTATION_PREFERENCES.skin),
        palette: allowedString(source.palette, PROFILE_PALETTES, legacyPalette),
        heroLayout: allowedString(source.heroLayout, PROFILE_HERO_LAYOUTS, legacyHeroLayout),
        heroFacts: uniqueKnown(
            source.heroFacts,
            PROFILE_HERO_FACT_KEYS,
            DEFAULT_PROFILE_PRESENTATION_PREFERENCES.heroFacts
        ),
        motto: typeof source.motto === 'string' ? source.motto.trim().slice(0, 120) : '',
        featured: allowedString(
            source.featured,
            PROFILE_FEATURED_KINDS,
            DEFAULT_PROFILE_PRESENTATION_PREFERENCES.featured
        ),
        featuredId: typeof source.featuredId === 'string' && source.featuredId.trim()
            ? source.featuredId.trim().slice(0, 240)
            : null,
        sectionOrder: normalizeSectionOrder(source.sectionOrder),
        hiddenSections: uniqueKnown(source.hiddenSections, PROFILE_SECTION_KEYS),
        sectionStyle: allowedString(
            source.sectionStyle,
            PROFILE_SECTION_STYLES,
            DEFAULT_PROFILE_PRESENTATION_PREFERENCES.sectionStyle
        ),
        showSectionIcons: typeof source.showSectionIcons === 'boolean'
            ? source.showSectionIcons
            : DEFAULT_PROFILE_PRESENTATION_PREFERENCES.showSectionIcons,
        showActiveTitle: typeof source.showActiveTitle === 'boolean'
            ? source.showActiveTitle
            : DEFAULT_PROFILE_PRESENTATION_PREFERENCES.showActiveTitle,
    };
}

function parseStoredPreferences(value) {
    if (typeof value !== 'string' || !value.trim()) return cloneDefaults();
    try {
        return normalizeProfilePresentationPreferences(JSON.parse(value));
    } catch {
        return cloneDefaults();
    }
}

async function getProfilePresentation(db, playerId) {
    if (!db?.get) throw new TypeError('Banco inválido.');
    const row = await db.get(
        `SELECT schema_version, preferences_json, updated_at
         FROM clover_profile_presentations
         WHERE player_id = ?`,
        [playerId]
    );
    if (!row) {
        return {
            schemaVersion: PROFILE_PRESENTATION_SCHEMA_VERSION,
            preferences: cloneDefaults(),
            updatedAt: null,
        };
    }
    return {
        schemaVersion: PROFILE_PRESENTATION_SCHEMA_VERSION,
        preferences: parseStoredPreferences(row.preferences_json),
        updatedAt: row.updated_at || null,
    };
}

async function saveProfilePresentation(db, playerId, value) {
    if (!db?.get || !db?.run) throw new TypeError('Banco inválido.');
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        throw new ProfilePresentationServiceError('player_not_found', 'Jogador não encontrado.');
    }

    const preferences = normalizeProfilePresentationPreferences(value);
    const encoded = JSON.stringify(preferences);
    await db.run(
        `INSERT INTO clover_profile_presentations
            (player_id, schema_version, preferences_json, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            preferences_json = excluded.preferences_json,
            updated_at = CURRENT_TIMESTAMP`,
        [playerId, PROFILE_PRESENTATION_SCHEMA_VERSION, encoded]
    );
    return getProfilePresentation(db, playerId);
}

module.exports = {
    DEFAULT_PROFILE_PRESENTATION_PREFERENCES,
    PROFILE_ACCENTS,
    PROFILE_FEATURED_KINDS,
    PROFILE_HERO_FACT_KEYS,
    PROFILE_HERO_LAYOUTS,
    PROFILE_HERO_STYLES,
    PROFILE_PALETTES,
    PROFILE_PRESENTATION_SCHEMA_VERSION,
    PROFILE_SECTION_KEYS,
    PROFILE_SECTION_STYLES,
    PROFILE_SKINS,
    ProfilePresentationServiceError,
    getProfilePresentation,
    normalizeProfilePresentationPreferences,
    saveProfilePresentation,
};
