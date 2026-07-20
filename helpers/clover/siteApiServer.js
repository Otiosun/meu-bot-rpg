'use strict';

const http = require('http');
const base = require('./siteApiServerBase');
const { getRaidCategoryCatalog } = require('./raidService');

function setPublicCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function handleRaidCatalog(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!['/raids/categories', '/raid-categories'].includes(url.pathname)) return false;
    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return true;
    }
    const categories = getRaidCategoryCatalog();
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, categories, categorias: categories }));
    return true;
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createRaidV2AwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            try {
                if (handleRaidCatalog(req, res)) return;
            } catch (error) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                    ok: false,
                    error: 'raid_catalog_error',
                    message: error?.message || 'Erro ao carregar categorias de raid.',
                }));
                return;
            }
            listener(req, res);
        });
    };
    try {
        return base.startSiteApiServer(options);
    } finally {
        http.createServer = originalCreateServer;
    }
}

module.exports = {
    ...base,
    startSiteApiServer,
};
