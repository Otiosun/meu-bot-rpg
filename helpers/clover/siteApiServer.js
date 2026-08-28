'use strict';

const http = require('http');
const legacy = require('./siteApiServerLegacy');
const { handleAdminRaidRewardReviewReadHttp } = require('./adminRaidRewardReviewReadHttp');
const { handlePreResetTransitionAdminHttp } = require('./preResetTransitionAdminHttp');
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

function retireLegacyRecruitmentPrHttp(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const legacyRecruitmentPrRoute = url.pathname === '/recruitment/shop'
        || /^\/recruitment\/shop\//.test(url.pathname);
    if (!legacyRecruitmentPrRoute) return false;

    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 410, {
        ok: false,
        error: 'legacy_recruitment_pr_retired',
        message: method === 'OPTIONS'
            ? 'A superfície antiga de Pontos de Recrutamento foi aposentada.'
            : 'Pontos de Recrutamento foram aposentados. PR agora significa Pontos de Retorno.',
    });
    return true;
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createProtectedMutationAwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            if (retireLegacyRecruitmentPrHttp(req, res)) return;
            Promise.resolve(handleAdminRaidRewardReviewReadHttp(req, res, options))
                .then((handled) => (
                    handled
                        ? true
                        : handlePreResetTransitionAdminHttp(req, res, options)
                ))
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
                    const status = Number(error?.status || 500);
                    const publicClientError = Number.isInteger(status) && status >= 400 && status < 500;
                    sendJson(res, status, {
                        ok: false,
                        error: publicClientError ? (error?.code || 'site_interceptor_http_error') : 'site_interceptor_internal_error',
                        message: publicClientError && error?.message
                            ? error.message
                            : 'Erro ao processar a operação protegida.',
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
    handlePreResetTransitionAdminHttp,
    handleRaidAtomicFinalizationHttp,
    handleRaidCoreIdempotentHttp,
    handleRaidFinalizationIdempotentHttp,
    handleRaidIdempotentHttp,
    handleRaidRewardProposalIdempotentHttp,
    handleSkillApprovalHttp,
    handleSquadMembershipTransferHttp,
    retireLegacyRecruitmentPrHttp,
    startSiteApiServer,
};
