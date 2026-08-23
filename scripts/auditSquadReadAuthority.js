'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_ROOTS = Object.freeze(['helpers/clover', 'comandos', 'database']);
const CANONICAL_READ_CONSUMERS = Object.freeze([
    'comandos/esquadrao.js',
    'helpers/clover/accessIntegrationService.js',
    'helpers/clover/adminOperationServiceBase.js',
    'helpers/clover/adminRaidProgressService.js',
    'helpers/clover/cavalierService.js',
    'helpers/clover/dreamWorldsService.js',
    'helpers/clover/dreamWorldsSlotPolicyService.js',
    'helpers/clover/economyService.js',
    'helpers/clover/legacyraidService.js',
    'helpers/clover/paShopService.js',
    'helpers/clover/performanceTeamService.js',
    'helpers/clover/quickEvaluationService.js',
    'helpers/clover/raidFinalizationService.js',
    'helpers/clover/raidMonthlyProgressService.js',
    'helpers/clover/raidRewardProposalCoreService.js',
    'helpers/clover/siteSquadMemberService.js',
    'helpers/clover/siteSquadOperationsService.js',
    'helpers/clover/squadService.js',
    'helpers/clover/squadStateService.js',
    'helpers/clover/squadUpgradeService.js',
]);

function filesIn(root, relative) {
    const directory = path.join(root, relative);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const child = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) return filesIn(root, child);
        return /\.(?:c?js|mjs)$/.test(entry.name) ? [child] : [];
    });
}

function auditSquadReadAuthority(root = path.resolve(__dirname, '..')) {
    const files = SOURCE_ROOTS.flatMap((directory) => filesIn(root, directory)).sort();
    const fallbackCalls = [];
    const directLegacyDecisionReads = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        if (/allowLegacyFallback\s*:\s*true|legacy_fallback|allowLegacyFallback\s*!==\s*false/.test(source)) {
            fallbackCalls.push(file);
        }
        if (/\bWHERE\b[^\n;]{0,300}\besquadrao\b/i.test(source)
            && !['helpers/clover/cloverAdminViewService.js'].includes(file)) {
            directLegacyDecisionReads.push(file);
        }
    }
    const missingCanonicalConsumers = CANONICAL_READ_CONSUMERS.filter((file) => {
        const filename = path.join(root, file);
        return !fs.existsSync(filename)
            || !fs.readFileSync(filename, 'utf8').includes('squadMembershipReadService');
    });
    const blockers = [
        ...fallbackCalls.map((file) => ({ code: 'production_legacy_fallback', file })),
        ...directLegacyDecisionReads.map((file) => ({ code: 'direct_legacy_squad_decision_read', file })),
        ...missingCanonicalConsumers.map((file) => ({ code: 'canonical_reader_not_used', file })),
    ];
    return Object.freeze({
        ok: blockers.length === 0,
        productionLegacyFallbackCalls: fallbackCalls.length,
        directLegacySquadDecisionReads: directLegacyDecisionReads.length,
        canonicalConsumers: CANONICAL_READ_CONSUMERS,
        blockers,
    });
}

function assertSquadReadAuthority(root) {
    const audit = auditSquadReadAuthority(root);
    if (!audit.ok) {
        const error = new Error(`Squad read-authority audit failed: ${audit.blockers.map((item) => `${item.code}:${item.file}`).join(', ')}`);
        error.audit = audit;
        throw error;
    }
    return audit;
}

if (require.main === module) {
    const audit = assertSquadReadAuthority();
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
}

module.exports = { CANONICAL_READ_CONSUMERS, assertSquadReadAuthority, auditSquadReadAuthority };
