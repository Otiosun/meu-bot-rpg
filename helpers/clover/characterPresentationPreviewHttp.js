'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { getCharacterPresentationPreview } = require('./characterPresentationService');

const PREVIEW_PATH = '/character/presentation-preview';

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function handleCharacterPresentationPreview(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== PREVIEW_PATH) return false;

    setCors(req, res);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Clover-Preview', 'character-presentation.v1');

    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
            message: 'Esta prévia aceita apenas leitura.',
        });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'O banco ainda não está pronto.',
        });
        return true;
    }

    const authenticate = options.authenticateSession || authenticateSiteSession;
    const auth = await authenticate(db, bearerToken(req));
    if (!auth?.ok || !auth.player?.id) {
        sendJson(res, 401, {
            ok: false,
            error: auth?.reason || 'invalid_session',
            message: 'Sessão inválida ou expirada.',
        });
        return true;
    }

    try {
        const previewResolver = options.presentationPreview || getCharacterPresentationPreview;
        const preview = await previewResolver(db, auth.player.id, {
            audience: 'player',
            includeTechnical: false,
        });
        sendJson(res, 200, {
            ok: true,
            preview: true,
            readOnly: true,
            presentation: preview.presentation,
            comparison: preview.comparison,
        });
        return true;
    } catch (error) {
        const status = Number(error?.status || (error?.code === 'player_not_found' ? 404 : 500));
        sendJson(res, status, {
            ok: false,
            error: error?.code || 'presentation_preview_failed',
            message: status >= 500
                ? 'Não foi possível gerar a prévia da ficha.'
                : (error?.message || 'Prévia indisponível.'),
        });
        return true;
    }
}

module.exports = {
    PREVIEW_PATH,
    handleCharacterPresentationPreview,
};