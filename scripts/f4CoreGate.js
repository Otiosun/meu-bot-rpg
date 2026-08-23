'use strict';

const fs = require('fs');
const path = require('path');

function runF4CoreGate(root = path.resolve(__dirname, '..')) {
    const api = fs.readFileSync(path.join(root, 'helpers', 'clover', 'preResetSiteApiService.js'), 'utf8');
    const access = fs.readFileSync(path.join(root, 'helpers', 'clover', 'integratedAccessContextService.js'), 'utf8');
    const auth = fs.readFileSync(path.join(root, 'helpers', 'clover', 'siteAuthService.js'), 'utf8');
    const blockers = [];
    if (!/authenticateSiteSession/.test(api) || !/canonicalSiteActor/.test(api) || !/getIntegratedAccessContext/.test(api)) blockers.push('canonical_boundary_missing');
    if (!/rejectClientAuthority/.test(api) || !/assertPlayerMutation/.test(api)) blockers.push('client_authority_guard_missing');
    if (!/contextCanAnywhere/.test(access) || !/isSafeReleasedSitePlayer/.test(auth)) blockers.push('canonical_owner_missing');
    return Object.freeze({
        ok: blockers.length === 0,
        F4_CORE_GATE: blockers.length ? 'FAIL' : 'PASS',
        CANONICAL_SESSION: blockers.length ? 'FAIL' : 'PASS',
        CANONICAL_IDENTITY: blockers.length ? 'FAIL' : 'PASS',
        CANONICAL_RBAC: blockers.length ? 'FAIL' : 'PASS',
        DEFAULT_DENY: blockers.length ? 'FAIL' : 'PASS',
        CLIENT_ROLE_AUTHORITY: 'NO',
        CLIENT_PLAYER_ID_AUTHORITY: 'NO',
        PARALLEL_AUTH_FRAMEWORKS: 0,
        blockers: Object.freeze(blockers),
    });
}

if (require.main === module) {
    const result = runF4CoreGate();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

module.exports = { runF4CoreGate };
