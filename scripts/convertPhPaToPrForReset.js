'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    DEFAULT_CONVERSION_KEY,
    applyPrResetConversion,
    previewPrResetConversion,
} = require('../helpers/clover/prResetConversionService');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const APPLY_CONFIRMATION = 'APPLY_PR_RESET_CONVERSION';

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

async function checkpointDatabase() {
    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
    try {
        await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        await db.close();
    }
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

async function createBackup(runStamp) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `before-pr-reset-conversion-${runStamp}.sqlite`);
    try {
        fs.copyFileSync(DATABASE_PATH, backupPath);
        return backupPath;
    } catch (error) {
        if (error?.code !== 'ENOSPC') throw error;
        const gzipPath = `${backupPath}.gz`;
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
        await gzipFile(DATABASE_PATH, gzipPath);
        return gzipPath;
    }
}

function renderResult(result, { applied = false, backupPath = null } = {}) {
    console.log(applied ? '\n=== CONVERSAO PH/PA -> PR APLICADA ===' : '\n=== PREVIEW CONVERSAO PH/PA -> PR ===');
    console.log(`Chave: ${result.conversionKey || DEFAULT_CONVERSION_KEY}`);
    if (result.duplicate) console.log('Status: ja aplicada; nada foi duplicado.');
    if (backupPath) console.log(`Backup: ${backupPath}`);
    console.log(`Players: ${formatNumber(result.totals.players)}`);
    console.log(`PH convertido: ${formatNumber(result.totals.ph)}`);
    console.log(`PA pendente convertido: ${formatNumber(result.totals.pa)}`);
    console.log(`PR total creditado: ${formatNumber(result.totals.pr)}`);

    const rows = Array.isArray(result.players) ? result.players : [];
    if (rows.length) {
        console.log('\nTop 20 por PR:');
        for (const row of [...rows].sort((a, b) => Number(b.pr || 0) - Number(a.pr || 0)).slice(0, 20)) {
            console.log(`- ${row.characterName || row.playerId}: ${formatNumber(row.pr)} PR (${formatNumber(row.ph)} PH + ${formatNumber(row.pa)} PA)`);
        }
    }
}

async function main() {
    const apply = hasFlag('apply');
    const confirm = argValue('confirm');
    const conversionKey = argValue('key') || DEFAULT_CONVERSION_KEY;
    const createdBy = argValue('by') || 'system:pr-reset-conversion';

    if (!fs.existsSync(DATABASE_PATH)) {
        throw new Error(`Banco nao encontrado: ${DATABASE_PATH}`);
    }

    if (apply && confirm !== APPLY_CONFIRMATION) {
        throw new Error(`Para aplicar, use --apply --confirm=${APPLY_CONFIRMATION}`);
    }

    if (!apply) {
        const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
        try {
            const result = await previewPrResetConversion(db, { conversionKey });
            renderResult(result);
            console.log(`\nPara aplicar: node scripts/convertPhPaToPrForReset.js --apply --confirm=${APPLY_CONFIRMATION} --key=${conversionKey}`);
        } finally {
            await db.close();
        }
        return;
    }

    const runStamp = stamp();
    await checkpointDatabase();
    const backupPath = await createBackup(runStamp);
    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
    try {
        const result = await applyPrResetConversion(db, { conversionKey, createdBy });
        renderResult(result, { applied: true, backupPath });
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NA CONVERSAO:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
