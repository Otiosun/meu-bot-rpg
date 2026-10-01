'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const PROFILE_MEDIA_KINDS = Object.freeze(['avatar', 'banner']);
const PROFILE_MEDIA_SCHEMA_VERSION = 'profile-media.v1';
const PROFILE_MEDIA_DIR = process.env.CLOVER_PROFILE_MEDIA_DIR
    ? path.resolve(process.env.CLOVER_PROFILE_MEDIA_DIR)
    : path.join(process.cwd(), 'assets', 'profile-media');

const PROFILE_MEDIA_LIMITS = Object.freeze({
    avatar: Object.freeze({
        inputBytes: 512 * 1024,
        outputBytes: 168 * 1024,
        maxWidth: 720,
        maxHeight: 960,
    }),
    banner: Object.freeze({
        inputBytes: 1024 * 1024,
        outputBytes: 280 * 1024,
        maxWidth: 1600,
        maxHeight: 900,
    }),
});

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

class ProfileMediaServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ProfileMediaServiceError';
        this.code = code;
        this.details = details;
    }
}

function normalizeKind(value) {
    const kind = String(value || '').trim().toLowerCase();
    if (!PROFILE_MEDIA_KINDS.includes(kind)) {
        throw new ProfileMediaServiceError('invalid_profile_media_kind', 'Tipo de mídia do perfil inválido.', {
            allowed: PROFILE_MEDIA_KINDS,
        });
    }
    return kind;
}

function finiteInRange(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeTransform(value = {}, fallback = {}) {
    return {
        focalX: finiteInRange(value.focalX ?? value.focal_x, 0, 1, finiteInRange(fallback.focalX, 0, 1, 0.5)),
        focalY: finiteInRange(value.focalY ?? value.focal_y, 0, 1, finiteInRange(fallback.focalY, 0, 1, 0.5)),
        zoom: finiteInRange(value.zoom, 1, 3, finiteInRange(fallback.zoom, 1, 3, 1)),
    };
}

function decodeDataUrl(value, kind) {
    const source = String(value || '').trim();
    const match = source.match(DATA_URL_PATTERN);
    if (!match) {
        throw new ProfileMediaServiceError(
            'invalid_profile_media',
            'Envie uma imagem PNG, JPG ou WEBP já otimizada pelo navegador.'
        );
    }
    const buffer = Buffer.from(match[2], 'base64');
    const limit = PROFILE_MEDIA_LIMITS[kind].inputBytes;
    if (!buffer.length) {
        throw new ProfileMediaServiceError('invalid_profile_media', 'A imagem enviada está vazia.');
    }
    if (buffer.length > limit) {
        throw new ProfileMediaServiceError(
            'profile_media_input_too_large',
            'A imagem otimizada ainda está grande demais para o perfil.',
            { kind, maximumBytes: limit, receivedBytes: buffer.length }
        );
    }
    return buffer;
}

async function encodeCandidate(input, kind, width, height, quality) {
    return sharp(input, {
        failOn: 'error',
        limitInputPixels: 50_000_000,
    })
        .rotate()
        .resize({
            width,
            height,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .webp({ quality, effort: 4 })
        .toBuffer({ resolveWithObject: true });
}

async function optimizeProfileMedia(kindInput, input) {
    const kind = normalizeKind(kindInput);
    const limit = PROFILE_MEDIA_LIMITS[kind];
    let metadata;
    try {
        metadata = await sharp(input, {
            failOn: 'error',
            limitInputPixels: 50_000_000,
        }).metadata();
    } catch {
        throw new ProfileMediaServiceError('invalid_profile_media', 'O arquivo não pôde ser validado como imagem.');
    }

    if (!metadata.width || !metadata.height) {
        throw new ProfileMediaServiceError('invalid_profile_media', 'A imagem não possui dimensões válidas.');
    }

    const scales = kind === 'banner' ? [1, 0.86, 0.72, 0.6] : [1, 0.86, 0.72];
    const qualities = [82, 74, 66, 58];
    let smallest = null;

    for (const scale of scales) {
        const width = Math.max(1, Math.round(limit.maxWidth * scale));
        const height = Math.max(1, Math.round(limit.maxHeight * scale));
        for (const quality of qualities) {
            let result;
            try {
                result = await encodeCandidate(input, kind, width, height, quality);
            } catch {
                throw new ProfileMediaServiceError('invalid_profile_media', 'Não foi possível processar a imagem enviada.');
            }
            if (!smallest || result.data.length < smallest.data.length) smallest = result;
            if (result.data.length <= limit.outputBytes) {
                return {
                    buffer: result.data,
                    mimeType: 'image/webp',
                    width: Number(result.info.width || 0),
                    height: Number(result.info.height || 0),
                    bytes: result.data.length,
                };
            }
        }
    }

    throw new ProfileMediaServiceError(
        'profile_media_output_too_large',
        'A imagem continuou pesada após a otimização. Use uma imagem menos complexa.',
        {
            kind,
            maximumBytes: limit.outputBytes,
            smallestBytes: smallest?.data?.length || null,
        }
    );
}

function safeStorageKey(playerId, kind, buffer) {
    const playerHash = crypto.createHash('sha256').update(String(playerId)).digest('hex').slice(0, 20);
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    return {
        key: `${playerHash}-${kind}-${contentHash.slice(0, 24)}.webp`,
        sha256: contentHash,
    };
}

function mediaPath(storageKey) {
    const safe = path.basename(String(storageKey || ''));
    if (!safe || safe !== storageKey) {
        throw new ProfileMediaServiceError('invalid_profile_media_storage', 'Referência de mídia inválida.');
    }
    return path.join(PROFILE_MEDIA_DIR, safe);
}

async function ensurePlayer(db, playerId) {
    const player = await db.get(
        'SELECT id, site_profile_image_data FROM jogadores WHERE id = ?',
        [playerId]
    );
    if (!player) {
        throw new ProfileMediaServiceError('player_not_found', 'Jogador não encontrado.');
    }
    return player;
}

function serializeRow(row) {
    if (!row) return null;
    return {
        schemaVersion: PROFILE_MEDIA_SCHEMA_VERSION,
        kind: row.kind,
        mimeType: row.mime_type,
        width: Number(row.width || 0),
        height: Number(row.height || 0),
        bytes: Number(row.byte_size || 0),
        sha256: row.sha256,
        focalX: Number(row.focal_x),
        focalY: Number(row.focal_y),
        zoom: Number(row.zoom),
        updatedAt: row.updated_at || null,
        version: row.updated_at || row.sha256,
    };
}

async function getProfileMediaRow(db, playerId, kindInput) {
    const kind = normalizeKind(kindInput);
    return db.get(
        `SELECT player_id, kind, mime_type, storage_key, byte_size, width, height, sha256,
                focal_x, focal_y, zoom, created_at, updated_at
         FROM clover_profile_media
         WHERE player_id = ? AND kind = ?`,
        [playerId, kind]
    );
}

async function getProfileMediaState(db, playerId) {
    const player = await ensurePlayer(db, playerId);
    const rows = await db.all(
        `SELECT player_id, kind, mime_type, storage_key, byte_size, width, height, sha256,
                focal_x, focal_y, zoom, created_at, updated_at
         FROM clover_profile_media
         WHERE player_id = ?
         ORDER BY kind ASC`,
        [playerId]
    );
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, serializeRow(row)]));
    return {
        schemaVersion: PROFILE_MEDIA_SCHEMA_VERSION,
        avatar: byKind.avatar || null,
        banner: byKind.banner || null,
        legacyAvatarAvailable: Boolean(player.site_profile_image_data),
    };
}

async function writeAtomic(targetPath, buffer) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    try {
        fs.writeFileSync(tempPath, buffer, { flag: 'wx' });
        fs.renameSync(tempPath, targetPath);
    } catch (error) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
        throw error;
    }
}

function unlinkQuiet(storageKey) {
    if (!storageKey) return;
    try {
        fs.rmSync(mediaPath(storageKey), { force: true });
    } catch {
        // A linha canônica do banco continua sendo a autoridade; cleanup físico é best-effort.
    }
}

async function saveProfileMedia(db, playerId, kindInput, image, transformInput = {}) {
    const kind = normalizeKind(kindInput);
    await ensurePlayer(db, playerId);
    const existing = await getProfileMediaRow(db, playerId, kind);

    if (image === null || image === undefined || String(image).trim() === '') {
        await db.run('DELETE FROM clover_profile_media WHERE player_id = ? AND kind = ?', [playerId, kind]);
        if (kind === 'avatar') {
            await db.run(
                `UPDATE jogadores
                 SET site_profile_image_data = NULL,
                     site_profile_image_updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [playerId]
            );
        }
        unlinkQuiet(existing?.storage_key);
        return { removed: true, media: null };
    }

    const decoded = decodeDataUrl(image, kind);
    const optimized = await optimizeProfileMedia(kind, decoded);
    const storage = safeStorageKey(playerId, kind, optimized.buffer);
    const targetPath = mediaPath(storage.key);
    const transform = normalizeTransform(transformInput, existing ? {
        focalX: existing.focal_x,
        focalY: existing.focal_y,
        zoom: existing.zoom,
    } : {});

    await writeAtomic(targetPath, optimized.buffer);
    try {
        await db.run(
            `INSERT INTO clover_profile_media
                (player_id, kind, mime_type, storage_key, byte_size, width, height, sha256,
                 focal_x, focal_y, zoom, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(player_id, kind) DO UPDATE SET
                mime_type = excluded.mime_type,
                storage_key = excluded.storage_key,
                byte_size = excluded.byte_size,
                width = excluded.width,
                height = excluded.height,
                sha256 = excluded.sha256,
                focal_x = excluded.focal_x,
                focal_y = excluded.focal_y,
                zoom = excluded.zoom,
                updated_at = CURRENT_TIMESTAMP`,
            [
                playerId, kind, optimized.mimeType, storage.key, optimized.bytes,
                optimized.width, optimized.height, storage.sha256,
                transform.focalX, transform.focalY, transform.zoom,
            ]
        );

        if (kind === 'avatar') {
            const dataUrl = `data:image/webp;base64,${optimized.buffer.toString('base64')}`;
            await db.run(
                `UPDATE jogadores
                 SET site_profile_image_data = ?,
                     site_profile_image_updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [dataUrl, playerId]
            );
        }
    } catch (error) {
        unlinkQuiet(storage.key);
        throw error;
    }

    if (existing?.storage_key && existing.storage_key !== storage.key) unlinkQuiet(existing.storage_key);
    return {
        removed: false,
        media: serializeRow(await getProfileMediaRow(db, playerId, kind)),
    };
}

async function updateProfileMediaTransform(db, playerId, kindInput, transformInput = {}) {
    const kind = normalizeKind(kindInput);
    await ensurePlayer(db, playerId);
    const existing = await getProfileMediaRow(db, playerId, kind);
    if (!existing) {
        throw new ProfileMediaServiceError('profile_media_not_found', 'Mídia do perfil não encontrada.');
    }
    const transform = normalizeTransform(transformInput, {
        focalX: existing.focal_x,
        focalY: existing.focal_y,
        zoom: existing.zoom,
    });
    await db.run(
        `UPDATE clover_profile_media
         SET focal_x = ?, focal_y = ?, zoom = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND kind = ?`,
        [transform.focalX, transform.focalY, transform.zoom, playerId, kind]
    );
    return serializeRow(await getProfileMediaRow(db, playerId, kind));
}

async function readProfileMedia(db, playerId, kindInput) {
    const kind = normalizeKind(kindInput);
    await ensurePlayer(db, playerId);
    const row = await getProfileMediaRow(db, playerId, kind);
    if (!row) {
        throw new ProfileMediaServiceError('profile_media_not_found', 'Mídia do perfil não encontrada.');
    }
    let buffer;
    try {
        buffer = fs.readFileSync(mediaPath(row.storage_key));
    } catch {
        throw new ProfileMediaServiceError(
            'profile_media_file_missing',
            'O arquivo da mídia do perfil não está disponível.',
            { kind }
        );
    }
    return {
        media: serializeRow(row),
        buffer,
        mimeType: row.mime_type || 'image/webp',
        etag: `"${row.sha256}"`,
    };
}

module.exports = {
    PROFILE_MEDIA_DIR,
    PROFILE_MEDIA_KINDS,
    PROFILE_MEDIA_LIMITS,
    PROFILE_MEDIA_SCHEMA_VERSION,
    ProfileMediaServiceError,
    decodeDataUrl,
    getProfileMediaRow,
    getProfileMediaState,
    normalizeKind,
    normalizeTransform,
    optimizeProfileMedia,
    readProfileMedia,
    saveProfileMedia,
    updateProfileMediaTransform,
};
