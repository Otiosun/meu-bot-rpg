'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureDreamWorldsSchema } = require('../helpers/clover/dreamWorldsService');
const { ensureDreamOperationsSchema } = require('../helpers/clover/dreamWorldsOperationsService');
const { auditDreamWorldsV1 } = require('../helpers/clover/dreamWorldsAuditService');

function argument(name, argv = process.argv.slice(2)) {
    const prefix = `--${name}=`;
    const item = argv.find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name, argv = process.argv.slice(2)) {
    return argv.includes(`--${name}`);
}

function timestampKey(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function codeSha(root) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : 'unknown';
}

async function createConsistentBackup(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);

    const db = await open({ filename: sourcePath, driver: sqlite3.Database });
    try {
        await db.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
    } finally {
        await db.close();
    }
    return {
        path: destinationPath,
        sha256: sha256File(destinationPath),
    };
}

async function countTables(db) {
    const tables = [
        'clover_dream_worlds',
        'clover_dream_requests',
        'clover_dream_runs',
        'clover_dream_slots',
        'clover_resonance_fragments',
        'clover_resonance_fragment_versions',
        'clover_dream_audit',
    ];
    const result = {};
    for (const table of tables) {
        const row = await db.get(`SELECT COUNT(*) AS total FROM ${table}`);
        result[table] = Number(row?.total || 0);
    }
    return result;
}

async function installDreamWorldsV1(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const root = path.resolve(options.root || path.join(__dirname, '..'));
    const rawDatabase = argument('db', argv);

    if (!rawDatabase) throw new Error('Informe --db="CAMINHO" para instalar Mundos dos Sonhos V1.');
    if (!hasFlag('allow-live-write', argv)) {
        throw new Error('Escrita recusada: adicione --allow-live-write depois de confirmar backup e janela operacional.');
    }

    const databasePath = path.resolve(rawDatabase);
    if (!fs.existsSync(databasePath)) throw new Error(`Banco nao encontrado: ${databasePath}`);

    const backupPath = path.join(root, 'backups', `dream-worlds-install-${timestampKey(options.now || new Date())}.sqlite`);
    const backup = await createConsistentBackup(databasePath, backupPath);

    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    let committed = false;
    try {
        await db.exec('BEGIN IMMEDIATE');
        await ensureDreamWorldsSchema(db);
        await ensureDreamOperationsSchema(db);
        await db.exec('COMMIT');
        committed = true;

        const counts = await countTables(db);
        const audit = await auditDreamWorldsV1(db, { databaseLabel: databasePath });
        return {
            codeSha: codeSha(root),
            databasePath,
            backup,
            installedTables: Object.keys(counts),
            counts,
            audit,
            rollback: `Para rollback, pare o runtime e restaure o arquivo ${backup.path} sobre ${databasePath}.`,
        };
    } catch (error) {
        if (!committed) await db.exec('ROLLBACK').catch(() => null);
        throw error;
    } finally {
        await db.close();
    }
}

function printReport(report) {
    console.log('\n=== INSTALACAO MUNDOS DOS SONHOS V1 ===');
    console.log(`SHA do codigo: ${report.codeSha}`);
    console.log(`Banco: ${report.databasePath}`);
    console.log(`Backup: ${report.backup.path}`);
    console.log(`Backup SHA-256: ${report.backup.sha256}`);
    console.log('\nTabelas instaladas:');
    for (const table of report.installedTables) console.log(`- ${table}`);
    console.log('\nTotais:');
    for (const [table, total] of Object.entries(report.counts)) console.log(`- ${table}: ${total}`);
    console.log('\nAuditoria:');
    console.log(`- instalado: ${report.audit.installed ? 'sim' : 'nao'}`);
    console.log(`- saudavel: ${report.audit.summary.healthy ? 'sim' : 'nao'}`);
    console.log(`- apontamentos: ${report.audit.summary.issueCount}`);
    console.log(`- criticos: ${report.audit.summary.bySeverity.critical || 0}`);
    console.log(`- avisos: ${report.audit.summary.bySeverity.warning || 0}`);
    console.log(`\nRollback: ${report.rollback}`);
}

async function main() {
    const report = await installDreamWorldsV1();
    printReport(report);
    if (!report.audit.summary.healthy) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nInstalacao interrompida:', error?.stack || error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    createConsistentBackup,
    installDreamWorldsV1,
};
