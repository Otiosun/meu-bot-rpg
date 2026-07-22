'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { CONTRACT_VERSION } = require('./adminOperationContract');
const { getAdminActorAccess } = require('./adminAccessService');

const ADMIN_SECTIONS = Object.freeze([
    {
        key: 'operations',
        label: 'Operações',
        description: 'Criar, simular, aplicar e acompanhar alterações administrativas.',
        capability: 'operation.view',
    },
    {
        key: 'players',
        label: 'Jogadores',
        description: 'Consultar fichas, vínculos, traços, itens e histórico.',
        capability: 'player.view',
    },
    {
        key: 'traits',
        label: 'Traços',
        description: 'Organizar o catálogo e atribuir traços do sistema.',
        capability: 'catalog.view',
    },
    {
        key: 'items',
        label: 'Itens',
        description: 'Criar modelos, versões, propriedades e cópias de itens.',
        capability: 'catalog.view',
    },
    {
        key: 'hooks',
        label: 'Ganchos',
        description: 'Criar e acompanhar ganchos narrativos dos personagens.',
        capability: 'catalog.view',
    },
    {
        key: 'rewards',
        label: 'Recompensas',
        description: 'Preparar pacotes, recursos, caixas e entregas em lote.',
        capability: 'catalog.view',
    },
    {
        key: 'raids',
        label: 'Raids e Missões',
        description: 'Revisar participantes, condições e premiações pendentes.',
        capability: 'raid.view',
    },
    {
        key: 'integrity',
        label: 'Integridade',
        description: 'Visualizar conflitos de identidade e referências quebradas.',
        capability: 'integrity.view',
    },
    {
        key: 'history',
        label: 'Histórico',
        description: 'Consultar operações, responsáveis, falhas e desfazimentos.',
        capability: 'operation.view',
    },
]);

function setAdminCors(req, res) {
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
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function defaultAuthenticate(db, req) {
    return authenticateSiteSession(db, bearerToken(req));
}

async function handleAdminApiSupport(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/admin/bootstrap') return false;

    setAdminCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
            message: 'O bootstrap administrativo aceita apenas GET.',
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

    const authenticate = options.authenticateSession || defaultAuthenticate;
    const auth = await authenticate(db, req);
    if (!auth?.ok || !auth.player?.id) {
        sendJson(res, 401, {
            ok: false,
            error: auth?.reason || 'invalid_session',
            message: 'Sessão inválida ou expirada.',
        });
        return true;
    }

    const accessResolver = options.accessResolver || getAdminActorAccess;
    const access = await accessResolver(db, auth.player.id, options.accessOptions || {});
    if (!access?.ok) {
        sendJson(res, 403, {
            ok: false,
            error: access?.code || 'admin_access_denied',
            message: 'Sua conta não possui acesso à Central ADM.',
        });
        return true;
    }

    const capabilitySet = new Set(access.actor.capabilities || []);
    const sections = ADMIN_SECTIONS.filter((section) => capabilitySet.has(section.capability));

    sendJson(res, 200, {
        ok: true,
        actor: {
            id: access.actor.id,
            displayName: auth.player.personagem_nome || auth.player.nome || null,
            role: access.actor.role,
            capabilities: [...capabilitySet],
        },
        contractVersion: CONTRACT_VERSION,
        sections,
    });
    return true;
}

module.exports = {
    ADMIN_SECTIONS,
    handleAdminApiSupport,
};
