'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MEDIA_BYTES = 768 * 1024;
const ALLOWED_MEDIA = Object.freeze({
    'image/jpeg': { extension: 'jpg', signature: 'jpeg' },
    'image/png': { extension: 'png', signature: 'png' },
    'image/webp': { extension: 'webp', signature: 'webp' },
});

class AdminMediaError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminMediaError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function safeInteger(value, fallback = null) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function safeMetadata(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mediaRoot(options = {}) {
    return path.resolve(
        options.mediaRoot
        || process.env.CLOVER_MEDIA_DIR
        || path.join(process.cwd(), 'clover-media')
    );
}

function detectMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (
        buffer[0] === 0xff
        && buffer[1] === 0xd8
        && buffer[2] === 0xff
    ) return 'image/jpeg';
    if (
        buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4e
        && buffer[3] === 0x47
        && buffer[4] === 0x0d
        && buffer[5] === 0x0a
        && buffer[6] === 0x1a
        && buffer[7] === 0x0a
    ) return 'image/png';
    if (
        buffer.toString('ascii', 0, 4) === 'RIFF'
        && buffer.toString('ascii', 8, 12) === 'WEBP'
    ) return 'image/webp';
    return null;
}

function decodeImageDataUrl(value) {
    const text = String(value || '').trim();
    const match = text.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
        throw new AdminMediaError(
            'invalid_media_data_url',
            'Envie uma imagem JPEG, PNG ou WebP em formato válido.'
        );
    }
    const declaredMime = match[1].toLowerCase();
    let bytes;
    try {
        bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    } catch {
        throw new AdminMediaError('invalid_media_base64', 'A imagem enviada está corrompida.');
    }
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) {
        throw new AdminMediaError(
            'media_too_large',
            `A imagem processada precisa ter no máximo ${Math.floor(MAX_MEDIA_BYTES / 1024)} KB.`,
            413,
            { maxBytes: MAX_MEDIA_BYTES, receivedBytes: bytes.length }
        );
    }
    const detectedMime = detectMime(bytes);
    if (!detectedMime || !ALLOWED_MEDIA[detectedMime]) {
        throw new AdminMediaError('unsupported_media', 'O conteúdo não é uma imagem JPEG, PNG ou WebP reconhecida.');
    }
    if (declaredMime !== detectedMime) {
        throw new AdminMediaError(
            'media_mime_mismatch',
            'O tipo declarado da imagem não corresponde ao conteúdo real.',
            400,
            { declaredMime, detectedMime }
        );
    }
    return { bytes, mimeType: detectedMime };
}

async function ensureAdminMediaSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_media_assets (
            id TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL UNIQUE,
            media_type TEXT NOT NULL DEFAULT 'item_image',
            mime_type TEXT NOT NULL,
            storage_name TEXT NOT NULL,
            byte_size INTEGER NOT NULL CHECK (byte_size > 0),
            width INTEGER DEFAULT NULL,
            height INTEGER DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'orphaned')),
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_media_assets_type_status
        ON clover_media_assets (media_type, status, created_at DESC)
    `);
}

function serializeAsset(row) {
    if (!row) return null;
    return {
        id: row.id,
        sha256: row.sha256,
        mediaType: row.media_type,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size || 0),
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        status: row.status,
        createdBy: row.created_by || null,
        createdAt: row.created_at || null,
        url: `/api/clover/media/${encodeURIComponent(row.id)}`,
    };
}

async function getMediaAsset(db, assetId, options = {}) {
    await ensureAdminMediaSchema(db);
    const id = String(assetId || '').trim().toUpperCase();
    const row = await db.get('SELECT * FROM clover_media_assets WHERE id = ?', [id]);
    if (!row || (!options.includeOrphaned && row.status !== 'active')) {
        if (options.nullIfMissing) return null;
        throw new AdminMediaError('media_not_found', 'Imagem não encontrada.', 404, { assetId: id });
    }
    return { row, asset: serializeAsset(row) };
}

async function writeContentAddressedFile(root, digest, extension, bytes) {
    await fs.promises.mkdir(root, { recursive: true });
    const storageName = `${digest}.${extension}`;
    const target = path.join(root, storageName);
    try {
        await fs.promises.access(target, fs.constants.R_OK);
        return { storageName, target, existed: true };
    } catch {}

    const temp = path.join(root, `.${storageName}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        await fs.promises.writeFile(temp, bytes, { flag: 'wx' });
        try {
            await fs.promises.rename(temp, target);
        } catch (error) {
            if (error?.code === 'EEXIST') {
                await fs.promises.unlink(temp).catch(() => null);
            } else {
                throw error;
            }
        }
    } catch (error) {
        await fs.promises.unlink(temp).catch(() => null);
        throw error;
    }
    return { storageName, target, existed: false };
}

async function createMediaAsset(db, actorId, input = {}, options = {}) {
    await ensureAdminMediaSchema(db);
    const decoded = decodeImageDataUrl(input.dataUrl || input.data_url);
    const digest = crypto.createHash('sha256').update(decoded.bytes).digest('hex');
    const id = `MEDIA-${digest.slice(0, 24).toUpperCase()}`;
    const existing = await db.get('SELECT * FROM clover_media_assets WHERE sha256 = ?', [digest]);
    if (existing) {
        return { ok: true, duplicate: true, asset: serializeAsset(existing) };
    }

    const width = safeInteger(input.width);
    const height = safeInteger(input.height);
    if ((width && width > 4096) || (height && height > 4096)) {
        throw new AdminMediaError('invalid_media_dimensions', 'As dimensões informadas são inválidas.');
    }
    const extension = ALLOWED_MEDIA[decoded.mimeType].extension;
    const root = mediaRoot(options);
    const file = await writeContentAddressedFile(root, digest, extension, decoded.bytes);

    try {
        await db.run(
            `INSERT INTO clover_media_assets
             (id, sha256, media_type, mime_type, storage_name, byte_size, width, height,
              status, created_by, created_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, ?)`,
            [
                id,
                digest,
                String(input.mediaType || input.media_type || 'item_image').trim().slice(0, 64) || 'item_image',
                decoded.mimeType,
                file.storageName,
                decoded.bytes.length,
                width,
                height,
                actorId || null,
                JSON.stringify(safeMetadata(input.metadata)),
            ]
        );
    } catch (error) {
        const raced = await db.get('SELECT * FROM clover_media_assets WHERE sha256 = ?', [digest]);
        if (raced) return { ok: true, duplicate: true, asset: serializeAsset(raced) };
        if (!file.existed) await fs.promises.unlink(file.target).catch(() => null);
        throw error;
    }

    const row = await db.get('SELECT * FROM clover_media_assets WHERE id = ?', [id]);
    return { ok: true, duplicate: false, asset: serializeAsset(row) };
}

async function resolveMediaFile(db, assetId, options = {}) {
    const found = await getMediaAsset(db, assetId);
    const root = mediaRoot(options);
    const absolutePath = path.resolve(root, found.row.storage_name);
    const prefix = `${root}${path.sep}`;
    if (!absolutePath.startsWith(prefix)) {
        throw new AdminMediaError('invalid_media_path', 'Caminho de mídia inválido.', 500);
    }
    try {
        const stat = await fs.promises.stat(absolutePath);
        if (!stat.isFile()) throw new Error('not_file');
    } catch {
        throw new AdminMediaError('media_file_missing', 'O registro da imagem existe, mas o arquivo não foi encontrado.', 503, {
            assetId: found.asset.id,
        });
    }
    return {
        ...found,
        absolutePath,
    };
}

module.exports = {
    ALLOWED_MEDIA,
    MAX_MEDIA_BYTES,
    AdminMediaError,
    createMediaAsset,
    decodeImageDataUrl,
    detectMime,
    ensureAdminMediaSchema,
    getMediaAsset,
    mediaRoot,
    resolveMediaFile,
    serializeAsset,
};
