'use strict';

const http = require('http');
const legacy = require('./siteApiServerLegacy');
const { handleAdminRaidRewardReviewReadHttp } = require('./adminRaidRewardReviewReadHttp');
const { handleRaidAtomicFinalizationHttp } = require('./raidAtomicFinalizationHttp');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleRaidFinalizationIdempotentHttp } = require('./raidFinalizationIdempotentHttp');
const { handleRaidIdempotentHttp } = require('./raidIdempotentHttp');
const { handleRaidRewardProposalIdempotentHttp } = require('./raidRewardProposalIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createProtectedMutationAwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            Promise.resolve(handleAdminRaidRewardReviewReadHttp(req, res, options))
                .then((handled) => (
                    handled
                        ? true
                        : handleSkillApprovalHttp(req, res, options)
                ))
                .then((handled) => (
                    handled
                        ? true
                        : handleRaidRewardProposalIdempotentHttp(req, res, options)
                ))
                .then((handled) => (
                    handled
                        ? true
                        : handleRaidFinalizationIdempotentHttp(req, res, options)
                ))
                .then((handled) => (
                    handled
                        ? true
                        : handleRaidAtomicFinalizationHttp(req, res, options)
                ))
                .then((handled) => (
                    handled
                        ? true
                        : handleRaidCoreIdempotentHttp(req, res, options)
                ))
                .then((handled) => (
                    handled
                        ? true
                        : handleRaidIdempotentHttp(req, res, options)
                ))
                .then((handled) => (
                    handled
                        ? true
                        : handleSquadMembershipTransferHttp(req, res, options)
                ))
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
    handleAdminRaidRewardReviewReadHttp,
    handleRaidAtomicFinalizationHttp,
    handleRaidCoreIdempotentHttp,
    handleRaidFinalizationIdempotentHttp,
    handleRaidIdempotentHttp,
    handleRaidRewardProposalIdempotentHttp,
    handleSkillApprovalHttp,
    handleSquadMembershipTransferHttp,
    startSiteApiServer,
};
