'use strict';

const base = require('./adminApiSupportBase');
const { CONTRACT_VERSION } = require('./adminOperationContract');

const EXTRA_ADMIN_SECTIONS = Object.freeze([
    {
        key: 'boxes',
        label: 'Caixas',
        description: 'Auditar catálogos, chances, pity, relíquias e aberturas de Caixas.',
        capability: 'catalog.view',
    },
]);

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function adminSectionsV2() {
    const seen = new Set();
    return [...base.ADMIN_SECTIONS, ...EXTRA_ADMIN_SECTIONS].filter((section) => {
        if (!section?.key || seen.has(section.key)) return false;
        seen.add(section.key);
        return true;
    });
}

async function handleAdminBootstrapV2Http(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/admin/bootstrap') return false;

    setCors(req, res);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed', message: 'Método não permitido.' });
        return true;
    }

    const resolveContext = options.resolveAdminContext;
    if (typeof resolveContext !== 'function') {
        sendJson(res, 500, { ok: false, error: 'admin_context_resolver_missing', message: 'Contexto administrativo indisponível.' });
        return true;
    }
    const context = await resolveContext(req, res, options);
    if (!context) return true;

    const capabilities = new Set(context.access?.actor?.capabilities || []);
    const sections = adminSectionsV2().filter((section) => (
        section.ownerOnly
            ? context.access?.actor?.role === 'owner'
            : capabilities.has(section.capability)
    ));
    sendJson(res, 200, {
        ok: true,
        actor: {
            id: context.access.actor.id,
            displayName: context.auth?.player?.personagem_nome || context.auth?.player?.nome || null,
            role: context.access.actor.role,
            capabilities: [...capabilities],
        },
        contractVersion: CONTRACT_VERSION,
        sections,
    });
    return true;
}

module.exports = {
    EXTRA_ADMIN_SECTIONS,
    adminSectionsV2,
    handleAdminBootstrapV2Http,
};