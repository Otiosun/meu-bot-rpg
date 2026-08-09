'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const RPG_TIME_ZONE = 'America/Sao_Paulo';

function argValue(name) {
    const prefix = `--${name}=`;
    const item = process.argv.find((arg) => arg.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function parseStoredUtcTimestamp(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const parsed = new Date(`${text}T15:00:00Z`);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) {
        const normalized = text.replace(' ', 'T');
        const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}$/.test(normalized)
            ? `${normalized}:00`
            : normalized;
        const parsed = new Date(`${withSeconds}Z`);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function weekKeyForScene(value) {
    const instant = parseStoredUtcTimestamp(value);
    if (!instant) return null;
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: RPG_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const civil = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12, 0, 0));
    const sinceMonday = (civil.getUTCDay() + 6) % 7;
    civil.setUTCDate(civil.getUTCDate() - sinceMonday);
    return `${civil.getUTCFullYear()}-${pad2(civil.getUTCMonth() + 1)}-${pad2(civil.getUTCDate())}`;
}

async function tableExists(db, name) {
    const row = await db.get(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [name]
    );
    return Boolean(row?.present);
}

async function scalar(db, sql, params = []) {
    const row = await db.get(sql, params);
    if (!row) return 0;
    return Number(Object.values(row)[0] || 0);
}

async function settingValue(db, key) {
    if (!await tableExists(db, 'clover_settings')) return null;
    const row = await db.get('SELECT value FROM clover_settings WHERE key = ?', [key]);
    return row?.value ?? null;
}

async function inspectWeeklyRepair(db) {
    if (!await tableExists(db, 'clover_quick_evaluations')) {
        return { tableExists: false, total: 0, repairCandidates: 0, invalidSceneEvidence: 0 };
    }

    const rows = await db.all(
        `SELECT scene_sent_at, week_key
         FROM clover_quick_evaluations
         ORDER BY id ASC`
    );
    let repairCandidates = 0;
    let invalidSceneEvidence = 0;
    for (const row of rows) {
        const expected = weekKeyForScene(row.scene_sent_at);
        if (!expected) {
            invalidSceneEvidence += 1;
            continue;
        }
        if (String(row.week_key || '') !== expected) repairCandidates += 1;
    }

    return {
        tableExists: true,
        total: rows.length,
        repairCandidates,
        invalidSceneEvidence,
        mondayRule: await settingValue(db, 'quick_evaluation_week_key_rule'),
        repairRule: await settingValue(db, 'quick_evaluation_week_key_repair'),
    };
}

async function inspectSeasons(db) {
    if (!await tableExists(db, 'clover_squad_seasons')) {
        return {
            tableExists: false,
            total: 0,
            active: 0,
            invalidWindows: 0,
            overlappingPairs: 0,
            closedWithoutEnd: 0,
            windows: [],
        };
    }

    const windows = await db.all(
        `SELECT season_id, status, starts_at, ends_at
         FROM clover_squad_seasons
         ORDER BY CASE WHEN starts_at IS NULL THEN 0 ELSE 1 END, datetime(starts_at), season_id`
    );
    const invalidWindows = await scalar(
        db,
        `SELECT COUNT(*)
         FROM clover_squad_seasons
         WHERE (starts_at IS NOT NULL AND datetime(starts_at) IS NULL)
            OR (ends_at IS NOT NULL AND datetime(ends_at) IS NULL)
            OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND datetime(starts_at) >= datetime(ends_at))`
    );
    const overlappingPairs = await scalar(
        db,
        `SELECT COUNT(*)
         FROM clover_squad_seasons a
         JOIN clover_squad_seasons b ON a.rowid < b.rowid
         WHERE a.status IN ('active', 'closed')
           AND b.status IN ('active', 'closed')
           AND (a.ends_at IS NULL OR b.starts_at IS NULL OR datetime(b.starts_at) < datetime(a.ends_at))
           AND (b.ends_at IS NULL OR a.starts_at IS NULL OR datetime(a.starts_at) < datetime(b.ends_at))`
    );

    return {
        tableExists: true,
        total: windows.length,
        active: windows.filter((row) => row.status === 'active').length,
        invalidWindows,
        overlappingPairs,
        closedWithoutEnd: windows.filter((row) => row.status === 'closed' && !row.ends_at).length,
        // Season IDs/windows are system metadata, not player data.
        windows,
    };
}

async function inspectQuickEvaluationStars(db) {
    const hasLedger = await tableExists(db, 'clover_squad_star_ledger');
    const hasQuick = await tableExists(db, 'clover_quick_evaluations');
    const hasNative = await tableExists(db, 'clover_squad_star_transactions');
    if (!hasLedger || !hasQuick) {
        return {
            available: false,
            legacyQuickEvaluationStarRows: 0,
            duplicateLegacyEvaluationIds: 0,
            quickEvaluationStarsWithoutLegacyLedger: 0,
            legacyRowsWithoutQuickEvaluation: 0,
            amountMismatches: 0,
            missingSceneEvidence: 0,
            nativeQuickEvaluationTransactions: hasNative ? 0 : null,
            missingNativeTransactions: null,
        };
    }

    const legacyFilter = `source = 'ficha_avaliacao' AND kind = 'ganho' AND evaluation_id IS NOT NULL AND amount > 0`;
    const legacyQuickEvaluationStarRows = await scalar(
        db,
        `SELECT COUNT(*) FROM clover_squad_star_ledger WHERE ${legacyFilter}`
    );
    const duplicateLegacyEvaluationIds = await scalar(
        db,
        `SELECT COUNT(*) FROM (
            SELECT evaluation_id
            FROM clover_squad_star_ledger
            WHERE ${legacyFilter}
            GROUP BY evaluation_id
            HAVING COUNT(*) > 1
        )`
    );
    const quickEvaluationStarsWithoutLegacyLedger = await scalar(
        db,
        `SELECT COUNT(*)
         FROM clover_quick_evaluations q
         WHERE COALESCE(q.stars_amount, 0) > 0
           AND NOT EXISTS (
               SELECT 1 FROM clover_squad_star_ledger l
               WHERE l.evaluation_id = q.id
                 AND l.source = 'ficha_avaliacao'
                 AND l.kind = 'ganho'
           )`
    );
    const legacyRowsWithoutQuickEvaluation = await scalar(
        db,
        `SELECT COUNT(*)
         FROM clover_squad_star_ledger l
         LEFT JOIN clover_quick_evaluations q ON q.id = l.evaluation_id
         WHERE l.${legacyFilter.replaceAll(' AND ', ' AND l.')}
           AND q.id IS NULL`
    );
    const amountMismatches = await scalar(
        db,
        `SELECT COUNT(*)
         FROM clover_squad_star_ledger l
         JOIN clover_quick_evaluations q ON q.id = l.evaluation_id
         WHERE l.source = 'ficha_avaliacao'
           AND l.kind = 'ganho'
           AND l.evaluation_id IS NOT NULL
           AND l.amount > 0
           AND CAST(COALESCE(q.stars_amount, 0) AS INTEGER) <> CAST(l.amount AS INTEGER)`
    );
    const missingSceneEvidence = await scalar(
        db,
        `SELECT COUNT(*)
         FROM clover_squad_star_ledger l
         JOIN clover_quick_evaluations q ON q.id = l.evaluation_id
         WHERE l.source = 'ficha_avaliacao'
           AND l.kind = 'ganho'
           AND l.evaluation_id IS NOT NULL
           AND l.amount > 0
           AND (q.scene_sent_at IS NULL OR TRIM(q.scene_sent_at) = '')`
    );

    let nativeQuickEvaluationTransactions = null;
    let missingNativeTransactions = null;
    if (hasNative) {
        nativeQuickEvaluationTransactions = await scalar(
            db,
            `SELECT COUNT(*)
             FROM clover_squad_star_transactions
             WHERE source = 'ficha_avaliacao' AND kind = 'grant'`
        );
        missingNativeTransactions = await scalar(
            db,
            `SELECT COUNT(*)
             FROM clover_squad_star_ledger l
             WHERE l.source = 'ficha_avaliacao'
               AND l.kind = 'ganho'
               AND l.evaluation_id IS NOT NULL
               AND l.amount > 0
               AND NOT EXISTS (
                   SELECT 1
                   FROM clover_squad_star_transactions t
                   WHERE t.transaction_key = 'quick-evaluation:squad-stars:' || CAST(l.evaluation_id AS TEXT)
               )`
        );
    }

    return {
        available: true,
        legacyQuickEvaluationStarRows,
        duplicateLegacyEvaluationIds,
        quickEvaluationStarsWithoutLegacyLedger,
        legacyRowsWithoutQuickEvaluation,
        amountMismatches,
        missingSceneEvidence,
        nativeQuickEvaluationTransactions,
        missingNativeTransactions,
    };
}

async function main() {
    const repoRoot = path.resolve(argValue('repo') || process.cwd());
    const dbPath = path.resolve(argValue('db') || path.join(repoRoot, 'banco.sqlite'));
    const outputPath = path.resolve(
        argValue('output') || path.join(os.tmpdir(), 'player-stability-live-preflight-sanitized.json')
    );

    if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
        throw new Error('Repo invalido: package.json nao encontrado.');
    }
    if (!fs.existsSync(dbPath)) {
        throw new Error('Banco informado nao existe.');
    }

    const repoRequire = createRequire(path.join(repoRoot, 'package.json'));
    const sqlite3 = repoRequire('sqlite3');
    const { open } = repoRequire('sqlite');
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        await db.exec('PRAGMA busy_timeout = 5000');
        const quickCheckRow = await db.get('PRAGMA quick_check');
        const quickCheck = quickCheckRow ? Object.values(quickCheckRow)[0] : null;
        const foreignKeyViolations = (await db.all('PRAGMA foreign_key_check')).length;

        const report = {
            generatedAt: new Date().toISOString(),
            safety: {
                databaseMode: 'readonly',
                queryOnly: true,
                rowsWithPlayerIdentityEmitted: false,
                pm2Touched: false,
                checkoutChanged: false,
            },
            integrity: {
                quickCheck,
                foreignKeyViolations,
            },
            weekly: await inspectWeeklyRepair(db),
            seasons: await inspectSeasons(db),
            quickEvaluationStars: await inspectQuickEvaluationStars(db),
        };

        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`PREFLIGHT_OUTPUT=${outputPath}`);
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(`[player-stability-preflight] ${error?.message || error}`);
    process.exitCode = 1;
});
