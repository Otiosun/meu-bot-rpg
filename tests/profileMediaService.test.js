'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const sharp = require('sharp');

const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-media-files-'));
process.env.CLOVER_PROFILE_MEDIA_DIR = mediaRoot;

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { PROFILE_MEDIA_MIGRATION } = require('../helpers/clover/schemaMigrationCatalog');
const {
    PROFILE_MEDIA_LIMITS,
    ProfileMediaServiceError,
    getProfileMediaState,
    optimizeProfileMedia,
    readProfileMedia,
    saveProfileMedia,
    updateProfileMediaTransform,
} = require('../helpers/clover/profileMediaService');

after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-media-db-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            site_profile_image_data TEXT DEFAULT NULL,
            site_profile_image_updated_at TEXT DEFAULT NULL
        )
    `);
    await PROFILE_MEDIA_MIGRATION.up(db);
    await db.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', ['p1', 'Teste']);
    return db;
}

async function png(width = 1200, height = 800) {
    return sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 30, g: 70, b: 120, alpha: 1 },
        },
    }).png().toBuffer();
}

function dataUrl(buffer, kind = 'png') {
    return `data:image/${kind};base64,${buffer.toString('base64')}`;
}

test('otimizador produz WEBP limitado para avatar e banner', async () => {
    const source = await png(1800, 1200);
    const avatar = await optimizeProfileMedia('avatar', source);
    const banner = await optimizeProfileMedia('banner', source);

    assert.equal(avatar.mimeType, 'image/webp');
    assert.equal(banner.mimeType, 'image/webp');
    assert.equal(avatar.bytes <= PROFILE_MEDIA_LIMITS.avatar.outputBytes, true);
    assert.equal(banner.bytes <= PROFILE_MEDIA_LIMITS.banner.outputBytes, true);
    assert.equal(avatar.width <= PROFILE_MEDIA_LIMITS.avatar.maxWidth, true);
    assert.equal(avatar.height <= PROFILE_MEDIA_LIMITS.avatar.maxHeight, true);
    assert.equal(banner.width <= PROFILE_MEDIA_LIMITS.banner.maxWidth, true);
    assert.equal(banner.height <= PROFILE_MEDIA_LIMITS.banner.maxHeight, true);
});

test('banner salva arquivo, metadados e crop sem gravar imagem em jogadores', async (t) => {
    const db = await fixture(t);
    const source = await png(1600, 700);

    const saved = await saveProfileMedia(db, 'p1', 'banner', dataUrl(source), {
        focalX: 0.2,
        focalY: 0.8,
        zoom: 1.35,
    });

    assert.equal(saved.removed, false);
    assert.equal(saved.media.kind, 'banner');
    assert.equal(saved.media.focalX, 0.2);
    assert.equal(saved.media.focalY, 0.8);
    assert.equal(saved.media.zoom, 1.35);
    assert.equal(saved.media.bytes <= PROFILE_MEDIA_LIMITS.banner.outputBytes, true);
    assert.match(saved.media.sha256, /^[a-f0-9]{64}$/);

    const state = await getProfileMediaState(db, 'p1');
    assert.equal(state.banner.sha256, saved.media.sha256);
    assert.equal(state.avatar, null);

    const player = await db.get('SELECT site_profile_image_data FROM jogadores WHERE id = ?', ['p1']);
    assert.equal(player.site_profile_image_data, null);

    const read = await readProfileMedia(db, 'p1', 'banner');
    assert.equal(read.buffer.length, saved.media.bytes);
    assert.equal(read.mimeType, 'image/webp');
    assert.equal(read.etag, `"${saved.media.sha256}"`);
});

test('crop é limitado a X/Y 0..1 e zoom 1..3 sem regravar o arquivo', async (t) => {
    const db = await fixture(t);
    const source = await png(1000, 600);
    const saved = await saveProfileMedia(db, 'p1', 'banner', dataUrl(source), {});
    const before = await readProfileMedia(db, 'p1', 'banner');

    const changed = await updateProfileMediaTransform(db, 'p1', 'banner', {
        focalX: -2,
        focalY: 4,
        zoom: 9,
    });
    const after = await readProfileMedia(db, 'p1', 'banner');

    assert.equal(changed.focalX, 0);
    assert.equal(changed.focalY, 1);
    assert.equal(changed.zoom, 3);
    assert.equal(after.media.sha256, saved.media.sha256);
    assert.deepEqual(after.buffer, before.buffer);
});

test('avatar V2 mantém compatibilidade com site_profile_image_data atual', async (t) => {
    const db = await fixture(t);
    const source = await png(900, 1200);

    const saved = await saveProfileMedia(db, 'p1', 'avatar', dataUrl(source), {
        focalX: 0.5,
        focalY: 0.35,
        zoom: 1.1,
    });
    const player = await db.get(
        'SELECT site_profile_image_data, site_profile_image_updated_at FROM jogadores WHERE id = ?',
        ['p1']
    );

    assert.equal(saved.media.kind, 'avatar');
    assert.match(player.site_profile_image_data, /^data:image\/webp;base64,/);
    assert.ok(player.site_profile_image_updated_at);

    const removed = await saveProfileMedia(db, 'p1', 'avatar', null);
    assert.equal(removed.removed, true);
    const after = await db.get('SELECT site_profile_image_data FROM jogadores WHERE id = ?', ['p1']);
    assert.equal(after.site_profile_image_data, null);
    assert.equal((await getProfileMediaState(db, 'p1')).avatar, null);
});

test('mídia inválida falha fechado e jogador inexistente não cria arquivo órfão', async (t) => {
    const db = await fixture(t);

    await assert.rejects(
        saveProfileMedia(db, 'p1', 'wallpaper', dataUrl(await png())),
        (error) => error instanceof ProfileMediaServiceError && error.code === 'invalid_profile_media_kind',
    );
    await assert.rejects(
        saveProfileMedia(db, 'ghost', 'banner', dataUrl(await png())),
        (error) => error instanceof ProfileMediaServiceError && error.code === 'player_not_found',
    );
    await assert.rejects(
        saveProfileMedia(db, 'p1', 'banner', 'data:text/plain;base64,SGVsbG8='),
        (error) => error instanceof ProfileMediaServiceError && error.code === 'invalid_profile_media',
    );
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_profile_media')).n, 0);
});
