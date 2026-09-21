'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ProfilePresentationPreferencesError,
    defaultProfilePresentationPreferences,
    getProfilePresentationPreferences,
    normalizeProfilePresentationPreferences,
    parseStoredPreferences,
    saveProfilePresentationPreferences,
} = require('../helpers/clover/profilePresentationPreferencesService');

test('normaliza preferências visuais sem permitir alterar dados mecânicos', () => {
    const value = normalizeProfilePresentationPreferences({
        accent: 'violet',
        heroStyle: 'cover',
        heroFacts: ['magic', 'rank', 'magic', 'unknown'],
        motto: '  Pela alvorada.  ',
        featured: 'history',
        featuredId: 'history:origem:juramento',
        sectionOrder: ['history', 'identity'],
        hiddenSections: ['effects', 'effects', 'invalid'],
        race: 'elfo',
        magic: 'anti-magia',
    });

    assert.deepEqual(value, {
        accent: 'violet',
        heroStyle: 'cover',
        heroFacts: ['magic', 'rank'],
        motto: 'Pela alvorada.',
        featured: 'history',
        featuredId: 'history:origem:juramento',
        sectionOrder: ['history', 'identity', 'links', 'traits', 'effects'],
        hiddenSections: ['effects'],
    });
    assert.equal('race' in value, false);
    assert.equal('magic' in value, false);
});

test('limita frase e identificador de destaque', () => {
    assert.throws(
        () => normalizeProfilePresentationPreferences({ motto: 'x'.repeat(121) }),
        (error) => error instanceof ProfilePresentationPreferencesError && error.code === 'motto_too_long'
    );
    assert.throws(
        () => normalizeProfilePresentationPreferences({ featuredId: 'x'.repeat(241) }),
        (error) => error instanceof ProfilePresentationPreferencesError && error.code === 'featured_id_too_long'
    );
});

test('leitura inválida cai em padrão seguro e escrita persiste JSON normalizado', async () => {
    const state = {
        site_profile_presentation_json: '{quebrado',
        site_profile_presentation_updated_at: null,
    };
    const db = {
        get: async (sql, params) => {
            assert.equal(params[0], 'p1');
            if (/site_profile_presentation_json/.test(sql)) return { ...state };
            return { site_profile_presentation_updated_at: state.site_profile_presentation_updated_at };
        },
        run: async (sql, params) => {
            assert.match(sql, /site_profile_presentation_json/);
            state.site_profile_presentation_json = params[0];
            state.site_profile_presentation_updated_at = '2026-09-21 02:30:00';
            return { changes: params[1] === 'p1' ? 1 : 0 };
        },
    };

    const initial = await getProfilePresentationPreferences(db, 'p1');
    assert.deepEqual(initial.preferences, defaultProfilePresentationPreferences());

    const saved = await saveProfilePresentationPreferences(db, 'p1', {
        accent: 'emerald',
        heroStyle: 'cover',
        heroFacts: ['race', 'magic'],
        motto: 'Sempre adiante.',
        featured: 'none',
        featuredId: null,
        sectionOrder: ['traits', 'identity', 'links', 'history', 'effects'],
        hiddenSections: ['history'],
    });

    assert.equal(saved.preferences.accent, 'emerald');
    assert.equal(saved.updatedAt, '2026-09-21 02:30:00');
    assert.deepEqual(parseStoredPreferences(state.site_profile_presentation_json), saved.preferences);
});
