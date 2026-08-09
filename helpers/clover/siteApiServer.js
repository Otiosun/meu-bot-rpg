'use strict';

const http = require('http');
const legacy = require('./siteApiServerLegacy');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createMembershipTransferAwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            Promise.resolve(handleSkillApprovalHttp(req, res, options))
                .then((handled) => handled || handleSquadMembershipTransferHttp(req, res, options))
                .then((handled) => {
                    if (!handled) listener(req, res);
                })
                .catch((error) => {
                    if (res.headersSent) {
                        res.end();
                        return;
                    }
                    sendJson(res, Number(error?.status || 500), {
                        ok: false,
                        error: error?.code || 'membership_transfer_http_error',
                        message: error?.message || 'Erro ao transferir membro.',
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
    handleSkillApprovalHttp,
    handleSquadMembershipTransferHttp,
    startSiteApiServer,
};
