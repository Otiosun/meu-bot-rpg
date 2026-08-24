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
            'helpers/clover/playerLifecycleService.js',
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
// These files construct temporary SQLite state solely to exercise real HTTP
// handlers. They are not production writers and cannot become a second
// authority for any persisted Clover fact.
const NON_PRODUCTION_EVIDENCE_FILES = Object.freeze([
    'helpers/clover/preResetSiteApiEvidenceFixture.js',
    'helpers/clover/siteApiHandlerBoundaryProbes.js',
]);

/*
 * This is deliberately a bounded source audit. It recognizes static SQL and
 * named mutation helpers used by this repository; it does not claim to prove
 * arbitrary runtime-built SQL. Dynamic SQL must stay behind an approved
 * boundary and receive review as an explicit exception.
 */
const CRITICAL_HELPER_BOUNDARIES = Object.freeze({
    mutateYullsInTransaction: Object.freeze({
        fact: 'Yulls ledger mutation helper',
        writers: Object.freeze([
            'helpers/clover/adminRewardService.js',
            'helpers/clover/yullsService.js',
        ]),
    }),
    addPhInTransaction: Object.freeze({
        fact: 'PH ledger mutation helper',
        writers: Object.freeze([
            'helpers/clover/adminRewardService.js',
            'helpers/clover/adminService.js',
            'helpers/clover/antiGhostService.js',
            'helpers/clover/boxService.js',
            'helpers/clover/legacyraidService.js',
            'helpers/clover/paAdminPayoutService.js',
            'helpers/clover/paSceneWeekService.js',
            'helpers/clover/paShopService.js',
            'helpers/clover/phService.js',
            'helpers/clover/prShopService.js',
            'helpers/clover/quickEvaluationService.js',
            'helpers/clover/raidFinalizationService.js',
            'helpers/clover/recruitmentService.js',
        ]),
    }),
    hydrateLegacyInventory: Object.freeze({
        fact: 'explicit one-way legacy inventory hydration',
        writers: Object.freeze(['helpers/clover/inventoryService.js']),
    }),
});

const CRITICAL_PROJECTION_BOUNDARIES = Object.freeze({
    yulls_balance_projection: Object.freeze({
        fact: 'Yulls balance projection (jogadores.dinheiro)',
        writers: Object.freeze(['helpers/clover/yullsService.js']),
        pattern: /\bUPDATE\s+jogadores\b[^;]{0,800}?\bdinheiro\s*=/i,
    }),
    ph_summary_projection: Object.freeze({
        fact: 'PH summary projection (clover_character_stats)',
        writers: Object.freeze(['helpers/clover/phService.js']),
        pattern: /\bUPDATE\s+clover_character_stats\b[^;]{0,800}?\bph_(?:accumulated|available)\s*=/i,
    }),
});

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

function helperMutationPattern(helperName) {
    return new RegExp(`\\b${helperName}\\s*\\(`, 'm');
}

function auditableSourceFiles(root) {
    return SOURCE_ROOTS
        .flatMap((directory) => collectJavaScriptFiles(root, directory))
        .filter((file) => !NON_PRODUCTION_EVIDENCE_FILES.includes(file))
        .sort();
}

function findCriticalMutations(root) {
    const files = auditableSourceFiles(root);
    const found = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        for (const table of Object.keys(CRITICAL_TABLE_BOUNDARIES)) {
            if (mutationPattern(table).test(source)) found.push({ file, table });
        }
    }
    return found;
}

function findCriticalHelperMutations(root) {
    const files = auditableSourceFiles(root);
    const found = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        for (const helper of Object.keys(CRITICAL_HELPER_BOUNDARIES)) {
            if (helperMutationPattern(helper).test(source)) found.push({ file, helper });
        }
    }
    return found;
}

function findCriticalProjectionMutations(root) {
    const files = auditableSourceFiles(root);
    const found = [];
    for (const projection of Object.keys(CRITICAL_PROJECTION_BOUNDARIES)) {
        const boundary = CRITICAL_PROJECTION_BOUNDARIES[projection];
        for (const file of files) {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            if (boundary.pattern.test(source)) found.push({ file, projection });
        }
    }
    return found;
}

function auditCanonicalDataAuthority(root = path.resolve(__dirname, '..')) {
    const mutations = findCriticalMutations(root);
    const helperMutations = findCriticalHelperMutations(root);
    const projectionMutations = findCriticalProjectionMutations(root);
    const blockers = mutations
        .filter(({ file, table }) => !CRITICAL_TABLE_BOUNDARIES[table].writers.includes(file))
        .map(({ file, table }) => ({
            code: 'unclassified_critical_data_writer',
            file,
            table,
            fact: CRITICAL_TABLE_BOUNDARIES[table].fact,
        }))
        .concat(helperMutations
            .filter(({ file, helper }) => !CRITICAL_HELPER_BOUNDARIES[helper].writers.includes(file))
            .map(({ file, helper }) => ({
                code: 'unclassified_critical_helper_mutation',
                file,
                helper,
                fact: CRITICAL_HELPER_BOUNDARIES[helper].fact,
            })))
        .concat(projectionMutations
            .filter(({ file, projection }) => !CRITICAL_PROJECTION_BOUNDARIES[projection].writers.includes(file))
            .map(({ file, projection }) => ({
                code: 'unclassified_critical_projection_writer',
                file,
                projection,
                fact: CRITICAL_PROJECTION_BOUNDARIES[projection].fact,
            })));
    return Object.freeze({
        boundaries: CRITICAL_TABLE_BOUNDARIES,
        mutations,
        helperMutations,
        projectionMutations,
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
    CRITICAL_HELPER_BOUNDARIES,
    CRITICAL_PROJECTION_BOUNDARIES,
    CRITICAL_TABLE_BOUNDARIES,
    NON_PRODUCTION_EVIDENCE_FILES,
    SOURCE_ROOTS,
    assertCanonicalDataAuthority,
    auditCanonicalDataAuthority,
    findCriticalMutations,
    findCriticalHelperMutations,
    findCriticalProjectionMutations,
    helperMutationPattern,
    mutationPattern,
};
