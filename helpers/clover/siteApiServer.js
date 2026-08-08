'use strict';

const http = require('http');
const legacy = require('./siteApiServerLegacy');
const { handleAdminMediaHttp } = require('./adminMediaHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { resolveAdminContext } = require('./adminApiSupportBase');
const { handleAdminSpellHttp, parseAdminSpellPath } = require('./adminSpellHttp');
const { handleAdminBoxHttp, parseAdminBoxPath } = require('./adminBoxHttp');

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createAdminMediaAwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            Promise.resolve(handleAdminMediaHttp(req, res, options))
                .then((handled) => (
                    handled
                        ? true
                        : handleSquadMembershipTransferHttp(req, res, options)
                ))
                .then((handled) => {
                    if (handled) return true;
                    const url = new URL(req.url || '/', 'http://localhost');
                    const boxPath = parseAdminBoxPath(url.pathname);
                    if (!boxPath) return false;
                    return handleAdminBoxHttp(req, res, {
                        ...options,
                        resolveAdminContext,
                    }, boxPath);
                })
                .then((handled) => {
                    if (handled) return true;
                    const url = new URL(req.url || '/', 'http://localhost');
                    const spellPath = parseAdminSpellPath(url.pathname);
                    if (!spellPath) return false;
                    return handleAdminSpellHttp(req, res, {
                        ...options,
                        resolveAdminContext,
                    }, spellPath);
                })
                .then((handled) => {
                    if (!handled) listener(req, res);
                })
                .catch((error) => {
                    if (res.headersSent) {
                        if (!res.writableEnded) res.end();
                        return;
                    }
                    sendJson(res, Number(error?.status || 500), {
                        ok: false,
                        error: error?.code || 'site_interceptor_http_error',
                        message: error?.message || 'Erro ao processar a operação protegida.',
                    });
                });
        });
    };
    try {
        return legacy.startSiteApiServer(options);
    } finally {
        http.createServer = originalCreateServer;
    }
}

module.exports = {
    ...legacy,
    handleAdminBoxHttp,
    handleAdminMediaHttp,
    handleAdminSpellHttp,
    handleSquadMembershipTransferHttp,
    parseAdminBoxPath,
    parseAdminSpellPath,
    startSiteApiServer,
};