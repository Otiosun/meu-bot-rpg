'use strict';

const fs = require('fs');
const path = require('path');
const { auditPreResetAuthority } = require('./auditPreResetAuthority');
const { DEFAULT_PRE_RESET_POLICY_REGISTRY } = require('../helpers/clover/preResetPolicyRegistryService');

function runPreResetApiPolicyGate(root = path.resolve(__dirname, '..')) {
    const blockers = [];
    const audit = auditPreResetAuthority(root);
    const api = fs.readFileSync(path.join(root, 'helpers', 'clover', 'preResetSiteApiService.js'), 'utf8');
    const legacy = fs.readFileSync(path.join(root, 'helpers', 'clover', 'siteApiServerLegacy.js'), 'utf8');
    const decisions = fs.readFileSync(path.join(root, 'docs', 'architecture', 'clover-prereset-product-decisions.md'), 'utf8');
    if (!audit.ok) blockers.push(...audit.blockers);
    if (!legacy.includes('handlePreResetSiteApi(req, res, options)')) blockers.push('site_api_not_integrated');
    if (!/\/pre-reset\/future-character/.test(api) || !/\/pre-reset\/shop\/purchase/.test(api)) blockers.push('api_surface_incomplete');
    if (!decisions.includes('D-09') || !decisions.includes('PRODUCT_DECISION_REQUIRED')) blockers.push('decision_manifest_incomplete');
    if (Object.values(DEFAULT_PRE_RESET_POLICY_REGISTRY.snapshot()).some((entry) => entry.enabled)) blockers.push('default_policy_enabled');
    return Object.freeze({ ok: blockers.length === 0, PRERESET_API_POLICY_GATE: blockers.length ? 'FAIL' : 'PASS', AUTHORITY_GUARD: audit.ok ? 'PASS' : 'FAIL', blockers: Object.freeze(blockers) });
}

if (require.main === module) {
    const result = runPreResetApiPolicyGate();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

module.exports = { runPreResetApiPolicyGate };
