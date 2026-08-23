'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { normalizeSquadKey } = require('../helpers/clover/cavalierService');
const { auditSquadMembershipDivergence } = require('../helpers/clover/squadMembershipDivergenceAudit');

const CAMPAIGN = 'F3F1';
const AUTHORITY_SOURCE = 'clover_squad_memberships.active';
const LIVE_RUNTIME_PATH = path.resolve(__dirname, '..', 'banco.sqlite');
const DISPOSABLE_NAME = /^clover-f3-disposable-policy-repair-[a-z0-9_-]+\.sqlite$/i;
const CLASSIFICATION = Object.freeze({
    ARCHIVE_END_MEMBERSHIP: 'ARCHIVE_END_MEMBERSHIP',
    LEGACY_GRANDFATHER: 'LEGACY_GRANDFATHER',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    BLOCKED_INVALID_STATE: 'BLOCKED_INVALID_STATE',
});

function neutralLegacy(value) {
    return ['', '-', 'nenhum', 'n/a', 'na', 'null', 'undefined'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizedPlayerId(value) {
    return String(value ?? '').trim() || null;
}

function normalizeStatus(value) {
    return String(value ?? '').trim().toLowerCase();
}

function safeJson(value) {
    try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function reasonCounts(details) {
    return details.reduce((counts, detail) => {
        counts[detail.reason_code] = (counts[detail.reason_code] || 0) + 1;
        return counts;
    }, {});
}

async function requireTables(db, names) {
    const rows = await db.all(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(', ')})`,
        names
    );
    const found = new Set(rows.map((row) => row.name));
    const missing = names.filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Squad policy repair requires: ${missing.join(', ')}`);
}

async function tableExists(db, name) {
    return Boolean(await db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function action({ playerId, classification, reasonCode, preconditions, membershipId = null, squadKey = null }) {
    return {
        player_id: playerId,
        classification,
        reason_code: reasonCode,
        membership_id: membershipId,
        squad_key: squadKey,
        preconditions_verified: preconditions,
    };
}

function addByPlayer(map, playerId, row) {
    if (!playerId) return;
    if (!map.has(playerId)) map.set(playerId, []);
    map.get(playerId).push(row);
}

function eventAfterJoin(events, joinedAt) {
    const joined = Date.parse(joinedAt || '');
    if (Number.isNaN(joined)) return false;
    return events.some((event) => event.operation_type === 'archive' && Date.parse(event.created_at || '') >= joined);
}

async function buildPlan(db) {
    await requireTables(db, [
        'jogadores',
        'clover_squads',
        'clover_squad_memberships',
        'clover_squad_membership_events',
        'clover_player_lifecycle_events',
    ]);
    const hasTransitions = await tableExists(db, 'clover_squad_membership_transitions');
    const [players, squads, memberships, membershipEvents, lifecycleEvents, transitions] = await Promise.all([
        db.all('SELECT id, esquadrao, lifecycle_status, ficha_status, jogo_status FROM jogadores ORDER BY id'),
        db.all('SELECT squad_key, name FROM clover_squads ORDER BY squad_key'),
        db.all('SELECT id, player_id, squad_key, status, joined_at, ended_at, changed_by, reason, metadata_json FROM clover_squad_memberships ORDER BY player_id, id'),
        db.all('SELECT id, membership_id, player_id, squad_key, action, created_at FROM clover_squad_membership_events ORDER BY player_id, id'),
        db.all('SELECT id, player_id, operation_type, created_at FROM clover_player_lifecycle_events ORDER BY player_id, id'),
        hasTransitions ? db.all('SELECT player_id, status FROM clover_squad_membership_transitions ORDER BY player_id, id') : Promise.resolve([]),
    ]);

    const playersById = new Map(players.map((player) => [normalizedPlayerId(player.id), player]));
    const squadsByAlias = new Map();
    for (const squad of squads) {
        const key = normalizeSquadKey(squad.squad_key);
        if (!key) continue;
        squadsByAlias.set(key, { ...squad, canonical_key: key });
        const nameKey = normalizeSquadKey(squad.name);
        if (nameKey) squadsByAlias.set(nameKey, { ...squad, canonical_key: key });
    }
    const membershipsByPlayer = new Map();
    const eventsByPlayer = new Map();
    const lifecycleByPlayer = new Map();
    const transitionsByPlayer = new Map();
    for (const row of memberships) addByPlayer(membershipsByPlayer, normalizedPlayerId(row.player_id), row);
    for (const row of membershipEvents) addByPlayer(eventsByPlayer, normalizedPlayerId(row.player_id), row);
    for (const row of lifecycleEvents) addByPlayer(lifecycleByPlayer, normalizedPlayerId(row.player_id), row);
    for (const row of transitions) addByPlayer(transitionsByPlayer, normalizedPlayerId(row.player_id), row);

    const playerIds = [...new Set([...playersById.keys(), ...membershipsByPlayer.keys()])].filter(Boolean).sort();
    const details = [];
    for (const playerId of playerIds) {
        const player = playersById.get(playerId) || null;
        const history = membershipsByPlayer.get(playerId) || [];
        const active = history.filter((row) => normalizeStatus(row.status) === 'active');
        const membershipEventsForPlayer = eventsByPlayer.get(playerId) || [];
        const lifecycle = lifecycleByPlayer.get(playerId) || [];
        const transitionRows = transitionsByPlayer.get(playerId) || [];
        const legacyNeutral = neutralLegacy(player?.esquadrao);
        const legacy = legacyNeutral ? null : squadsByAlias.get(normalizeSquadKey(player?.esquadrao));
        const lifecycleStatus = normalizeStatus(player?.lifecycle_status || 'active');
        const explicitDeparture = history.some((row) => ['removed', 'transferred'].includes(normalizeStatus(row.status)))
            || membershipEventsForPlayer.some((event) => ['removed', 'transferred'].includes(normalizeStatus(event.action)));
        const incompatibleTransition = transitionRows.some((row) => !['completed', 'reversed'].includes(normalizeStatus(row.status)));
        const base = {
            player_exists: Boolean(player),
            no_duplicate_active: active.length <= 1,
            no_explicit_departure: !explicitDeparture,
            no_incompatible_transition: !incompatibleTransition,
        };

        if (!player || active.length > 1) {
            details.push(action({
                playerId,
                classification: CLASSIFICATION.BLOCKED_INVALID_STATE,
                reasonCode: !player ? 'CANONICAL_PLAYER_MISSING' : 'DUPLICATE_ACTIVE_MEMBERSHIP',
                preconditions: base,
            }));
            continue;
        }

        if (active.length === 1 && lifecycleStatus === 'archived' && legacyNeutral) {
            const membership = active[0];
            const canonical = squadsByAlias.get(normalizeSquadKey(membership.squad_key));
            const latestLifecycle = lifecycle[lifecycle.length - 1] || null;
            const preconditions = {
                ...base,
                exactly_one_active_membership: true,
                legacy_projection_neutral: true,
                lifecycle_archived: true,
                canonical_squad_valid: Boolean(canonical),
                final_lifecycle_event_is_archive: latestLifecycle?.operation_type === 'archive',
                archive_event_after_join: eventAfterJoin(lifecycle, membership.joined_at),
                no_reactivation_after_final_archive: latestLifecycle?.operation_type === 'archive',
            };
            const safe = Object.values(preconditions).every(Boolean);
            details.push(action({
                playerId,
                classification: safe ? CLASSIFICATION.ARCHIVE_END_MEMBERSHIP : CLASSIFICATION.MANUAL_REVIEW,
                reasonCode: safe ? 'ARCHIVED_PLAYER_ACTIVE_MEMBERSHIP' : 'ARCHIVE_MEMBERSHIP_PRECONDITION_FAILED',
                preconditions,
                membershipId: membership.id,
                squadKey: canonical?.canonical_key || null,
            }));
            continue;
        }

        if (active.length === 0 && !legacyNeutral) {
            const preconditions = {
                ...base,
                zero_active_memberships: true,
                legacy_squad_valid: Boolean(legacy),
                lifecycle_active: lifecycleStatus === 'active',
                sheet_approved: normalizeStatus(player?.ficha_status) === 'aprovada',
                game_released: normalizeStatus(player?.jogo_status) === 'liberado',
                legacy_only_campaign_state: history.length === 0 && membershipEventsForPlayer.length === 0,
            };
            if (!legacy) {
                details.push(action({
                    playerId,
                    classification: CLASSIFICATION.BLOCKED_INVALID_STATE,
                    reasonCode: 'UNKNOWN_LEGACY_SQUAD',
                    preconditions,
                }));
                continue;
            }
            const safe = Object.values(preconditions).every(Boolean);
            details.push(action({
                playerId,
                classification: safe ? CLASSIFICATION.LEGACY_GRANDFATHER : CLASSIFICATION.MANUAL_REVIEW,
                reasonCode: safe ? 'ACTIVE_LEGACY_ONLY_GRANDFATHER' : 'LEGACY_GRANDFATHER_PRECONDITION_FAILED',
                preconditions,
                squadKey: legacy.canonical_key,
            }));
        }
    }

    const aggregate = {
        planner_default: 'DRY_RUN',
        campaign: CAMPAIGN,
        authority_source: AUTHORITY_SOURCE,
        archive_end_membership: details.filter((item) => item.classification === CLASSIFICATION.ARCHIVE_END_MEMBERSHIP).length,
        legacy_grandfather: details.filter((item) => item.classification === CLASSIFICATION.LEGACY_GRANDFATHER).length,
        manual_review: details.filter((item) => item.classification === CLASSIFICATION.MANUAL_REVIEW).length,
        blocked_invalid_state: details.filter((item) => item.classification === CLASSIFICATION.BLOCKED_INVALID_STATE).length,
        safe_actions_total: details.filter((item) => [CLASSIFICATION.ARCHIVE_END_MEMBERSHIP, CLASSIFICATION.LEGACY_GRANDFATHER].includes(item.classification)).length,
        reason_counts: reasonCounts(details),
    };
    return { aggregate, details, actions: details.filter((item) => [CLASSIFICATION.ARCHIVE_END_MEMBERSHIP, CLASSIFICATION.LEGACY_GRANDFATHER].includes(item.classification)) };
}

function redactedPlan(plan) {
    return { ...plan.aggregate };
}

function redactedAudit(audit) {
    const { examples, ...aggregate } = audit;
    return aggregate;
}

function parseArgs(argv) {
    const dbIndexes = argv.map((value, index) => value === '--db' ? index : -1).filter((index) => index >= 0);
    if (dbIndexes.length !== 1 || !argv[dbIndexes[0] + 1] || String(argv[dbIndexes[0] + 1]).startsWith('--')) {
        throw new Error('Usage: node scripts/planSquadPolicyRepair.js --db <explicit.sqlite> [--apply --non-live-copy-confirmed]');
    }
    const apply = argv.includes('--apply');
    const confirmed = argv.includes('--non-live-copy-confirmed');
    if (apply !== confirmed) throw new Error('Apply requires both --apply and --non-live-copy-confirmed.');
    return { filename: path.resolve(argv[dbIndexes[0] + 1]), apply };
}

function assertApplyTarget(filename) {
    const resolved = path.resolve(filename);
    if (resolved === LIVE_RUNTIME_PATH || path.basename(resolved).toLowerCase() === 'banco.sqlite') throw new Error('Refusing known live runtime database.');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Apply target must be an existing regular file.');
    if (!DISPOSABLE_NAME.test(path.basename(resolved))) throw new Error('Apply target must use the disposable campaign filename marker.');
    if (fs.existsSync(`${resolved}-wal`) || fs.existsSync(`${resolved}-shm`)) throw new Error('Apply target with WAL/SHM sidecars is not accepted.');
}

function sidecarState(filename) {
    return ['-wal', '-shm'].map((suffix) => {
        const sidecar = `${filename}${suffix}`;
        return { suffix, sidecar, exists: fs.existsSync(sidecar), bytes: fs.existsSync(sidecar) ? fs.statSync(sidecar).size : 0 };
    });
}

function removeReadOnlySidecarsCreatedHere(filename, before) {
    for (const state of sidecarState(filename)) {
        const previous = before.find((item) => item.suffix === state.suffix);
        if (previous?.exists || !state.exists) continue;
        if (state.suffix === '-wal' && state.bytes !== 0) throw new Error('Read-only inspection unexpectedly produced a non-empty WAL sidecar.');
        fs.unlinkSync(state.sidecar);
    }
}

async function openReadOnlyDatabase(filename) {
    if (!fs.existsSync(filename)) throw new Error(`Database snapshot not found: ${filename}`);
    const uri = pathToFileURL(path.resolve(filename));
    uri.searchParams.set('immutable', '1');
    return open({ filename: uri.href, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI });
}

async function openWritableDisposable(filename) {
    assertApplyTarget(filename);
    return open({ filename, driver: sqlite3.Database });
}

async function writeMembershipEvent(db, { membershipId, squadKey, playerId, action, actorId = 'system:phase3-f3f1', reason, metadata }) {
    await db.run(
        `INSERT INTO clover_squad_membership_events
         (membership_id, squad_key, player_id, action, performed_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [membershipId, squadKey, playerId, action, actorId, reason, JSON.stringify(metadata)]
    );
}

async function applyPlanActionsInCurrentTransaction(db, plan, options = {}) {
    const actorId = options.actorId || 'system:phase3-f3f1';
    const repairCampaign = options.repairCampaign || CAMPAIGN;
    const grandfatherCampaign = options.grandfatherCampaign || CAMPAIGN;
    const applied = [];
    for (const item of plan.actions) {
            if (item.classification === CLASSIFICATION.ARCHIVE_END_MEMBERSHIP) {
                const current = await db.get('SELECT * FROM clover_squad_memberships WHERE id = ? AND player_id = ? AND status = \'active\'', [item.membership_id, item.player_id]);
                if (!current) throw new Error('Archive membership action became stale; transaction rolled back.');
                const metadata = { ...safeJson(current.metadata_json), policy_repair: { source: 'phase3_archive_membership_end', campaign: repairCampaign } };
                const changed = await db.run(
                    `UPDATE clover_squad_memberships
                     SET status = 'archived', ended_at = CURRENT_TIMESTAMP,
                         changed_by = ?,
                         reason = 'Phase 3 policy repair: archive ends active membership',
                         metadata_json = ?
                     WHERE id = ? AND player_id = ? AND status = 'active'`,
                    [actorId, JSON.stringify(metadata), item.membership_id, item.player_id]
                );
                if (Number(changed.changes || 0) !== 1) throw new Error('Archive membership write precondition failed; transaction rolled back.');
                await writeMembershipEvent(db, {
                    membershipId: item.membership_id,
                    squadKey: item.squad_key,
                    playerId: item.player_id,
                    action: 'removed',
                    actorId,
                    reason: 'Phase 3 policy repair: archive ends active membership',
                    metadata: { source: 'phase3_archive_membership_end', campaign: repairCampaign, membership_status: 'archived' },
                });
            } else if (item.classification === CLASSIFICATION.LEGACY_GRANDFATHER) {
                const inserted = await db.run(
                    `INSERT INTO clover_squad_memberships
                     (squad_key, player_id, status, changed_by, reason, metadata_json)
                     VALUES (?, ?, 'active', ?, ?, ?)`,
                    [
                        item.squad_key,
                        item.player_id,
                        actorId,
                        'Phase 3 one-time legacy grandfather canonicalization',
                        JSON.stringify({ source: 'phase3_legacy_grandfather', campaign: grandfatherCampaign, legacy_projection_preserved: true }),
                    ]
                );
                await writeMembershipEvent(db, {
                    membershipId: inserted.lastID,
                    squadKey: item.squad_key,
                    playerId: item.player_id,
                    action: 'added',
                    actorId,
                    reason: 'Phase 3 one-time legacy grandfather canonicalization',
                    metadata: { source: 'phase3_legacy_grandfather', campaign: grandfatherCampaign, kind: 'MIGRATION_GRANDFATHER', legacy_projection_preserved: true },
                });
            }
            applied.push(item);
    }
    return { applied, plan };
}

async function applyPlan(db) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const plan = await buildPlan(db);
        const result = await applyPlanActionsInCurrentTransaction(db, plan);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function main(argv = process.argv.slice(2)) {
    const { filename, apply } = parseArgs(argv);
    if (apply) assertApplyTarget(filename);
    const initialReadSidecars = sidecarState(filename);
    const readDb = await openReadOnlyDatabase(filename);
    let before;
    let plan;
    try {
        before = redactedAudit(await auditSquadMembershipDivergence(readDb, { exampleLimit: 0 }));
        plan = await buildPlan(readDb);
        if (!apply) return { mode: 'DRY_RUN', before, plan: redactedPlan(plan) };
    } finally {
        await readDb.close();
        removeReadOnlySidecarsCreatedHere(filename, initialReadSidecars);
    }
    if (!plan.actions.length) return { mode: 'DISPOSABLE_APPLY', before, applied_actions: 0, plan: redactedPlan(plan), after: before };
    const initialWriteSidecars = sidecarState(filename);
    const writeDb = await openWritableDisposable(filename);
    try {
        const result = await applyPlan(writeDb);
        const after = redactedAudit(await auditSquadMembershipDivergence(writeDb, { exampleLimit: 0 }));
        return { mode: 'DISPOSABLE_APPLY', before, applied_actions: result.applied.length, plan: redactedPlan(result.plan), after };
    } finally {
        await writeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => null);
        await writeDb.close();
        removeReadOnlySidecarsCreatedHere(filename, initialWriteSidecars);
    }
}

if (require.main === module) {
    main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { AUTHORITY_SOURCE, CAMPAIGN, CLASSIFICATION, DISPOSABLE_NAME, LIVE_RUNTIME_PATH, applyPlan, applyPlanActionsInCurrentTransaction, assertApplyTarget, buildPlan, main, openReadOnlyDatabase, parseArgs, redactedAudit, redactedPlan, removeReadOnlySidecarsCreatedHere, sidecarState };
