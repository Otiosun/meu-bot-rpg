'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    applyRepairPlan,
    previewRepairPlan,
    undoRepairBatch,
    verifyAppliedPlan,
} = require('../helpers/clover/traitCanonicalDescriptionExecutorV2');
const {
    backupSqliteDatabase,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function requiredArgument(name) {
    const value = argumentValue(name);
    if (!value) throw new Error(`Argumento obrigatório ausente: --${name}=...`);
    return value;
}

function writeJson(outputPath, payload) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function isLiveDatabase(databasePath) {
    return path.basename(databasePath).toLowerCase() === 'banco.sqlite';
}

async function openDatabase(databasePath, readOnly) {
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE,
    });
    await db.exec('PRAGMA busy_timeout = 10000');
    if (readOnly) await db.exec('PRAGMA query_only = ON');
    else await db.exec('PRAGMA foreign_keys = ON');
    return db;
}

async function main() {
    const mode = String(argumentValue('mode') || 'preview').trim().toLowerCase();
    if (!['preview', 'apply', 'verify', 'undo'].includes(mode)) {
        throw new Error('Modo inválido. Use preview, apply, verify ou undo.');
    }

    const databasePath = path.resolve(requiredArgument('db'));
    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);

    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'trait-description-canonical', `${mode}-result.json`)
    );
    const actorId = argumentValue('actor') || 'local-admin';
    const repairCode = argumentValue('repair-code') || null;
    let plan = null;

    if (mode !== 'undo') {
        const planPath = path.resolve(requiredArgument('plan'));
        if (!fs.existsSync(planPath)) throw new Error(`Plano não encontrado: ${planPath}`);
        plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    }

    if (mode === 'preview' || mode === 'verify') {
        const db = await openDatabase(databasePath, true);
        try {
            const result = mode === 'preview'
                ? await previewRepairPlan(db, plan)
                : await verifyAppliedPlan(db, plan);
            const integrity = await db.get('PRAGMA integrity_check');
            const payload = {
                ...result,
                database: {
                    file: path.basename(databasePath),
                    integrity: integrity?.integrity_check || Object.values(integrity || {})[0] || null,
                },
            };
            writeJson(outputPath, payload);
            console.log(JSON.stringify(payload, null, 2));
            console.log(`Resultado salvo em: ${outputPath}`);
            return;
        } finally {
            await db.close();
        }
    }

    if (isLiveDatabase(databasePath) && argumentValue('allow-live-db') !== 'YES') {
        throw new Error('Banco vivo bloqueado. Use --allow-live-db=YES apenas numa aplicação deliberada.');
    }

    const backupPath = path.resolve(requiredArgument('backup'));
    const backup = await backupSqliteDatabase(databasePath, backupPath);
    const db = await openDatabase(databasePath, false);
    let result;
    try {
        if (mode === 'apply') {
            result = await applyRepairPlan(db, plan, {
                confirm: argumentValue('confirm'),
                repairCode,
                actorId,
            });
        } else {
            result = await undoRepairBatch(db, {
                confirm: argumentValue('confirm'),
                repairCode: requiredArgument('repair-code'),
                actorId,
            });
        }
    } finally {
        await db.close();
    }

    const verification = await verifySqliteDatabase(databasePath);
    if (!verification.ok) {
        const error = new Error(
            `A operação terminou, mas a integridade falhou (${verification.integrity || 'desconhecida'}). `
            + `Backup: ${backup.destinationPath}`
        );
        error.code = 'post_repair_integrity_failed';
        error.backupPath = backup.destinationPath;
        throw error;
    }

    const payload = {
        ...result,
        backup: {
            file: path.basename(backup.destinationPath),
            path: backup.destinationPath,
            bytes: backup.bytes,
            integrity: backup.integrity,
            method: backup.method,
        },
        database: {
            file: path.basename(databasePath),
            integrity: verification.integrity,
        },
    };
    writeJson(outputPath, payload);
    console.log(JSON.stringify(payload, null, 2));
    console.log(`Resultado salvo em: ${outputPath}`);
}

main().catch((error) => {
    console.error(error?.stack || error);
    if (error?.code) console.error(`Código: ${error.code}`);
    if (error?.backupPath) console.error(`Backup disponível em: ${error.backupPath}`);
    if (error?.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
});
