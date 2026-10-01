'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    PROFILE_PRESENTATION_MIGRATION,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    PROFILE_PRESENTATION_SCHEMA_VERSION,
    ProfilePresentationServiceError,
    getProfilePresentation,
    normalizeProfilePresentationPreferences,
    saveProfilePresentation,
} = require('../helpers/clover/profilePresentationService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-presentation-'));
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

test('normalização mantém somente preferências visuais conhecidas e completa ordem das seções', () => {
    const result = normalizeProfilePresentationPreferences({
        accent: 'violet',
        heroStyle: 'cover',
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

    assert.equal(result.accent, 'violet');
    assert.equal(result.heroStyle, 'cover');
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

test('valores inválidos retornam defaults seguros do Perfil', () => {
    const result = normalizeProfilePresentationPreferences({
        accent: 'neon',
        heroStyle: 'fullscreen',
        featured: 'spell',
        sectionStyle: 'glass',
        showSectionIcons: 'yes',
        showActiveTitle: 1,
    });

    assert.equal(result.accent, 'gold');
    assert.equal(result.heroStyle, 'portrait');
    assert.deepEqual(result.heroFacts, ['magic', 'kingdom', 'race', 'grimoire']);
    assert.equal(result.featured, 'auto');
    assert.deepEqual(result.sectionOrder, ['identity', 'links', 'traits', 'history', 'effects']);
    assert.equal(result.sectionStyle, 'cards');
    assert.equal(result.showSectionIcons, true);
    assert.equal(result.showActiveTitle, true);
});

test('leitura sem registro devolve apresentação padrão sem inventar timestamp', async (t) => {
    const db = await fixture(t);
    const result = await getProfilePresentation(db, 'player-1');

    assert.equal(result.schemaVersion, PROFILE_PRESENTATION_SCHEMA_VERSION);
    assert.equal(result.updatedAt, null);
    assert.equal(result.preferences.accent, 'gold');
    assert.deepEqual(result.preferences.sectionOrder, ['identity', 'links', 'traits', 'history', 'effects']);
});

test('save + read persiste uma única preferência compartilhada por jogador', async (t) => {
    const db = await fixture(t);

    const first = await saveProfilePresentation(db, 'player-1', {
        accent: 'crimson',
        heroStyle: 'cover',
        motto: 'Primeira versão',
        sectionOrder: ['traits', 'identity'],
        hiddenSections: ['effects'],
    });
    assert.equal(first.preferences.accent, 'crimson');
    assert.equal(first.preferences.heroStyle, 'cover');
    assert.equal(first.preferences.motto, 'Primeira versão');
    assert.ok(first.updatedAt);

    await saveProfilePresentation(db, 'player-1', {
        accent: 'emerald',
        heroStyle: 'portrait',
        motto: 'Segunda versão',
    });

    const rows = await db.all('SELECT * FROM clover_profile_presentations WHERE player_id = ?', ['player-1']);
    assert.equal(rows.length, 1);

    const remoteRead = await getProfilePresentation(db, 'player-1');
    assert.equal(remoteRead.preferences.accent, 'emerald');
    assert.equal(remoteRead.preferences.heroStyle, 'portrait');
    assert.equal(remoteRead.preferences.motto, 'Segunda versão');
    assert.equal(remoteRead.schemaVersion, PROFILE_PRESENTATION_SCHEMA_VERSION);
});

test('save falha fechado para jogador inexistente e não cria órfão', async (t) => {
    const db = await fixture(t);

    await assert.rejects(
        saveProfilePresentation(db, 'ghost', { accent: 'azure' }),
        (error) => error instanceof ProfilePresentationServiceError && error.code === 'player_not_found',
    );
    assert.equal(
        (await db.get('SELECT COUNT(*) AS n FROM clover_profile_presentations WHERE player_id = ?', ['ghost'])).n,
        0,
    );
});
