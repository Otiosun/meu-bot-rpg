'use strict';

const http = require('http');
const legacy = require('./siteApiServerLegacy');
const { beginDatabaseLease } = require('./databaseLifecycleGuard');
const { handleAdminRaidRewardReviewReadHttp } = require('./adminRaidRewardReviewReadHttp');
const { handleRaidAtomicFinalizationHttp } = require('./raidAtomicFinalizationHttp');
const { handleRaidCoreIdempotentHttp } = require('./raidCoreIdempotentHttp');
const { handleRaidFinalizationIdempotentHttp } = require('./raidFinalizationIdempotentHttp');
const { handleRaidIdempotentHttp } = require('./raidIdempotentHttp');
const { handleRaidRewardProposalIdempotentHttp } = require('./raidRewardProposalIdempotentHttp');
const { handleSkillApprovalHttp } = require('./skillApprovalHttp');
const { handleSquadMembershipTransferHttp } = require('./squadMembershipTransferHttp');
const { handleMissionLifecycleHttp } = require('./playerMissionLifecycleHttp');

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createProtectedMutationAwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            let releaseDatabaseLease = null;
            let leaseReleased = false;

            const releaseLeaseOnce = () => {
                if (leaseReleased) return;
                leaseReleased = true;
                res.off('finish', releaseLeaseOnce);
                res.off('close', releaseLeaseOnce);
                if (releaseDatabaseLease) releaseDatabaseLease();
            };

            try {
                const db = options.getDb?.();
                if (db) {
                    const method = String(req.method || 'GET').toUpperCase();
                    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
                    releaseDatabaseLease = beginDatabaseLease(db, `site-api:${method} ${pathname}`);
                    res.once('finish', releaseLeaseOnce);
                    res.once('close', releaseLeaseOnce);
                }
            } catch (error) {
                sendJson(res, error?.code === 'database_retired' ? 503 : 500, {
                    ok: false,
                    error: error?.code || 'database_lease_error',
                    message: error?.code === 'database_retired'
                        ? 'Banco em troca durante reconexao. Tente novamente em instantes.'
                        : 'Nao foi possivel reservar o banco para esta requisicao.',
                });
                return;
            }

            Promise.resolve(handleAdminRaidRewardReviewReadHttp(req, res, options))
                .then((handled) => (
                    handled
                        ? true
                        : handleMissionLifecycleHttp(req, res, options)
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
    handleRaidAtomicFinalizationHttp,
    handleRaidCoreIdempotentHttp,
    handleRaidFinalizationIdempotentHttp,
    handleRaidIdempotentHttp,
    handleRaidRewardProposalIdempotentHttp,
    handleSkillApprovalHttp,
    handleMissionLifecycleHttp,
    handleSquadMembershipTransferHttp,
    startSiteApiServer,
};
