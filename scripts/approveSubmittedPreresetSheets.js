'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { backupSqliteDatabase } = require('../helpers/clover/sqliteBackupService');
const {
    applyPreResetBatchSheetApproval,
    previewPreResetBatchSheetApproval,
} = require('../helpers/clover/preResetBatchSheetApprovalService');

const ROOT = path.resolve(__dirname, '..');
const CONFIRMATION = 'APPROVE_6_PRERESET_SHEETS';

function argValue(name) {
    const prefix = `--${name}=`;
    const found = process.argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function render(preview) {
    console.log('\n=== APROVACAO DAS 6 FICHAS PRE-RESET ===');
    for (const row of preview.rows) {
        const state = row.issues.length ? `BLOQUEADA: ${row.issues.join(', ')}`
            : row.alreadyApproved ? 'JA APROVADA' : 'PRONTA';
        console.log(`- ${row.target.name} | ${row.target.playerId} | ${state}`);
    }
    console.log(`Total: ${preview.total} | pendentes: ${preview.pending} | ja aprovadas: ${preview.alreadyApproved} | bloqueadas: ${preview.blocked}`);
}

async function main() {
    const databasePath = path.resolve(argValue('db') || path.join(ROOT, 'banco.sqlite'));
    const apply = hasFlag('apply');
    if (!fs.existsSync(databasePath)) throw new Error(`Banco nao encontrado: ${databasePath}`);
    if (apply && !hasFlag('allow-live-write')) throw new Error('Aplicacao exige --allow-live-write.');
    if (apply && argValue('confirm') !== CONFIRMATION) throw new Error(`Aplicacao exige --confirm=${CONFIRMATION}.`);

    const db = await open({ filename: databasePath, driver: sqlite3.Database, mode: apply ? undefined : sqlite3.OPEN_READONLY });
    try {
        const preview = await previewPreResetBatchSheetApproval(db);
        render(preview);
        if (!preview.ok) throw new Error('Preflight bloqueado; nenhuma alteracao permitida.');
        if (!apply) {
            console.log(`\nPara aplicar: node scripts/approveSubmittedPreresetSheets.js --db="${databasePath}" --apply --allow-live-write --confirm=${CONFIRMATION} --by="SEU_ID"`);
            return;
        }
    } finally {
        await db.close();
    }

    const backupPath = path.join(ROOT, 'backups', `before-approve-6-prereset-sheets-${stamp()}.sqlite`);
    const backup = await backupSqliteDatabase(databasePath, backupPath);
    const writeDb = await open({ filename: databasePath, driver: sqlite3.Database });
    try {
        const result = await applyPreResetBatchSheetApproval(writeDb, {
            actorId: argValue('by') || 'system:approved-by-owner-20260917',
            reason: 'Aprovacao administrativa confirmada pelo owner',
        });
        console.log(`\nAplicadas: ${result.applied}/${result.total}`);
        console.log(`Backup: ${backup.destinationPath}`);
        console.log(`Integridade do backup: ${backup.integrity}`);
    } finally {
        await writeDb.close();
    }
}

main().catch(error => {
    console.error('\nFALHA NA APROVACAO DAS FICHAS:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
