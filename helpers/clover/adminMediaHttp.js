'use strict';

const fs = require('fs');
const path = require('path');
const { getAdminActorAccess } = require('./adminAccessService');
const {
    AdminMediaError,
    createMediaAsset,
    resolveMediaFile,
} = require('./adminMediaService');
const { authenticateSiteSession } = require('./siteAuthService');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function mediaRuntimeOptions(options = {}) {
    if (options.mediaRoot || process.env.CLOVER_MEDIA_DIR) return options;
    return {
        ...options,
        mediaRoot: path.resolve(process.cwd(), '..', 'clover-media'),
    };
}

async function readJsonBody(req, maxBytes = 1_200_000) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            throw new AdminMediaError('media_request_too_large', 'O upload excede o limite permitido.', 413, { maxBytes });
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new AdminMediaError('invalid_json', 'JSON inválido.', 400);
    }
}

function parseRoute(pathname) {
    const pathValue = String(pathname || '');
    if (pathValue === '/admin/media/items') return { kind: 'upload-item' };
    const match = pathValue.match(/^\/media\/(MEDIA-[A-F0-9]{24})$/i);
    if (match) return { kind: 'read', assetId: match[1].toUpperCase() };
    return null;
}

async function authorizeItemMediaUpload(db, req, options = {}) {
    const authenticate = options.authenticateSession
        || ((database, request) => authenticateSiteSession(database, bearerToken(request)));
    const auth = await authenticate(db, req);
    if (!auth?.ok || !auth.player?.id) {
        throw new AdminMediaError(
            auth?.reason || 'invalid_session',
            'Sessão inválida ou expirada.',
            401
        );
    }
    const accessResolver = options.accessResolver || getAdminActorAccess;
    const access = await accessResolver(db, auth.player.id, options.accessOptions || {});
    if (!access?.ok) {
        throw new AdminMediaError(
            access?.code || 'admin_access_denied',
            'Sua conta não possui acesso à Central ADM.',
            403
        );
    }
    if (!access.actor?.capabilities?.includes('catalog.manage.items')) {
        throw new AdminMediaError(
            'missing_capability',
            'Seu perfil não possui permissão para gerenciar imagens de itens.',
            403,
            { capability: 'catalog.manage.items' }
        );
    }
    return access.actor;
}

async function streamAsset(db, route, res, options = {}) {
    const runtimeOptions = mediaRuntimeOptions(options);
    const resolved = await resolveMediaFile(db, route.assetId, runtimeOptions);
    res.statusCode = 200;
    res.setHeader('Content-Type', resolved.asset.mimeType);
    res.setHeader('Content-Length', String(resolved.asset.byteSize));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${resolved.asset.sha256}"`);
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(resolved.absolutePath);
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.pipe(res);
    });
}

async function handleAdminMediaHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parseRoute(url.pathname);
    if (!route) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'Banco ainda não está pronto.',
        });
        return true;
    }

    try {
        if (route.kind === 'read') {
            if (method !== 'GET') throw new AdminMediaError('method_not_allowed', 'Método não permitido.', 405);
            await streamAsset(db, route, res, options);
            return true;
        }

        if (method !== 'POST') throw new AdminMediaError('method_not_allowed', 'Método não permitido.', 405);
        const actor = await authorizeItemMediaUpload(db, req, options);
        const body = await readJsonBody(req);
        const create = options.createMediaAsset || createMediaAsset;
        const runtimeOptions = mediaRuntimeOptions(options);
        const result = await create(db, actor.id, {
            ...body,
            mediaType: 'item_image',
        }, runtimeOptions);
        sendJson(res, result.duplicate ? 200 : 201, result);
        return true;
    } catch (error) {
        const status = Number(error?.status || (error instanceof AdminMediaError ? 400 : 500));
        if (!res.headersSent) {
            sendJson(res, status, {
                ok: false,
                error: error?.code || 'admin_media_failed',
                message: error?.message || 'Não foi possível processar a imagem.',
                details: error?.details || null,
            });
        } else if (!res.writableEnded) {
            res.end();
        }
        return true;
    }
}

module.exports = {
    authorizeItemMediaUpload,
    handleAdminMediaHttp,
    mediaRuntimeOptions,
    parseRoute,
    readJsonBody,
    streamAsset,
};
