'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditSquadMembershipDivergence } = require('../helpers/clover/squadMembershipDivergenceAudit');
const {
    applyPlanActionsInCurrentTransaction,
    buildPlan,
    redactedAudit,
    redactedPlan,
} = require('./planSquadPolicyRepair');

const EXPECTED_MAIN = 'ccc1079920668cc4e4ff095c016f42a4ad0f7e00';
const REQUIRED_FLAG = '--execute-approved-f3g1-live-repair';
const EXPECTED_AUDIT = Object.freeze({
    players_checked: 627,
    match: 614,
    canonical_only: 4,
    legacy_only: 9,
    mismatch: 0,
    duplicate_active_memberships: 0,
    unknown_squad_keys: 0,
});
const EXPECTED_PLAN = Object.freeze({
    archive_end_membership: 4,
    legacy_grandfather: 9,
    manual_review: 0,
    blocked_invalid_state: 0,
    safe_actions_total: 13,
});

function argumentValue(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
}

function parseArgs(argv) {
    const db = argumentValue(argv, '--db');
    const backup = argumentValue(argv, '--pre-repair-backup');
    const sha256 = argumentValue(argv, '--pre-repair-sha256');
    const expectedMain = argumentValue(argv, '--expected-main');
    if (!db || !backup || !sha256 || expectedMain !== EXPECTED_MAIN || !argv.includes(REQUIRED_FLAG)) {
        throw new Error(`Usage requires --db, --pre-repair-backup, --pre-repair-sha256, --expected-main ${EXPECTED_MAIN}, and ${REQUIRED_FLAG}.`);
    }
    return { db: path.resolve(db), backup: path.resolve(backup), sha256: String(sha256).toLowerCase() };
}

function sha256File(filename) {
    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(filename);
    hash.update(data);
    return hash.digest('hex');
}

function resolveLiveDbPathFromPm2(jlistText = null) {
    const raw = jlistText === null
        ? execFileSync('pm2', ['jlist'], { encoding: 'utf8', windowsHide: true })
        : jlistText;
    const rows = JSON.parse(raw);
    const process = rows.find((row) => row?.name === 'clover-rpg' && row?.pm2_env?.status === 'online');
    const cwd = process?.pm2_env?.pm_cwd;
    if (!cwd) throw new Error('Unable to prove the online Clover runtime CWD from PM2.');
    const runtimeDb = path.join(cwd, 'banco.sqlite');
    if (!fs.existsSync(runtimeDb) || !fs.statSync(runtimeDb).isFile()) throw new Error('PM2 Clover runtime database is not an existing regular file.');
    return fs.realpathSync(runtimeDb);
}

async function inspectSqlite(filename) {
    const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        const quick = await db.get('PRAGMA quick_check');
        const integrity = await db.get('PRAGMA integrity_check');
        const foreign = await db.all('PRAGMA foreign_key_check');
        return {
            quick_check: Object.values(quick || {})[0] || null,
            integrity_check: Object.values(integrity || {})[0] || null,
            foreign_key_check: foreign.length,
        };
    } finally { await db.close(); }
}

function assertIntegrity(report, label) {
    if (report.quick_check !== 'ok' || report.integrity_check !== 'ok' || report.foreign_key_check !== 0) {
        throw new Error(`${label} integrity gate failed.`);
    }
}

function assertExact(actual, expected, label) {
    for (const [key, value] of Object.entries(expected)) {
        if (actual[key] !== value) throw new Error(`${label} expected ${key}=${value}, received ${actual[key]}.`);
    }
}

function playerDigest(rows) {
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function readPreflight(filename) {
    const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        const audit = redactedAudit(await auditSquadMembershipDivergence(db, { exampleLimit: 0 }));
        const plan = redactedPlan(await buildPlan(db));
        return { audit, plan };
    } finally { await db.close(); }
}

async function executeApprovedLiveRepair({ dbPath, backupPath, backupSha256, expectedLiveDbPath = null } = {}) {
    const target = fs.realpathSync(dbPath);
    const approved = expectedLiveDbPath || resolveLiveDbPathFromPm2();
    if (target !== approved) throw new Error('Refusing database path that is not the PM2 Clover runtime database.');
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) throw new Error('Pre-repair backup is not an existing regular file.');
    if (sha256File(backupPath) !== String(backupSha256).toLowerCase()) throw new Error('Pre-repair backup SHA-256 mismatch.');
    assertIntegrity(await inspectSqlite(backupPath), 'Pre-repair backup');

    const preflight = await readPreflight(target);
    assertExact(preflight.audit, EXPECTED_AUDIT, 'Live preflight audit');
    assertExact(preflight.plan, EXPECTED_PLAN, 'Live preflight plan');

    const db = await open({ filename: target, driver: sqlite3.Database });
    try {
        await db.exec('BEGIN IMMEDIATE');
        try {
            const auditBefore = redactedAudit(await auditSquadMembershipDivergence(db, { exampleLimit: 0 }));
            const planBefore = await buildPlan(db);
            assertExact(auditBefore, EXPECTED_AUDIT, 'In-transaction audit');
            assertExact(redactedPlan(planBefore), EXPECTED_PLAN, 'In-transaction plan');
            const playersBefore = await db.all('SELECT id, esquadrao, lifecycle_status, ficha_status, jogo_status FROM jogadores ORDER BY id');
            const result = await applyPlanActionsInCurrentTransaction(db, planBefore, {
                actorId: 'system:phase3-f3g1',
                repairCampaign: 'F3G1',
                grandfatherCampaign: 'F3F1',
            });
            if (result.applied.length !== 13) throw new Error('Live repair action count is not exactly 13.');
            const auditAfter = redactedAudit(await auditSquadMembershipDivergence(db, { exampleLimit: 0 }));
            const planAfter = redactedPlan(await buildPlan(db));
            assertExact(auditAfter, { ...EXPECTED_AUDIT, match: 627, canonical_only: 0, legacy_only: 0 }, 'In-transaction post audit');
            if (!auditAfter.safe_to_cutover) throw new Error('In-transaction post audit is not safe to cut over.');
            assertExact(planAfter, { archive_end_membership: 0, legacy_grandfather: 0, manual_review: 0, blocked_invalid_state: 0, safe_actions_total: 0 }, 'In-transaction second plan');
            const playersAfter = await db.all('SELECT id, esquadrao, lifecycle_status, ficha_status, jogo_status FROM jogadores ORDER BY id');
            if (playerDigest(playersBefore) !== playerDigest(playersAfter)) throw new Error('Player rows changed during approved Squad repair.');
            await db.exec('COMMIT');
            return { preflight, audit_after: auditAfter, plan_after: planAfter, applied_actions: result.applied.length, player_rows_changed: 0 };
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }
    } finally { await db.close(); }
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    return executeApprovedLiveRepair({ dbPath: args.db, backupPath: args.backup, backupSha256: args.sha256 });
}

if (require.main === module) {
    main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { EXPECTED_AUDIT, EXPECTED_MAIN, EXPECTED_PLAN, REQUIRED_FLAG, assertExact, executeApprovedLiveRepair, inspectSqlite, main, parseArgs, readPreflight, resolveLiveDbPathFromPm2, sha256File };
