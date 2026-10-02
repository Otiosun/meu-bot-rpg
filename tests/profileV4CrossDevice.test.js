'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-v4-cross-device-media-'));
process.env.CLOVER_PROFILE_MEDIA_DIR = mediaRoot;

const sharp = require('sharp');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
  PROFILE_MEDIA_MIGRATION,
  PROFILE_PRESENTATION_MIGRATION,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
  getProfilePresentation,
  saveProfilePresentation,
} = require('../helpers/clover/profilePresentationService');
const {
  getProfileMediaState,
  readProfileMedia,
  saveProfileMedia,
  updateProfileMediaTransform,
} = require('../helpers/clover/profileMediaService');

async function openPair(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-v4-cross-device-db-'));
  const filename = path.join(dir, 'database.sqlite');
  const deviceA = await openCloverDatabase({ filename });
  const deviceB = await openCloverDatabase({ filename });

  t.after(async () => {
    await deviceA.close();
    await deviceB.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  await deviceA.exec(`
    CREATE TABLE jogadores (
      id TEXT PRIMARY KEY,
      nome TEXT,
      site_profile_image_data TEXT DEFAULT NULL,
      site_profile_image_updated_at TEXT DEFAULT NULL
    )
  `);
  await PROFILE_PRESENTATION_MIGRATION.up(deviceA);
  await PROFILE_MEDIA_MIGRATION.up(deviceA);
  await deviceA.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', ['player-1', 'Teste']);

  return { deviceA, deviceB };
}

async function imageDataUrl(width, height, color) {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

test('dispositivo A salva apresentação V2 e dispositivo B lê exatamente a mesma preferência', async (t) => {
  const { deviceA, deviceB } = await openPair(t);

  await saveProfilePresentation(deviceA, 'player-1', {
    skin: 'oneiric',
    palette: 'teal',
    heroLayout: 'split',
    heroFacts: ['magic', 'rank', 'family'],
    motto: 'Entre um mapa e outro, existe uma estrela.',
    featured: 'history',
    featuredId: 'history:gancho:estrela',
    sectionOrder: ['history', 'traits', 'identity', 'links', 'effects'],
    hiddenSections: ['effects'],
    sectionStyle: 'minimal',
    showSectionIcons: false,
    showActiveTitle: true,
  });

  const remote = await getProfilePresentation(deviceB, 'player-1');

  assert.equal(remote.schemaVersion, 'profile-presentation.v2');
  assert.equal(remote.preferences.skin, 'oneiric');
  assert.equal(remote.preferences.palette, 'teal');
  assert.equal(remote.preferences.heroLayout, 'split');
  assert.equal(remote.preferences.motto, 'Entre um mapa e outro, existe uma estrela.');
  assert.deepEqual(remote.preferences.heroFacts, ['magic', 'rank', 'family']);
  assert.deepEqual(remote.preferences.sectionOrder, ['history', 'traits', 'identity', 'links', 'effects']);
  assert.deepEqual(remote.preferences.hiddenSections, ['effects']);
  assert.equal(remote.preferences.sectionStyle, 'minimal');
  assert.equal(remote.preferences.showSectionIcons, false);
  assert.equal(remote.preferences.showActiveTitle, true);
});

test('dispositivo B altera e dispositivo A recebe a versão nova sem duplicar linha', async (t) => {
  const { deviceA, deviceB } = await openPair(t);

  await saveProfilePresentation(deviceA, 'player-1', {
    skin: 'arcane',
    palette: 'gold',
    heroLayout: 'portrait',
  });
  await saveProfilePresentation(deviceB, 'player-1', {
    skin: 'dossier',
    palette: 'silver',
    heroLayout: 'cover',
    motto: 'Segunda tela.',
  });

  const backOnA = await getProfilePresentation(deviceA, 'player-1');
  assert.equal(backOnA.preferences.skin, 'dossier');
  assert.equal(backOnA.preferences.palette, 'silver');
  assert.equal(backOnA.preferences.heroLayout, 'cover');
  assert.equal(backOnA.preferences.motto, 'Segunda tela.');

  const row = await deviceA.get(
    'SELECT COUNT(*) AS count FROM clover_profile_presentations WHERE player_id = ?',
    ['player-1'],
  );
  assert.equal(Number(row.count), 1);
});

test('banner e crop atravessam conexões separadas com o mesmo hash de conteúdo', async (t) => {
  const { deviceA, deviceB } = await openPair(t);
  const image = await imageDataUrl(1600, 700, { r: 38, g: 84, b: 122, alpha: 1 });

  const saved = await saveProfileMedia(deviceA, 'player-1', 'banner', image, {
    focalX: 0.18,
    focalY: 0.76,
    zoom: 1.4,
  });
  assert.equal(saved.removed, false);
  assert.ok(saved.media);

  const onB = await getProfileMediaState(deviceB, 'player-1');
  assert.equal(onB.banner?.sha256, saved.media.sha256);
  assert.equal(onB.banner?.focalX, 0.18);
  assert.equal(onB.banner?.focalY, 0.76);
  assert.equal(onB.banner?.zoom, 1.4);

  const changed = await updateProfileMediaTransform(deviceB, 'player-1', 'banner', {
    focalX: 0.82,
    focalY: 0.24,
    zoom: 2.1,
  });
  assert.equal(changed.sha256, saved.media.sha256);

  const backOnA = await getProfileMediaState(deviceA, 'player-1');
  assert.equal(backOnA.banner?.sha256, saved.media.sha256);
  assert.equal(backOnA.banner?.focalX, 0.82);
  assert.equal(backOnA.banner?.focalY, 0.24);
  assert.equal(backOnA.banner?.zoom, 2.1);

  const binary = await readProfileMedia(deviceA, 'player-1', 'banner');
  assert.equal(binary.etag, `"${saved.media.sha256}"`);
  assert.equal(binary.buffer.length, backOnA.banner?.bytes);
});

test('avatar V2 continua alimentando o fallback legado em outro dispositivo', async (t) => {
  const { deviceA, deviceB } = await openPair(t);
  const image = await imageDataUrl(800, 1100, { r: 93, g: 52, b: 122, alpha: 1 });

  const saved = await saveProfileMedia(deviceA, 'player-1', 'avatar', image, {
    focalX: 0.5,
    focalY: 0.32,
    zoom: 1.15,
  });
  assert.ok(saved.media);

  const stateB = await getProfileMediaState(deviceB, 'player-1');
  assert.equal(stateB.avatar?.sha256, saved.media.sha256);

  const playerB = await deviceB.get(
    'SELECT site_profile_image_data FROM jogadores WHERE id = ?',
    ['player-1'],
  );
  assert.match(String(playerB.site_profile_image_data || ''), /^data:image\/webp;base64,/);
});
