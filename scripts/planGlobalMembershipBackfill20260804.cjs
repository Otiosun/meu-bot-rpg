'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { normalizeJid } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { normalizeSquadKey } = require('../helpers/clover/cavalierService');
const { squadMembershipEligibility } = require('../helpers/clover/squadMembershipService');
const {
    canonicalIdentityFor,
    getIdentityGraph,
} = require('../helpers/clover/siteIdentityGraph');
const {
    REPORT_STATUSES: RESTRUCTURE_STATUSES,
    classifyMatchedPlayer,
    planSquadRestructure,
} = require('./planSquadRestructure20260804.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'banco.sqlite');
const DEFAULT_AUTH_INFO_DIR = path.join(ROOT, 'auth_info');
const CATEGORIES = Object.freeze([
    'ready_for_membership_backfill',
    'already_canonical',
    'active_membership_conflict',
    'unknown_squad',
    'ineligible',
    'duplicate_identity',
    'projection_without_valid_squad',
    'multiple_active_memberships',
    'identity_ambiguous',
    'canonical_player_row_missing',
    'no_legacy_projection',
]);
const INACTIVE_SQUAD_STATUSES = new Set(['archived', 'inactive', 'closed', 'disabled', 'removed']);
const FUTURE_REVALIDATIONS = Object.freeze([
    'identity remains unique, active, non-shadow and unmerged',
    'sheet remains approved and game remains released',
    'legacy squad projection remains unchanged',
    'canonical squad remains active',
    'no active membership exists for the canonical identity',
    'idempotency key has not been consumed',
]);

function filled(value) {
    const text = String(value ?? '').trim();
    return Boolean(text) && !['-', 'n/a', 'null', 'undefined'].includes(text.toLowerCase());
}

function normalizedStatus(value) {
    return normalizeText(value).replace(/\s+/g, '_');
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function componentIdentity(identityGraph, value) {
    return canonicalIdentityFor(identityGraph, [value]);
}

function validPlayerIdentity(value) {
    return /^\d{8,}@(lid|s\.whatsapp\.net)$/i.test(String(value || '').trim());
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function readRows(db, tableName, orderBy = 'rowid') {
    if (!await tableExists(db, tableName)) return [];
    const safeTable = String(tableName).replace(/"/g, '""');
    return db.all(`SELECT * FROM "${safeTable}" ORDER BY ${orderBy}`);
}

function squadIsActive(squad = {}) {
    for (const field of ['status', 'lifecycle_status']) {
        if (filled(squad[field]) && INACTIVE_SQUAD_STATUSES.has(normalizedStatus(squad[field]))) {
            return false;
        }
    }
    if (Object.prototype.hasOwnProperty.call(squad, 'active') && Number(squad.active) === 0) return false;
    if (filled(squad.archived_at)) return false;
    return true;
}

function buildSquadIndex(squads) {
    const aliases = new Map();
    for (const squad of squads) {
        for (const alias of [squad.squad_key, squad.name]) {
            const key = normalizeSquadKey(alias);
            if (!key) continue;
            const rows = aliases.get(key) || [];
            if (!rows.includes(squad)) rows.push(squad);
            aliases.set(key, rows);
        }
    }
    return aliases;
}

function resolveProjectedSquad(index, projection) {
    const normalizedProjection = normalizeSquadKey(projection);
    if (!normalizedProjection) return { status: 'missing', normalizedProjection, squad: null };
    const matches = index.get(normalizedProjection) || [];
    if (matches.length !== 1) {
        return {
            status: matches.length ? 'ambiguous' : 'unknown',
            normalizedProjection,
            squad: null,
        };
    }
    const squad = matches[0];
    return {
        status: squadIsActive(squad) ? 'active' : 'inactive',
        normalizedProjection,
        squad,
    };
}

function identityEligibility(player = {}) {
    const reasons = [];
    const identityStatus = normalizedStatus(player.identity_status);
    const lifecycleStatus = normalizedStatus(player.lifecycle_status);
    if (identityStatus !== 'active') reasons.push('identity_not_active');
    if (lifecycleStatus !== 'active') reasons.push('lifecycle_not_active');
    if (Number(player.is_shadow || 0) !== 0) reasons.push('shadow_identity');
    if (filled(player.merged_into)) reasons.push('identity_merged');
    if (!validPlayerIdentity(player.id)) reasons.push('invalid_identity');

    const membershipEligibility = squadMembershipEligibility(player);
    if (!membershipEligibility.ok) reasons.push(membershipEligibility.code);
    return {
        ok: reasons.length === 0,
        reasons,
        identityStatus,
        lifecycleStatus,
        membershipEligibility,
    };
}

function groupPlayersByCanonicalIdentity(players, identityGraph) {
    const groups = new Map();
    for (const [index, player] of players.entries()) {
        const canonicalId = componentIdentity(identityGraph, player.id);
        const key = canonicalId || `invalid:${index}`;
        const rows = groups.get(key) || [];
        rows.push({ player, canonicalId });
        groups.set(key, rows);
    }
    return groups;
}

function identityGroupState(group) {
    if (!group || group.length === 0) return { status: 'missing', eligibleCount: 0 };
    if (group.length === 1) return { status: 'unique', eligibleCount: Number(identityEligibility(group[0].player).ok) };
    const eligibleCount = group.filter((entry) => identityEligibility(entry.player).ok).length;
    return {
        status: eligibleCount >= 2 ? 'identity_ambiguous' : 'duplicate_identity',
        eligibleCount,
    };
}

function membershipsByCanonicalIdentity(memberships, identityGraph) {
    const result = new Map();
    for (const membership of memberships) {
        const canonicalId = componentIdentity(identityGraph, membership.player_id);
        const rows = result.get(canonicalId) || [];
        rows.push(membership);
        result.set(canonicalId, rows);
    }
    return result;
}

function eventsByCanonicalIdentity(events, identityGraph) {
    const result = new Map();
    for (const event of events) {
        const canonicalId = componentIdentity(identityGraph, event.player_id);
        const rows = result.get(canonicalId) || [];
        rows.push(event);
        result.set(canonicalId, rows);
    }
    return result;
}

function countBy(items, selector) {
    const counts = {};
    for (const item of items) {
        const key = selector(item);
        if (!key) continue;
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function incrementCategory(counts, category) {
    counts[category] = Number(counts[category] || 0) + 1;
}

function readyCandidate(item) {
    return {
        canonical_identity: item.canonicalIdentity,
        selected_player_row_id: item.selectedPlayerRowId,
        proposed_membership_player_id: item.proposedMembershipPlayerId,
        proposed_squad_key: item.canonicalSquad.key,
        projection_source: {
            table: 'jogadores',
            field: 'esquadrao',
            value: item.legacyProjection.value,
        },
        eligibility_basis: {
            identity: 'active_non_shadow_unmerged_unique',
            sheet: item.eligibility.membershipEligibility.sheetStatus,
            game: item.eligibility.membershipEligibility.gameStatus,
            squad: 'canonical_active',
            active_memberships: 0,
        },
        future_write_preconditions: [...FUTURE_REVALIDATIONS],
        proposed_idempotency_key: `membership-backfill:${hashText(`${item.canonicalIdentity}\0${item.proposedMembershipPlayerId}\0${item.canonicalSquad.key}`).slice(0, 32)}`,
        history_preservation: {
            strategy: 'append_only_membership_and_event',
            preserve_legacy_projection: true,
            preserve_existing_membership_history: true,
            prior_membership_rows: item.history.memberships,
            prior_event_rows: item.history.events,
        },
    };
}

function classifyPlayer({
    player,
    canonicalId,
    identityGroup,
    squadIndex,
    memberships,
    events,
    playerRowsById,
    authInfoDir,
}) {
    const groupState = identityGroupState(identityGroup);
    const eligibility = identityEligibility(player);
    const legacyValue = filled(player.esquadrao) ? String(player.esquadrao).trim() : null;
    const projectedSquad = resolveProjectedSquad(squadIndex, legacyValue);
    const activeMemberships = memberships.filter((row) => normalizedStatus(row.status) === 'active');
    const membershipHistory = memberships.filter((row) => normalizedStatus(row.status) !== 'active');
    const proposedMembershipPlayerId = normalizeJid(player.id, { authInfoDir });
    const executablePlayerRow = playerRowsById.get(proposedMembershipPlayerId) || null;
    const executableEligibility = executablePlayerRow ? identityEligibility(executablePlayerRow) : null;
    const membershipPlayerCompatible = Boolean(
        executablePlayerRow
        && executableEligibility?.ok
        && executablePlayerRow.id === player.id
    );
    const item = {
        category: null,
        reasons: [],
        playerId: player.id,
        canonicalIdentity: canonicalId || null,
        selectedPlayerRowId: player.id,
        proposedMembershipPlayerId,
        membershipPlayerCompatible,
        identity: {
            status: groupState.status,
            records: identityGroup.length,
            eligibleRecords: groupState.eligibleCount,
        },
        eligibility,
        legacyProjection: {
            field: 'jogadores.esquadrao',
            value: legacyValue,
            normalized: projectedSquad.normalizedProjection || null,
        },
        canonicalSquad: projectedSquad.squad ? {
            key: projectedSquad.squad.squad_key,
            name: projectedSquad.squad.name,
            active: squadIsActive(projectedSquad.squad),
        } : null,
        activeMemberships: activeMemberships.map((row) => ({
            id: row.id ?? null,
            squad_key: row.squad_key,
            status: row.status,
        })),
        history: {
            memberships: membershipHistory.length,
            events: events.length,
        },
    };

    if (groupState.status === 'identity_ambiguous') {
        item.category = 'identity_ambiguous';
        item.reasons.push('multiple_eligible_identities_in_canonical_graph');
        return item;
    }
    if (groupState.status === 'duplicate_identity') {
        item.category = 'duplicate_identity';
        item.reasons.push('multiple_player_rows_in_canonical_identity');
        return item;
    }
    if (!eligibility.ok) {
        item.category = 'ineligible';
        item.reasons.push(...eligibility.reasons);
        return item;
    }
    if (!legacyValue) {
        item.category = 'no_legacy_projection';
        item.reasons.push('missing_jogadores_esquadrao');
        return item;
    }
    if (projectedSquad.status === 'unknown' || projectedSquad.status === 'ambiguous') {
        item.category = 'unknown_squad';
        item.reasons.push(projectedSquad.status === 'ambiguous' ? 'ambiguous_squad_mapping' : 'squad_not_registered');
        return item;
    }
    if (projectedSquad.status !== 'active') {
        item.category = 'projection_without_valid_squad';
        item.reasons.push('canonical_squad_inactive');
        return item;
    }
    if (activeMemberships.length > 1) {
        item.category = 'multiple_active_memberships';
        item.reasons.push('multiple_active_memberships_for_canonical_identity');
        return item;
    }
    if (activeMemberships.length === 1) {
        const membershipSquad = resolveProjectedSquad(squadIndex, activeMemberships[0].squad_key);
        const projectedKey = normalizeSquadKey(projectedSquad.squad.squad_key);
        const membershipKey = normalizeSquadKey(activeMemberships[0].squad_key);
        if (membershipSquad.status !== 'active' || membershipKey !== projectedKey) {
            item.category = 'active_membership_conflict';
            item.reasons.push(
                membershipSquad.status !== 'active'
                    ? 'active_membership_targets_invalid_squad'
                    : 'active_membership_differs_from_legacy_projection'
            );
            return item;
        }
        item.category = 'already_canonical';
        item.reasons.push('single_active_membership_matches_projection');
        return item;
    }

    if (!membershipPlayerCompatible) {
        item.category = 'canonical_player_row_missing';
        item.reasons.push(
            executablePlayerRow
                ? 'membership_normalization_selects_different_player_row'
                : 'membership_normalization_has_no_player_row'
        );
        return item;
    }

    item.category = 'ready_for_membership_backfill';
    item.reasons.push('eligible_projection_without_active_membership');
    return item;
}

function buildSanitizedSummary(plan) {
    return {
        kind: 'clover.global-membership-backfill-summary.20260804',
        generatedAt: plan.generatedAt,
        readOnly: true,
        SafeToApply: false,
        SafeToDeploy: false,
        totals: plan.totals,
        categoryCounts: plan.categoryCounts,
        legacySquadCounts: plan.legacySquadCounts,
        canonicalSquadCounts: plan.canonicalSquadCounts,
        projectedRestructure: plan.projectedRestructure,
        databaseUnchanged: plan.database?.unchanged ?? null,
    };
}

async function planGlobalMembershipBackfill(db, options = {}) {
    await db.exec('PRAGMA query_only = ON');
    const queryOnly = await db.get('PRAGMA query_only');
    const authInfoDir = options.authInfoDir || DEFAULT_AUTH_INFO_DIR;
    const identityGraph = getIdentityGraph(authInfoDir);
    const [players, squads, memberships, events] = await Promise.all([
        readRows(db, 'jogadores', 'id'),
        readRows(db, 'clover_squads', 'squad_key'),
        readRows(db, 'clover_squad_memberships', 'id'),
        readRows(db, 'clover_squad_membership_events', 'id'),
    ]);
    const squadIndex = buildSquadIndex(squads);
    const identityGroups = groupPlayersByCanonicalIdentity(players, identityGraph);
    const membershipGroups = membershipsByCanonicalIdentity(memberships, identityGraph);
    const eventGroups = eventsByCanonicalIdentity(events, identityGraph);
    const playerRowsById = new Map(players.map((player) => [player.id, player]));
    const items = [];
    const categoryCounts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));

    for (const player of players) {
        const canonicalId = componentIdentity(identityGraph, player.id);
        const group = identityGroups.get(canonicalId) || [{ player, canonicalId }];
        const item = classifyPlayer({
            player,
            canonicalId,
            identityGroup: group,
            squadIndex,
            memberships: membershipGroups.get(canonicalId) || [],
            events: eventGroups.get(canonicalId) || [],
            playerRowsById,
            authInfoDir,
        });
        incrementCategory(categoryCounts, item.category);
        items.push(item);
    }

    items.sort((left, right) => (
        String(left.canonicalIdentity || left.playerId).localeCompare(String(right.canonicalIdentity || right.playerId))
    ));
    const readyCandidates = items
        .filter((item) => item.category === 'ready_for_membership_backfill')
        .map(readyCandidate);
    const readyIdentities = readyCandidates.map((candidate) => candidate.canonical_identity);
    const idempotencyKeys = readyCandidates.map((candidate) => candidate.proposed_idempotency_key);
    if (new Set(readyIdentities).size !== readyIdentities.length) {
        throw new Error('ready_candidates_duplicate_canonical_identity');
    }
    if (new Set(idempotencyKeys).size !== idempotencyKeys.length) {
        throw new Error('ready_candidates_duplicate_idempotency_key');
    }
    const activeMemberships = memberships.filter((row) => normalizedStatus(row.status) === 'active');
    const multipleActiveIdentities = [...membershipGroups.entries()]
        .filter(([, rows]) => rows.filter((row) => normalizedStatus(row.status) === 'active').length > 1)
        .map(([canonicalId, rows]) => ({
            canonical_identity: canonicalId,
            active_memberships: rows.filter((row) => normalizedStatus(row.status) === 'active').length,
        }));
    const duplicateIdentityComponents = [...identityGroups.values()]
        .filter((group) => identityGroupState(group).status === 'duplicate_identity').length;
    const ambiguousIdentityComponents = [...identityGroups.values()]
        .filter((group) => identityGroupState(group).status === 'identity_ambiguous').length;
    const duplicateIdentityRecords = [...identityGroups.values()]
        .filter((group) => identityGroupState(group).status === 'duplicate_identity')
        .reduce((total, group) => total + group.length, 0);
    const ambiguousIdentityRecords = [...identityGroups.values()]
        .filter((group) => identityGroupState(group).status === 'identity_ambiguous')
        .reduce((total, group) => total + group.length, 0);
    const plan = {
        kind: 'clover.global-membership-backfill-plan.20260804',
        generatedAt: options.generatedAt || new Date().toISOString(),
        readOnly: true,
        queryOnly: Number(queryOnly?.query_only ?? Object.values(queryOnly || {})[0]) === 1,
        SafeToApply: false,
        SafeToDeploy: false,
        categories: [...CATEGORIES],
        totals: {
            playersRead: players.length,
            identityComponentsRead: identityGroups.size,
            withLegacyProjection: items.filter((item) => item.legacyProjection.value).length,
            withoutLegacyProjection: items.filter((item) => !item.legacyProjection.value).length,
            canonicalSquads: squads.length,
            activeMemberships: activeMemberships.length,
            multipleActiveMembershipIdentities: multipleActiveIdentities.length,
            duplicateIdentityComponents,
            duplicateIdentityRecords,
            ambiguousIdentityComponents,
            ambiguousIdentityRecords,
            unknownSquads: categoryCounts.unknown_squad,
            ineligible: categoryCounts.ineligible,
            readyForMembershipBackfill: categoryCounts.ready_for_membership_backfill,
        },
        categoryCounts,
        legacySquadCounts: countBy(items, (item) => item.legacyProjection.normalized),
        canonicalSquadCounts: countBy(items, (item) => item.canonicalSquad?.key),
        items,
        readyCandidates,
        multipleActiveIdentities,
        projectedRestructure: null,
        database: options.database || null,
    };
    plan.sanitizedSummary = buildSanitizedSummary(plan);
    return plan;
}

function projectedCounts(items) {
    const counts = Object.fromEntries(RESTRUCTURE_STATUSES.map((status) => [status, 0]));
    for (const item of items) counts[item.status] = Number(counts[item.status] || 0) + 1;
    return counts;
}

async function projectRestructureAfterBackfill(db, globalPlan, options = {}) {
    if (!options.restructureSourcePath && !options.restructureTargets) return null;
    const before = await planSquadRestructure(db, {
        sourcePath: options.restructureSourcePath,
        targets: options.restructureTargets,
        authInfoDir: options.authInfoDir || DEFAULT_AUTH_INFO_DIR,
    });
    const identityGraph = getIdentityGraph(options.authInfoDir || DEFAULT_AUTH_INFO_DIR);
    const readyByPlayer = new Map(globalPlan.readyCandidates.map((candidate) => [
        candidate.canonical_identity,
        candidate,
    ]));
    const transitions = {};
    const afterItems = before.items.map((item) => {
        let status = item.status;
        if (item.player) {
            const canonicalId = componentIdentity(identityGraph, item.player.id);
            const candidate = readyByPlayer.get(canonicalId);
            if (candidate) {
                const projectedPlayer = {
                    ...item.player,
                    esquadrao: item.player.squad,
                    identity_status: item.player.identity_state,
                    is_shadow: 0,
                };
                const activeMemberships = [
                    ...(item.player.active_memberships || []),
                    { id: 'projected', squad_key: candidate.proposed_squad_key, status: 'active' },
                ];
                status = classifyMatchedPlayer(projectedPlayer, item.targetSquadKey, activeMemberships);
            }
        }
        const transition = `${item.status}->${status}`;
        transitions[transition] = Number(transitions[transition] || 0) + 1;
        return { status };
    });
    return {
        readOnly: true,
        projectedInMemory: true,
        SafeToApply: false,
        SafeToDeploy: false,
        beforeCounts: before.counts,
        afterCounts: projectedCounts(afterItems),
        transitions: Object.fromEntries(Object.entries(transitions).sort(([left], [right]) => left.localeCompare(right))),
        extrasBefore: before.extras.length,
        extrasAfter: before.extras.length,
    };
}

function applyGlobalMembershipBackfill() {
    const error = new Error('Apply indisponivel nesta PR read-only.');
    error.code = 'apply_unavailable';
    throw error;
}

function parseArgs(argv) {
    const options = {
        db: DEFAULT_DB,
        output: null,
        authInfoDir: process.env.CLOVER_AUTH_INFO_DIR || DEFAULT_AUTH_INFO_DIR,
        restructureSourcePath: null,
        apply: false,
    };
    for (const arg of argv) {
        if (arg.startsWith('--db=')) options.db = arg.slice(5).replace(/^"|"$/g, '');
        else if (arg.startsWith('--output=')) options.output = arg.slice(9).replace(/^"|"$/g, '');
        else if (arg.startsWith('--auth-info-dir=')) options.authInfoDir = arg.slice(16).replace(/^"|"$/g, '');
        else if (arg.startsWith('--restructure-source=')) options.restructureSourcePath = arg.slice(21).replace(/^"|"$/g, '');
        else if (arg === '--apply') options.apply = true;
    }
    return options;
}

function assertPrivateOutputPath(outputPath) {
    if (!outputPath) return;
    const resolved = path.resolve(outputPath);
    const relative = path.relative(ROOT, resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        throw new Error('O relatorio privado deve ser gravado fora do repositorio.');
    }
}

async function openReadOnlyDatabase(databasePath) {
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    await db.exec('PRAGMA query_only = ON');
    return db;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.apply) applyGlobalMembershipBackfill();
    if (!options.db || !fs.existsSync(options.db)) throw new Error('Informe um banco existente com --db=CAMINHO.');
    if (options.restructureSourcePath && !fs.existsSync(options.restructureSourcePath)) {
        throw new Error('A fonte privada da reestruturacao nao foi encontrada.');
    }
    assertPrivateOutputPath(options.output);

    const beforeHash = await hashFile(options.db);
    const db = await openReadOnlyDatabase(options.db);
    let plan;
    try {
        plan = await planGlobalMembershipBackfill(db, options);
        plan.projectedRestructure = await projectRestructureAfterBackfill(db, plan, options);
    } finally {
        await db.close();
    }
    const afterHash = await hashFile(options.db);
    plan.database = {
        sha256Before: beforeHash,
        sha256After: afterHash,
        unchanged: beforeHash === afterHash,
        openedReadOnly: true,
        queryOnly: plan.queryOnly,
    };
    plan.sanitizedSummary = buildSanitizedSummary(plan);
    if (!plan.database.unchanged) throw new Error('O hash do banco mudou durante a execucao read-only.');

    if (options.output) {
        fs.writeFileSync(options.output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    }
    process.stdout.write(`${JSON.stringify(plan.sanitizedSummary, null, 2)}\n`);
    return plan;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`${error.code || 'planner_failed'}: ${error.message || error}`);
        process.exitCode = 1;
    });
}

module.exports = {
    CATEGORIES,
    FUTURE_REVALIDATIONS,
    applyGlobalMembershipBackfill,
    assertPrivateOutputPath,
    buildSanitizedSummary,
    componentIdentity,
    classifyPlayer,
    identityEligibility,
    main,
    openReadOnlyDatabase,
    parseArgs,
    planGlobalMembershipBackfill,
    projectRestructureAfterBackfill,
    resolveProjectedSquad,
    squadIsActive,
};
