'use strict';

// Deliberately a tooling-only reconciliation planner. It never creates or edits
// canonical memberships: active clover_squad_memberships remains the authority.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { normalizeSquadKey } = require('../helpers/clover/cavalierService');
const { auditSquadMembershipDivergence } = require('../helpers/clover/squadMembershipDivergenceAudit');

const CLASSIFICATION = Object.freeze({
    SAFE_AUTO: 'SAFE_AUTO',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    BLOCKED_INVALID_STATE: 'BLOCKED_INVALID_STATE',
});
const AUTHORITY_SOURCE = 'clover_squad_memberships.active';
const OPERATION_TYPE = 'project_canonical_membership_to_legacy';
const LIVE_RUNTIME_PATH = path.resolve(__dirname, '..', 'banco.sqlite');
const DISPOSABLE_NAME = /^clover-f3-disposable-reconciliation-[a-z0-9_-]+\.sqlite$/i;

function neutralLegacy(value) {
    return ['', '-', 'nenhum', 'n/a', 'na', 'null', 'undefined'].includes(String(value ?? '').trim().toLowerCase());
}

function normalizedPlayerId(value) {
    return String(value ?? '').trim() || null;
}

function reasonCounts(details) {
    return details.reduce((counts, detail) => {
        counts[detail.reason_code] = (counts[detail.reason_code] || 0) + 1;
        return counts;
    }, {});
}

async function requireTables(db) {
    const required = ['jogadores', 'clover_squads', 'clover_squad_memberships'];
    const rows = await db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => '?').join(', ')})`, required);
    const found = new Set(rows.map((row) => row.name));
    const missing = required.filter((name) => !found.has(name));
    if (missing.length) throw new Error(`Squad reconciliation requires: ${missing.join(', ')}`);
}

async function playerColumns(db) {
    const rows = await db.all('PRAGMA table_info(jogadores)');
    return new Set(rows.map((row) => row.name));
}

function action({ playerId, before, after, classification, reasonCode, preconditions, operationType = OPERATION_TYPE }) {
    return {
        // player_id is intentionally raw-only. Do not serialize details to evidence.
        player_id: playerId,
        classification,
        reason_code: reasonCode,
        before_classification: before,
        intended_after_classification: after,
        authority_source: AUTHORITY_SOURCE,
        preconditions_verified: preconditions,
        operation_type: operationType,
    };
}

async function buildPlan(db) {
    await requireTables(db);
    const columns = await playerColumns(db);
    const playerSelect = ['id', 'esquadrao'];
    if (columns.has('lifecycle_status')) playerSelect.push('lifecycle_status');
    const [players, squads, memberships] = await Promise.all([
        db.all(`SELECT ${playerSelect.join(', ')} FROM jogadores ORDER BY id`),
        db.all('SELECT squad_key, name, captain_player_id, vice_captain_player_id FROM clover_squads ORDER BY squad_key'),
        db.all('SELECT id, player_id, squad_key, status FROM clover_squad_memberships ORDER BY player_id, id'),
    ]);
    const playersById = new Map(players.map((row) => [normalizedPlayerId(row.id), row]));
    const squadsByKey = new Map(squads.map((row) => [normalizeSquadKey(row.squad_key), row]).filter(([key]) => key));
    const activeByPlayer = new Map();
    const historyByPlayer = new Map();
    for (const membership of memberships) {
        const playerId = normalizedPlayerId(membership.player_id);
        if (!playerId) continue;
        if (!historyByPlayer.has(playerId)) historyByPlayer.set(playerId, []);
        historyByPlayer.get(playerId).push(membership);
        if (membership.status === 'active') {
            if (!activeByPlayer.has(playerId)) activeByPlayer.set(playerId, []);
            activeByPlayer.get(playerId).push(membership);
        }
    }
    const ids = [...new Set([...playersById.keys(), ...historyByPlayer.keys()])].filter(Boolean).sort();
    const details = [];
    for (const playerId of ids) {
        const player = playersById.get(playerId);
        const active = activeByPlayer.get(playerId) || [];
        const history = historyByPlayer.get(playerId) || [];
        const legacyNeutral = neutralLegacy(player?.esquadrao);
        const legacyKey = legacyNeutral ? null : normalizeSquadKey(player?.esquadrao);
        const normalizedActive = active.map((row) => normalizeSquadKey(row.squad_key));
        const distinctActive = [...new Set(normalizedActive.filter(Boolean))];
        const canonicalKey = distinctActive.length === 1 ? distinctActive[0] : null;
        const validCanonical = canonicalKey && squadsByKey.has(canonicalKey);
        const validLegacy = legacyKey === null || squadsByKey.has(legacyKey);
        const lifecycleSafe = !player?.lifecycle_status || String(player.lifecycle_status).trim() === '' || String(player.lifecycle_status).trim() === 'active';
        const leadership = validCanonical ? squadsByKey.get(canonicalKey) : null;
        const leadershipSafe = !leadership || (
            (!leadership.captain_player_id || normalizedPlayerId(leadership.captain_player_id) !== playerId || canonicalKey === normalizeSquadKey(leadership.squad_key))
            && (!leadership.vice_captain_player_id || normalizedPlayerId(leadership.vice_captain_player_id) !== playerId || canonicalKey === normalizeSquadKey(leadership.squad_key))
        );
        const preconditions = {
            player_exists: Boolean(player),
            exactly_one_active_membership: active.length === 1,
            canonical_squad_key_valid: Boolean(validCanonical),
            legacy_projection_neutral: legacyNeutral,
            no_second_active_membership: active.length <= 1,
            no_conflicting_representation: legacyKey === null || legacyKey === canonicalKey,
            lifecycle_safe: lifecycleSafe,
            captain_vice_safe: leadershipSafe,
            historical_blank_intent_absent: true,
            projection_only: true,
        };
        if (active.length > 1) {
            details.push(action({ playerId, classification: CLASSIFICATION.BLOCKED_INVALID_STATE, before: 'DUPLICATE_ACTIVE', after: 'UNCHANGED', reasonCode: 'DUPLICATE_ACTIVE_MEMBERSHIP', preconditions }));
        } else if (active.length === 1 && (!player || !validCanonical)) {
            details.push(action({ playerId, classification: CLASSIFICATION.BLOCKED_INVALID_STATE, before: 'INVALID_CANONICAL', after: 'UNCHANGED', reasonCode: !player ? 'CANONICAL_PLAYER_MISSING' : 'UNKNOWN_CANONICAL_SQUAD', preconditions }));
        } else if (active.length === 1 && legacyKey && !validLegacy) {
            details.push(action({ playerId, classification: CLASSIFICATION.BLOCKED_INVALID_STATE, before: 'INVALID_LEGACY', after: 'UNCHANGED', reasonCode: 'UNKNOWN_LEGACY_SQUAD', preconditions }));
        } else if (active.length === 1 && legacyKey && legacyKey !== canonicalKey) {
            details.push(action({ playerId, classification: CLASSIFICATION.BLOCKED_INVALID_STATE, before: 'MISMATCH', after: 'UNCHANGED', reasonCode: 'CONFLICTING_LEGACY_PROJECTION', preconditions }));
        } else if (active.length === 1 && legacyNeutral) {
            const safe = Object.values(preconditions).every(Boolean);
            details.push(action({ playerId, classification: safe ? CLASSIFICATION.SAFE_AUTO : CLASSIFICATION.MANUAL_REVIEW, before: 'CANONICAL_ONLY', after: 'MATCH', reasonCode: safe ? 'CANONICAL_PROJECTION_MISSING' : 'CANONICAL_PROJECTION_PRECONDITION_FAILED', preconditions }));
        } else if (active.length === 0 && legacyKey) {
            const reasonCode = !validLegacy
                ? 'UNKNOWN_LEGACY_SQUAD'
                : history.length ? 'INACTIVE_OR_DEPARTED_MEMBERSHIP' : 'AMBIGUOUS';
            details.push(action({ playerId, classification: !validLegacy ? CLASSIFICATION.BLOCKED_INVALID_STATE : CLASSIFICATION.MANUAL_REVIEW, before: 'LEGACY_ONLY', after: 'UNCHANGED', reasonCode, preconditions: { ...preconditions, canonical_history_absent: history.length === 0, legacy_only_never_promoted_by_inference: true }, operationType: 'manual_canonical_membership_evidence_required' }));
        }
    }
    const safe = details.filter((detail) => detail.classification === CLASSIFICATION.SAFE_AUTO);
    const manual = details.filter((detail) => detail.classification === CLASSIFICATION.MANUAL_REVIEW);
    const blocked = details.filter((detail) => detail.classification === CLASSIFICATION.BLOCKED_INVALID_STATE);
    const aggregate = {
        planner_default: 'DRY_RUN',
        authority_source: AUTHORITY_SOURCE,
        players_checked: ids.length,
        canonical_only_safe_auto: safe.filter((detail) => detail.before_classification === 'CANONICAL_ONLY').length,
        canonical_only_manual: manual.filter((detail) => detail.before_classification === 'CANONICAL_ONLY').length,
        legacy_only_safe_auto: safe.filter((detail) => detail.before_classification === 'LEGACY_ONLY').length,
        legacy_only_manual: manual.filter((detail) => detail.before_classification === 'LEGACY_ONLY').length,
        blocked_invalid_state: blocked.length,
        safe_actions_total: safe.length,
        manual_review_total: manual.length,
        reason_counts: reasonCounts(details),
    };
    return { aggregate, details, actions: safe };
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
        throw new Error('Usage: node scripts/planSquadMembershipReconciliation.js --db <explicit.sqlite> [--apply --non-live-copy-confirmed]');
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
        if (state.suffix === '-wal' && state.bytes !== 0) {
            throw new Error('Read-only inspection unexpectedly produced a non-empty WAL sidecar.');
        }
        fs.unlinkSync(state.sidecar);
    }
}

async function openReadOnlyDatabase(filename) {
    if (!fs.existsSync(filename)) throw new Error(`Database snapshot not found: ${filename}`);
    const immutableUri = pathToFileURL(path.resolve(filename));
    immutableUri.searchParams.set('immutable', '1');
    return open({
        filename: immutableUri.href,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
    });
}

async function openWritableDisposable(filename) {
    assertApplyTarget(filename);
    return open({ filename, driver: sqlite3.Database });
}

async function applyPlan(db) {
    const plan = await buildPlan(db);
    if (!plan.actions.length) return { applied: [], plan };
    const applied = [];
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const item of plan.actions) {
            const row = await db.get(
                `SELECT s.name FROM clover_squad_memberships m
                 JOIN clover_squads s ON s.squad_key = m.squad_key
                 WHERE m.player_id = ? AND m.status = 'active' ORDER BY m.id`, [item.player_id]
            );
            if (!row || !item.preconditions_verified.legacy_projection_neutral) throw new Error('Revalidation failed; refusing stale reconciliation action.');
            const result = await db.run(
                `UPDATE jogadores SET esquadrao = ?
                 WHERE id = ? AND LOWER(TRIM(COALESCE(esquadrao, ''))) IN ('', '-', 'nenhum', 'n/a', 'na', 'null', 'undefined')`,
                [row.name, item.player_id]
            );
            if (Number(result.changes) !== 1) throw new Error('Projection write precondition failed; transaction rolled back.');
            applied.push({ ...item, applied: true });
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    return { applied, plan };
}

async function main(argv = process.argv.slice(2)) {
    const { filename, apply } = parseArgs(argv);
    if (apply) assertApplyTarget(filename);
    const initialReadSidecars = sidecarState(filename);
    const readDb = await openReadOnlyDatabase(filename);
    let before;
    try {
        before = redactedAudit(await auditSquadMembershipDivergence(readDb, { exampleLimit: 0 }));
        const plan = await buildPlan(readDb);
        if (!apply) return { mode: 'DRY_RUN', before, plan: redactedPlan(plan) };
        if (!plan.actions.length) {
            return { mode: 'DISPOSABLE_APPLY', before, applied_actions: 0, plan: redactedPlan(plan), after: before };
        }
    } finally {
        await readDb.close();
        removeReadOnlySidecarsCreatedHere(filename, initialReadSidecars);
    }

    const writeDb = await openWritableDisposable(filename);
    try {
        const result = await applyPlan(writeDb);
        const after = redactedAudit(await auditSquadMembershipDivergence(writeDb, { exampleLimit: 0 }));
        return {
            mode: 'DISPOSABLE_APPLY',
            before,
            applied_actions: result.applied.length,
            plan: redactedPlan(result.plan),
            after,
        };
    } finally { await writeDb.close(); }
}

if (require.main === module) {
    main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { AUTHORITY_SOURCE, CLASSIFICATION, DISPOSABLE_NAME, LIVE_RUNTIME_PATH, OPERATION_TYPE, applyPlan, assertApplyTarget, buildPlan, main, openReadOnlyDatabase, parseArgs, redactedAudit, redactedPlan, removeReadOnlySidecarsCreatedHere, sidecarState };
