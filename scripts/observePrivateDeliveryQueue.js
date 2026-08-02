'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const { observeDeliveryJobs } = require('../helpers/clover/privateDeliveryObserver');

function argumentValue(name, fallback = null) {
    const prefix = `--${name}=`;
    const entry = process.argv.find((value) => value.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : fallback;
}

function openReadOnlyDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, (error) => {
            if (error) reject(error);
            else resolve(db);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function close(db) {
    return new Promise((resolve, reject) => {
        db.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function safeLimit(value) {
    const parsed = Number(value || 5000);
    if (!Number.isFinite(parsed)) return 5000;
    return Math.max(1, Math.min(20000, Math.floor(parsed)));
}

async function readQueue(db, limit) {
    const table = await all(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clover_delivery_jobs'"
    );
    if (!table.length) return { tableMissing: true, rows: [] };

    const rows = await all(
        db,
        `SELECT
             id,
             kind,
             target_jid,
             payload_json,
             status,
             priority,
             attempts,
             max_attempts,
             run_after,
             locked_at,
             locked_by,
             created_by,
             created_at,
             updated_at,
             category,
             dedupe_key
         FROM clover_delivery_jobs
         ORDER BY id DESC
         LIMIT ?`,
        [limit]
    );
    return { tableMissing: false, rows };
}

async function main() {
    const root = path.resolve(argumentValue('root', process.cwd()));
    const dbPath = path.resolve(argumentValue('db', path.join(root, 'banco.sqlite')));
    const outputValue = argumentValue('output');
    const outputPath = outputValue ? path.resolve(outputValue) : null;
    const limit = safeLimit(argumentValue('limit'));

    if (!fs.existsSync(dbPath)) {
        throw new Error(`Banco nao encontrado: ${dbPath}`);
    }

    const before = fs.statSync(dbPath);
    let db;
    let observed;
    let tableMissing = false;
    try {
        db = await openReadOnlyDatabase(dbPath);
        const queue = await readQueue(db, limit);
        tableMissing = queue.tableMissing;
        observed = observeDeliveryJobs(queue.rows, { env: {} });
    } finally {
        if (db) await close(db);
    }

    const after = fs.statSync(dbPath);
    const report = {
        ...observed,
        database: {
            filename: path.basename(dbPath),
            tableMissing,
            requestedLimit: limit,
            sizeBefore: before.size,
            sizeAfter: after.size,
            modifiedBefore: before.mtime.toISOString(),
            modifiedAfter: after.mtime.toISOString(),
            unchanged: before.size === after.size && before.mtimeMs === after.mtimeMs,
        },
        guarantees: {
            sqliteOpenMode: 'OPEN_READONLY',
            claimsPerformed: 0,
            updatesPerformed: 0,
            messagesSent: 0,
            whatsappStarted: false,
        },
    };

    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        if (fs.existsSync(outputPath)) {
            throw new Error(`Arquivo de saida ja existe: ${outputPath}`);
        }
        fs.writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
        console.log('[pv-delivery-observe] relatorio:', outputPath);
    } else {
        process.stdout.write(serialized);
    }

    console.log('[pv-delivery-observe] concluido:', {
        tableMissing,
        total: report.summary.total,
        eligible: report.summary.eligible,
        policyBlocked: report.summary.policyBlocked,
        expired: report.summary.expired,
        staleProcessing: report.summary.staleProcessing,
        duplicates: report.summary.duplicateDedupeKeyCount,
        databaseUnchanged: report.database.unchanged,
    });
}

main().catch((error) => {
    console.error('[pv-delivery-observe] falha:', error?.message || error);
    process.exitCode = 1;
});
