'use strict';

const { loadTreeSources } = require('./treeLoader');
const { listTreeCatalogVersions } = require('./skillTreeCatalogVersionService');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function requireCapability(access, capability) {
    if (access?.actor?.capabilities?.includes(capability)) return;
    const error = new Error('Seu perfil não possui a permissão necessária.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

function parseAdminSkillTreePath(pathname) {
    const path = String(pathname || '');
    if (path === '/admin/skill-trees') return { kind: 'dashboard' };
    const match = path.match(/^\/admin\/skill-trees\/([^/]+)$/);
    if (!match) return null;
    let treeId = match[1];
    try { treeId = decodeURIComponent(treeId); } catch { /* service validates */ }
    return { kind: 'tree', treeId };
}

function versionSummary(version) {
    return {
        treeId: version.treeId,
        version: version.version,
        status: version.status,
        fingerprint: version.fingerprint,
        source: version.source || null,
        reason: version.reason || null,
        createdBy: version.createdBy || null,
        createdAt: version.createdAt || null,
        activatedAt: version.activatedAt || null,
        archivedAt: version.archivedAt || null,
    };
}

async function getAdminSkillTreeDashboard(db, options = {}) {
    const actorId = String(options.actorId || 'system');
    const sources = loadTreeSources();
    const trees = [];
    for (const source of sources) {
        const versions = await listTreeCatalogVersions(db, source.tree.id, { actorId });
        const active = versions.find((entry) => entry.status === 'active') || null;
        const latest = versions[0] || null;
        trees.push({
            id: source.tree.id,
            name: source.tree.name,
            description: source.tree.description || null,
            nodeCount: Array.isArray(source.tree.nodes) ? source.tree.nodes.length : 0,
            routeCount: Array.isArray(source.tree.routes) ? source.tree.routes.length : 0,
            activeVersion: active?.version || null,
            latestVersion: latest?.version || null,
            draftCount: versions.filter((entry) => entry.status === 'draft').length,
            fingerprint: active?.fingerprint || null,
        });
    }
    return {
        ok: true,
        versioned: true,
        immutableActive: true,
        trees,
    };
}

async function getAdminSkillTreeDetail(db, treeId, options = {}) {
    const actorId = String(options.actorId || 'system');
    const versions = await listTreeCatalogVersions(db, treeId, { actorId });
    const active = versions.find((entry) => entry.status === 'active') || null;
    return {
        ok: true,
        treeId: active?.treeId || versions[0]?.treeId || String(treeId),
        activeVersion: active?.version || null,
        versions,
    };
}

async function handleAdminSkillTreeHttp(req, res, options = {}, parsedPath = null) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parsedPath || parseAdminSkillTreePath(url.pathname);
    if (!route) return false;

    setCors(req, res);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const resolveContext = options.resolveAdminContext;
    if (typeof resolveContext !== 'function') {
        sendJson(res, 500, {
            ok: false,
            error: 'admin_context_resolver_missing',
            message: 'Contexto administrativo indisponível.',
        });
        return true;
    }
    const context = await resolveContext(req, res, options);
    if (!context) return true;

    try {
        if (method !== 'GET') {
            const error = new Error('Método não permitido.');
            error.code = 'method_not_allowed';
            error.status = 405;
            throw error;
        }
        requireCapability(context.access, 'catalog.view');
        const actorId = context.access.actor.id;

        if (route.kind === 'dashboard') {
            const resolver = options.adminSkillTreeDashboard || getAdminSkillTreeDashboard;
            sendJson(res, 200, await resolver(context.db, { actorId }));
            return true;
        }

        const resolver = options.adminSkillTreeDetail || getAdminSkillTreeDetail;
        sendJson(res, 200, await resolver(context.db, route.treeId, { actorId }));
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_skill_tree_request_failed',
            message: error?.message || 'Não foi possível consultar o catálogo de Árvores.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    getAdminSkillTreeDashboard,
    getAdminSkillTreeDetail,
    handleAdminSkillTreeHttp,
    parseAdminSkillTreePath,
};
