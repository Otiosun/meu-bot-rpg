'use strict';
const {assertLifecycleAllowed}=require('./lifecyclePolicy');

const MAX_PROFILE_IMAGE_BYTES = 180 * 1024;
const DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

class ProfileImageServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ProfileImageServiceError';
        this.code = code;
        this.details = details;
    }
}

function hasExpectedSignature(kind, buffer) {
    if (kind === 'png') {
        return buffer.length >= 8
            && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (kind === 'jpeg') {
        return buffer.length >= 4
            && buffer[0] === 0xff && buffer[1] === 0xd8
            && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
    }
    if (kind === 'webp') {
        return buffer.length >= 12
            && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
            && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    }
    return false;
}

function normalizeProfileImageData(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const source = String(value).trim();
    const match = source.match(DATA_URL_PATTERN);
    if (!match) {
        throw new ProfileImageServiceError(
            'invalid_profile_image',
            'Envie uma imagem PNG, JPG ou WEBP já otimizada.'
        );
    }
    const kind = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || !hasExpectedSignature(kind, buffer)) {
        throw new ProfileImageServiceError('invalid_profile_image', 'O conteúdo não corresponde ao formato informado.');
    }
    if (buffer.length > MAX_PROFILE_IMAGE_BYTES) {
        throw new ProfileImageServiceError(
            'profile_image_too_large',
            'A imagem otimizada ultrapassa 180 KB.',
            { maximumBytes: MAX_PROFILE_IMAGE_BYTES, receivedBytes: buffer.length }
        );
    }
    return `data:image/${kind};base64,${buffer.toString('base64')}`;
}

async function saveProfileImage(db, playerId, value) {
    assertLifecycleAllowed({surface:'internal',operation:'profile_image.save',mutationClass:'CURRENT_WORLD'});
    const image = normalizeProfileImageData(value);
    const result = await db.run(
        `UPDATE jogadores
         SET site_profile_image_data = ?, site_profile_image_updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [image, playerId]
    );
    if (!Number(result?.changes || 0)) {
        throw new ProfileImageServiceError('player_not_found', 'Jogador não encontrado.');
    }
    const player = await db.get(
        `SELECT site_profile_image_data, site_profile_image_updated_at
         FROM jogadores WHERE id = ?`,
        [playerId]
    );
    return {
        ok: true,
        image: player?.site_profile_image_data || null,
        updatedAt: player?.site_profile_image_updated_at || null,
    };
}

module.exports = {
    MAX_PROFILE_IMAGE_BYTES,
    ProfileImageServiceError,
    normalizeProfileImageData,
    saveProfileImage,
};
