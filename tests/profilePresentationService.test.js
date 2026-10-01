'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { PROFILE_PRESENTATION_MIGRATION } = require('../helpers/clover/schemaMigrationCatalog');
const {
    PROFILE_HERO_LAYOUTS,
    PROFILE_PALETTES,
    PROFILE_PRESENTATION_SCHEMA_VERSION,
    PROFILE_SKINS,
    ProfilePresentationServiceError,
    getProfilePresentation,
    normalizeProfilePresentationPreferences,
    saveProfilePresentation,
} = require('../helpers/clover/profilePresentationService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-presentation-v2-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await db.exec('CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT)');
    await PROFILE_PRESENTATION_MIGRATION.up(db);
    await db.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', ['player-1', 'Teste']);
    return db;
}

test('V2 expõe exatamente 6 skins, 8 paletas e 3 layouts de hero', () => {
    assert.equal(PROFILE_PRESENTATION_SCHEMA_VERSION, 'profile-presentation.v2');
    assert.deepEqual(PROFILE_SKINS, ['arcane', 'grimoire', 'royal', 'stained', 'dossier', 'oneiric']);
    assert.deepEqual(PROFILE_PALETTES, ['gold', 'crimson', 'azure', 'violet', 'emerald', 'silver', 'amber', 'teal']);
    assert.deepEqual(PROFILE_HERO_LAYOUTS, ['portrait', 'cover', 'split']);
    assert.equal(PROFILE_SKINS.length * PROFILE_PALETTES.length * PROFILE_HERO_LAYOUTS.length * 2, 288);
});

test('normalização V2 mantém apenas preferências visuais conhecidas', () => {
    const result = normalizeProfilePresentationPreferences({
        skin: 'stained',
        palette: 'teal',
        heroLayout: 'split',
        heroFacts: ['rank', 'magic', 'rank', 'unknown'],
        motto: `  ${'x'.repeat(130)}  `,
        featured: 'history',
        featuredId: `  ${'hook:'.padEnd(260, 'y')}  `,
        sectionOrder: ['history', 'identity', 'history'],
        hiddenSections: ['effects', 'effects', 'unknown'],
        sectionStyle: 'minimal',
        showSectionIcons: false,
        showActiveTitle: false,
        injectedMechanicalState: { mana: 999999 },
    });

    assert.equal(result.skin, 'stained');
    assert.equal(result.palette, 'teal');
    assert.equal(result.heroLayout, 'split');
    assert.deepEqual(result.heroFacts, ['rank', 'magic']);
    assert.equal(result.motto.length, 120);
    assert.equal(result.featured, 'history');
    assert.equal(result.featuredId.length, 240);
    assert.deepEqual(result.sectionOrder, ['history', 'identity', 'links', 'traits', 'effects']);
    assert.deepEqual(result.hiddenSections, ['effects']);
    assert.equal(result.sectionStyle, 'minimal');
    assert.equal(result.showSectionIcons, false);
    assert.equal(result.showActiveTitle, false);
    assert.equal(Object.hasOwn(result, 'injectedMechanicalState'), false);
});

test('preferência V1 migra accent e heroStyle sem reset visual', () => {
    const result = normalizeProfilePresentationPreferences({
        accent: 'violet',
        heroStyle: 'cover',
        motto: 'Legado',
    });

    assert.equal(result.skin, 'arcane');
    assert.equal(result.palette, 'violet');
    assert.equal(result.heroLayout, 'cover');
    assert.equal(result.motto, 'Legado');
    assert.equal(Object.hasOwn(result, 'accent'), false);
    assert.equal(Object.hasOwn(result, 'heroStyle'), false);
});

test('valores inválidos retornam defaults seguros do Perfil V2', () => {
    const result = normalizeProfilePresentationPreferences({
        skin: 'hack',
        palette: 'neon',
        heroLayout: 'fullscreen',
        featured: 'spell',
        sectionStyle: 'glass',
        showSectionIcons: 'yes',
        showActiveTitle: 1,
    });

    assert.equal(result.skin, 'arcane');
    assert.equal(result.palette, 'gold');
    assert.equal(result.heroLayout, 'portrait');
    assert.deepEqual(result.heroFacts, ['magic', 'kingdom', 'race', 'grimoire']);
    assert.equal(result.featured, 'auto');
    assert.deepEqual(result.sectionOrder, ['identity', 'links', 'traits', 'history', 'effects']);
    assert.equal(result.sectionStyle, 'cards');
    assert.equal(result.showSectionIcons, true);
    assert.equal(result.showActiveTitle, true);
});

test('leitura de linha antiga V1 devolve contrato V2 normalizado sem regravar', async (t) => {
    const db = await fixture(t);
    await db.run(
        `INSERT INTO clover_profile_presentations
         (player_id, schema_version, preferences_json)
         VALUES (?, ?, ?)`,
        ['player-1', 'profile-presentation.v1', JSON.stringify({
            accent: 'crimson',
            heroStyle: 'cover',
            motto: 'Persistido na V1',
        })],
    );

    const result = await getProfilePresentation(db, 'player-1');
    assert.equal(result.schemaVersion, 'profile-presentation.v2');
    assert.equal(result.preferences.skin, 'arcane');
    assert.equal(result.preferences.palette, 'crimson');
    assert.equal(result.preferences.heroLayout, 'cover');
    assert.equal(result.preferences.motto, 'Persistido na V1');

    const raw = await db.get(
        'SELECT schema_version FROM clover_profile_presentations WHERE player_id = ?',
        ['player-1'],
    );
    assert.equal(raw.schema_version, 'profile-presentation.v1');
});

test('save + read persiste uma única preferência V2 compartilhada por jogador', async (t) => {
    const db = await fixture(t);

    const first = await saveProfilePresentation(db, 'player-1', {
        skin: 'grimoire',
        palette: 'amber',
        heroLayout: 'split',
        motto: 'Primeira versão',
        sectionOrder: ['traits', 'identity'],
        hiddenSections: ['effects'],
    });
    assert.equal(first.preferences.skin, 'grimoire');
    assert.equal(first.preferences.palette, 'amber');
    assert.equal(first.preferences.heroLayout, 'split');
    assert.equal(first.preferences.motto, 'Primeira versão');
    assert.ok(first.updatedAt);

    await saveProfilePresentation(db, 'player-1', {
        skin: 'dossier',
        palette: 'silver',
        heroLayout: 'portrait',
        motto: 'Segunda versão',
    });

    const rows = await db.all('SELECT * FROM clover_profile_presentations WHERE player_id = ?', ['player-1']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].schema_version, 'profile-presentation.v2');

    const remoteRead = await getProfilePresentation(db, 'player-1');
    assert.equal(remoteRead.preferences.skin, 'dossier');
    assert.equal(remoteRead.preferences.palette, 'silver');
    assert.equal(remoteRead.preferences.heroLayout, 'portrait');
    assert.equal(remoteRead.preferences.motto, 'Segunda versão');
});

test('save falha fechado para jogador inexistente e não cria órfão', async (t) => {
    const db = await fixture(t);

    await assert.rejects(
        saveProfilePresentation(db, 'ghost', { palette: 'azure' }),
        (error) => error instanceof ProfilePresentationServiceError && error.code === 'player_not_found',
    );
    assert.equal(
        (await db.get('SELECT COUNT(*) AS n FROM clover_profile_presentations WHERE player_id = ?', ['ghost'])).n,
        0,
    );
});
