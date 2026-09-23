'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    executePreresetGlobalReset,
} = require('../helpers/clover/preresetGlobalResetExecutorService');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const APPLY_CONFIRMATION = 'APPLY_PRERESET_GLOBAL_RESET';

function argValue(name) {
    const prefix = `--${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function gzipFile(sourcePath, destinationPath) {
    return new Promise((resolve, reject) => {
        const input = fs.createReadStream(sourcePath);
        const output = fs.createWriteStream(destinationPath);
        input.on('error', reject);
        output.on('error', reject);
        output.on('close', resolve);
        input.pipe(zlib.createGzip({ level: 9 })).pipe(output);
    });
}

async function checkpointDatabase(databasePath) {
    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    try {
        await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        await db.close();
    }
}

async function createBackup(databasePath, runStamp) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(
        BACKUP_DIR,
        `before-prereset-global-reset-${runStamp}.sqlite`
    );
    try {
        fs.copyFileSync(databasePath, backupPath);
        return backupPath;
    } catch (error) {
        if (error?.code !== 'ENOSPC') throw error;
        const gzipPath = `${backupPath}.gz`;
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
        await gzipFile(databasePath, gzipPath);
        return gzipPath;
    }
}

function renderResult(result, backupPath = null) {
    console.log(result.applied
        ? '\n=== RESET GLOBAL PRE-RESET APLICADO ==='
        : '\n=== DRY-RUN RESET GLOBAL PRE-RESET ===');
    console.log(`Campaign: ${result.plan.campaignKey}`);
    console.log(`Roster revision: ${result.plan.rosterRevision}`);
    console.log(`Roster hash: ${result.plan.rosterHash}`);
    console.log(`KEEP: ${formatNumber(result.plan.counts.keep)}`);
    console.log(`RESET: ${formatNumber(result.plan.counts.reset)}`);
    console.log(`TOTAL: ${formatNumber(result.plan.counts.total)}`);
    if (backupPath) console.log(`Backup: ${backupPath}`);
    console.log(`Aplicado: ${result.applied ? 'sim' : 'nao'}`);
    console.log(`Resetados: ${formatNumber(result.resetResults.length)}`);
    console.log('\nPreservacao verificada:');
    console.log(`- PR ledger rows: ${result.preservationAfter.returnPointsLedger.rows}`);
    console.log(`- PR ledger amount: ${result.preservationAfter.returnPointsLedger.amount}`);
    console.log(`- Purchases: ${result.preservationAfter.preresetPurchases.rows}`);
    console.log(`- Entitlements ativos: ${result.preservationAfter.preresetEntitlements.activeRows}`);
    console.log('\nAmostra RESET:');
    for (const playerId of result.plan.resetPlayerIds.slice(0, 20)) {
        console.log(`- ${playerId}`);
    }
}

async function main() {
    const databasePath = path.resolve(argValue('db') || DEFAULT_DB);
    const campaignKey = argValue('campaign') || 'mythic_launch_v1';
    const apply = hasFlag('apply');
    const confirm = argValue('confirm');
    const actorId = argValue('by') || 'system:prereset-global-reset';
    const reason = argValue('reason') || 'Reset global pre-reset';
    const operationPrefix = argValue('operation-prefix') || `RG-${stamp().slice(0, 10).replace(/-/g, '')}`;

    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco nao encontrado: ${databasePath}`);
    }
    if (apply && confirm !== APPLY_CONFIRMATION) {
        throw new Error(`Para aplicar, use --apply --confirm=${APPLY_CONFIRMATION}`);
    }

    let backupPath = null;
    if (apply) {
        await checkpointDatabase(databasePath);
        backupPath = await createBackup(databasePath, stamp());
    }

    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    try {
        const result = await executePreresetGlobalReset(db, {
            campaignKey,
            apply,
            actorId,
            reason,
            operationPrefix,
        });
        renderResult(result, backupPath);
        if (!apply) {
            console.log(`\nPara aplicar: node scripts/executePreresetGlobalReset.js --apply --confirm=${APPLY_CONFIRMATION} --campaign=${campaignKey}`);
        }
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO RESET GLOBAL PRE-RESET:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
