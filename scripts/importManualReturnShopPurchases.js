'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    importManualReturnShopPurchases,
} = require('../helpers/clover/prManualPurchaseImportService');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const APPLY_CONFIRMATION = 'IMPORT_RETURN_SHOP_MANUAL_PURCHASES';

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

function readEntries(filePath) {
    if (!filePath) {
        throw new Error('Informe --file=caminho/para/compras.json');
    }
    const absolutePath = path.resolve(filePath);
    const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.entries)) return payload.entries;
    if (Array.isArray(payload.purchases)) return payload.purchases;
    throw new Error('JSON precisa ser uma lista, ou conter entries/purchases.');
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

async function createBackup(databasePath, runStamp) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(
        BACKUP_DIR,
        `before-return-shop-manual-import-${runStamp}.sqlite`
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

function renderPreview(entries, importKey) {
    const totalUnits = entries.reduce(
        (total, entry) => total + Number(entry.quantity || 1),
        0
    );
    console.log('\n=== PREVIEW IMPORTACAO MANUAL LOJA DE RETORNO ===');
    console.log(`Chave: ${importKey}`);
    console.log(`Linhas no arquivo: ${entries.length}`);
    console.log(`Entitlements a registrar: ${totalUnits}`);
    console.log('\nAmostra:');
    for (const entry of entries.slice(0, 10)) {
        console.log(
            `- ${entry.playerId}: ${entry.catalogItemKey} -> ${entry.entitlementKey || entry.catalogItemKey}`
        );
    }
}

async function main() {
    const filePath = argValue('file');
    const databasePath = path.resolve(argValue('db') || DEFAULT_DB);
    const importKey = argValue('key') || `manual-return-shop-${stamp()}`;
    const createdBy = argValue('by') || 'system:return-shop-manual-import';
    const apply = hasFlag('apply');
    const confirm = argValue('confirm');
    const entries = readEntries(filePath);

    if (!apply) {
        renderPreview(entries, importKey);
        console.log(`\nPara aplicar: node scripts/importManualReturnShopPurchases.js --file=${filePath} --key=${importKey} --apply --confirm=${APPLY_CONFIRMATION}`);
        return;
    }

    if (confirm !== APPLY_CONFIRMATION) {
        throw new Error(`Para aplicar, use --apply --confirm=${APPLY_CONFIRMATION}`);
    }
    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco nao encontrado: ${databasePath}`);
    }

    const backupPath = await createBackup(databasePath, stamp());
    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    try {
        const result = await importManualReturnShopPurchases(db, entries, {
            importKey,
            createdBy,
        });
        console.log('\n=== IMPORTACAO MANUAL LOJA DE RETORNO APLICADA ===');
        console.log(`Backup: ${backupPath}`);
        console.log(`Chave: ${importKey}`);
        console.log(`Criados: ${result.created}`);
        console.log(`Duplicados ignorados: ${result.duplicates}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NA IMPORTACAO MANUAL:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
