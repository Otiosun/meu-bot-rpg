'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    MAX_PROFILE_IMAGE_BYTES,
    ProfileImageServiceError,
    normalizeProfileImageData,
    saveProfileImage,
} = require('../helpers/clover/profileImageService');

function dataUrl(kind, bytes) {
    return `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
}

test('aceita PNG, JPEG e WEBP reais e rejeita conteúdo disfarçado', () => {
    const png = dataUrl('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = dataUrl('jpeg', [0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]);
    const webp = dataUrl('webp', Buffer.from('RIFF0000WEBP', 'ascii'));

    assert.equal(normalizeProfileImageData(png), png);
    assert.equal(normalizeProfileImageData(jpeg), jpeg);
    assert.equal(normalizeProfileImageData(webp), webp);
    assert.throws(
        () => normalizeProfileImageData(dataUrl('png', Buffer.from('nao-e-png'))),
        (error) => error instanceof ProfileImageServiceError && error.code === 'invalid_profile_image'
    );
});

test('limita o peso compartilhado da foto e permite remoção', () => {
    const oversized = Buffer.alloc(MAX_PROFILE_IMAGE_BYTES + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.throws(
        () => normalizeProfileImageData(dataUrl('png', oversized)),
        (error) => error instanceof ProfileImageServiceError && error.code === 'profile_image_too_large'
    );
    assert.equal(normalizeProfileImageData(null), null);
    assert.equal(normalizeProfileImageData(''), null);
});

test('salva e remove a foto sem alterar a aparência aprovada', async () => {
    const png = dataUrl('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const state = {
        site_profile_image_data: null,
        site_profile_image_updated_at: null,
        personagem_aparencia_status: 'approved',
    };
    const db = {
        run: async (sql, params) => {
            assert.match(sql, /site_profile_image_data/);
            state.site_profile_image_data = params[0];
            state.site_profile_image_updated_at = '2026-07-18 12:00:00';
            return { changes: params[1] === 'p1' ? 1 : 0 };
        },
        get: async () => ({ ...state }),
    };

    const saved = await saveProfileImage(db, 'p1', png);
    assert.equal(saved.image, png);
    assert.equal(state.personagem_aparencia_status, 'approved');

    const removed = await saveProfileImage(db, 'p1', null);
    assert.equal(removed.image, null);
    assert.equal(state.personagem_aparencia_status, 'approved');
});
