'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * This is intentionally a repository audit, not runtime infrastructure.  It
 * protects the authority boundaries recorded in docs/architecture from a new
 * direct SQL writer silently becoming a second writer for a critical fact.
 */
const CRITICAL_TABLE_BOUNDARIES = Object.freeze({
    clover_yulls_ledger: Object.freeze({
        fact: 'Yulls ledger entries',
        authority: 'helpers/clover/yullsService.js',
        writers: Object.freeze(['helpers/clover/yullsService.js']),
    }),
    clover_squad_memberships: Object.freeze({
        fact: 'active squad membership',
        authority: 'helpers/clover/squadMembershipService.js',
        writers: Object.freeze([
            'helpers/clover/squadMembershipService.js',
            'helpers/clover/squadMembershipTransitionService.js',
        ]),
    }),
    clover_inventory_items: Object.freeze({
        fact: 'inventory holdings and item state',
        authority: 'helpers/clover/inventoryService.js',
        writers: Object.freeze([
            'comandos/fotoitem.js',
            'database/legacy.js',
            'helpers/clover/cloverScriptService.js',
            'helpers/clover/economyService.js',
            'helpers/clover/inventoryService.js',
            'helpers/clover/itemAdminService.js',
            'helpers/clover/legacyEventRewardResolutionExecutor.js',
            'helpers/clover/legacyInventoryRepairExecutor.js',
            'helpers/clover/legacyraidService.js',
            'helpers/clover/paItemUseService.js',
            'helpers/clover/paShopService.js',
            'helpers/clover/quickEvaluationService.js',
            'helpers/clover/schemaBaseConsolidationAudit.js',
            'helpers/clover/seasonalEventCatalog.js',
        ]),
    }),
    clover_role_grants: Object.freeze({
        fact: 'canonical role grants',
        authority: 'helpers/clover/canonicalRoleGrantService.js',
        writers: Object.freeze([
            'helpers/clover/canonicalAdminTeamService.js',
            'helpers/clover/canonicalRoleGrantService.js',
            'helpers/clover/canonicalRoleMigrationBatchService.js',
        ]),
    }),
    clover_ph_ledger: Object.freeze({
        fact: 'PH ledger entries',
        authority: 'helpers/clover/phService.js',
        writers: Object.freeze([
            'helpers/clover/adminRewardService.js',
            'helpers/clover/cloverScriptService.js',
            'helpers/clover/phService.js',
        ]),
    }),
    clover_pa_ledger: Object.freeze({
        fact: 'PA ledger entries',
        authority: 'helpers/clover/paService.js',
        writers: Object.freeze(['helpers/clover/paService.js']),
    }),
    clover_raids: Object.freeze({
        fact: 'raid state',
        authority: 'helpers/clover/raidV2Service.js',
        writers: Object.freeze([
            'helpers/clover/legacyraidService.js',
            'helpers/clover/raidAtomicFinalizationService.js',
            'helpers/clover/raidFinalizationService.js',
            'helpers/clover/raidV2Schema.js',
            'helpers/clover/raidV2Service.js',
            'helpers/clover/schemaMigrationCatalog.js',
        ]),
    }),
    clover_exit_confirmations: Object.freeze({
        fact: 'community-exit confirmation state',
        authority: 'helpers/clover/communityExitManager.js',
        writers: Object.freeze(['helpers/clover/communityExitManager.js']),
    }),
});

const SOURCE_ROOTS = Object.freeze(['helpers/clover', 'comandos', 'database']);

function normalizeRelative(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

function collectJavaScriptFiles(root, relativeDirectory) {
    const directory = path.join(root, relativeDirectory);
    if (!fs.existsSync(directory)) return [];
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectJavaScriptFiles(root, relative));
        } else if (/\.(?:c?js|mjs)$/.test(entry.name)) {
            files.push(normalizeRelative(root, path.join(directory, entry.name)));
        }
    }
    return files;
}

function mutationPattern(table) {
    return new RegExp(
        `\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`,
        'i'
    );
}

function findCriticalMutations(root) {
    const files = SOURCE_ROOTS.flatMap((directory) => collectJavaScriptFiles(root, directory)).sort();
    const found = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        for (const table of Object.keys(CRITICAL_TABLE_BOUNDARIES)) {
            if (mutationPattern(table).test(source)) found.push({ file, table });
        }
    }
    return found;
}

function auditCanonicalDataAuthority(root = path.resolve(__dirname, '..')) {
    const mutations = findCriticalMutations(root);
    const blockers = mutations
        .filter(({ file, table }) => !CRITICAL_TABLE_BOUNDARIES[table].writers.includes(file))
        .map(({ file, table }) => ({
            code: 'unclassified_critical_data_writer',
            file,
            table,
            fact: CRITICAL_TABLE_BOUNDARIES[table].fact,
        }));
    return Object.freeze({
        boundaries: CRITICAL_TABLE_BOUNDARIES,
        mutations,
        blockers,
        ok: blockers.length === 0,
    });
}

function assertCanonicalDataAuthority(root) {
    const audit = auditCanonicalDataAuthority(root);
    if (!audit.ok) {
        const error = new Error(`Canonical data-authority audit failed: ${audit.blockers.map((item) => `${item.table}:${item.file}`).join(', ')}`);
        error.code = 'canonical_data_authority_audit_failed';
        error.audit = audit;
        throw error;
    }
    return audit;
}

if (require.main === module) {
    const audit = assertCanonicalDataAuthority();
    process.stdout.write(`${JSON.stringify({ ok: audit.ok, criticalMutations: audit.mutations.length }, null, 2)}\n`);
}

module.exports = {
    CRITICAL_TABLE_BOUNDARIES,
    SOURCE_ROOTS,
    assertCanonicalDataAuthority,
    auditCanonicalDataAuthority,
    findCriticalMutations,
    mutationPattern,
};
