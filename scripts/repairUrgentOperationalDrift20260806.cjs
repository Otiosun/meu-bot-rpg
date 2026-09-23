'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    REPAIR_KEY,
    applyUrgentOperationalPlan,
    buildUrgentOperationalPlan,
    readUrgentOperationalSnapshot,
} = require('../helpers/clover/urgentOperationalRepairService');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'banco.sqlite');
const CONFIRMATION = 'APLICAR-CORRECAO-URGENTE-CLOVER-2026-08-06';

function parseArgs(argv) {
    const result = {
        db: DEFAULT_DB,
        output: null,
        backup: null,
        apply: false,
        confirm: '',
        jsonOnly: false,
    };
    for (const arg of argv) {
        if (arg === '--apply') result.apply = true;
        else if (arg === '--json-only') result.jsonOnly = true;
        else if (arg.startsWith('--db=')) result.db = path.resolve(arg.slice('--db='.length));
        else if (arg.startsWith('--output=')) result.output = path.resolve(arg.slice('--output='.length));
        else if (arg.startsWith('--backup=')) result.backup = path.resolve(arg.slice('--backup='.length));
        else if (arg.startsWith('--confirm=')) result.confirm = arg.slice('--confirm='.length);
        else throw new Error(`Argumento desconhecido: ${arg}`);
    }
    if (result.apply) {
        if (result.confirm !== CONFIRMATION) {
            throw new Error(`AplicaÃ§Ã£o bloqueada. Use --confirm=${CONFIRMATION}`);
        }
        if (!result.backup) throw new Error('AplicaÃ§Ã£o exige --backup=CAMINHO.');
    }
    return result;
}

function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function openDatabase(filename, readonly) {
    return open({
        filename,
        driver: sqlite3.Database,
        mode: readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE,
    });
}

async function validateDatabase(db) {
    await db.exec('PRAGMA busy_timeout = 10000');
    const quick = await db.get('PRAGMA quick_check');
    const quickValue = quick ? Object.values(quick)[0] : null;
    if (String(quickValue).toLowerCase() !== 'ok') {
        throw new Error(`PRAGMA quick_check falhou: ${quickValue}`);
    }
    const foreignKeys = await db.all('PRAGMA foreign_key_check');
    if (foreignKeys.length) {
        const error = new Error('PRAGMA foreign_key_check encontrou violaÃ§Ãµes.');
        error.details = foreignKeys.slice(0, 20);
        throw error;
    }
    return { quickCheck: quickValue, foreignKeyViolationCount: foreignKeys.length };
}

async function createConsistentBackup(dbPath, backupPath) {
    if (fs.existsSync(backupPath)) {
        throw new Error(`O backup jÃ¡ existe: ${backupPath}`);
    }
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });

    const checkpointDb = await openDatabase(dbPath, false);
    try {
        await checkpointDb.exec('PRAGMA busy_timeout = 10000');
        await checkpointDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        await validateDatabase(checkpointDb);
    } finally {
        await checkpointDb.close().catch(() => null);
    }

    fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    const [sourceHash, backupHash] = await Promise.all([
        sha256(dbPath),
        sha256(backupPath),
    ]);
    if (sourceHash !== backupHash) {
        fs.rmSync(backupPath, { force: true });
        throw new Error('O hash do backup nÃ£o corresponde ao banco de origem.');
    }
    return {
        path: backupPath,
        sha256: backupHash,
        bytes: fs.statSync(backupPath).size,
    };
}

function publicPlanSummary(plan) {
    return {
        safeToApply: plan.safeToApply,
        blockingReasons: plan.blockingReasons,
        summary: plan.summary,
        admin: {
            candidates: plan.admin.candidates,
            matchedCount: plan.admin.matched.length,
            legacyOnly: plan.admin.legacyOnly,
            mismatches: plan.admin.mismatches,
            ambiguousCanonical: plan.admin.ambiguousCanonical,
        },
        squads: {
            reviewCandidates: plan.squads.candidates,
            automaticCandidates: plan.squads.automaticCandidates,
            requiresApprovedMap: plan.squads.requiresApprovedMap,
            approvedTransferRequired: plan.squads.approvedTransferRequired,
            matchedCount: plan.squads.matched.length,
            duplicateActive: plan.squads.duplicateActive,
            ineligibleLegacy: plan.squads.ineligibleLegacy,
            unknownLegacySquad: plan.squads.unknownLegacySquad,
            mismatches: plan.squads.mismatches,
            activeWithoutLegacy: plan.squads.activeWithoutLegacy,
            activeOrphans: plan.squads.activeOrphans,
            uniqueIndexValid: plan.squads.uniqueIndexValid,
        },
        captains: plan.captains,
        operations: plan.operations,
        raids: plan.raids,
        identities: plan.identities,
    };
}

function writeReport(outputPath, report) {
    if (!outputPath) return null;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    return outputPath;
}

async function dryRun(options) {
    const db = await openDatabase(options.db, true);
    try {
        const integrity = await validateDatabase(db);
        const snapshot = await readUrgentOperationalSnapshot(db);
        const plan = buildUrgentOperationalPlan(snapshot);
        return {
            ok: true,
            mode: 'dry-run',
            write: false,
            generatedAt: new Date().toISOString(),
            database: {
                path: options.db,
                sha256: await sha256(options.db),
                bytes: fs.statSync(options.db).size,
                integrity,
            },
            repairKey: REPAIR_KEY,
            plan: publicPlanSummary(plan),
        };
    } finally {
        await db.close().catch(() => null);
    }
}

async function apply(options) {
    const backup = await createConsistentBackup(options.db, options.backup);
    const db = await openDatabase(options.db, false);
    try {
        const integrityBefore = await validateDatabase(db);
        const beforeSnapshot = await readUrgentOperationalSnapshot(db);
        const beforePlan = buildUrgentOperationalPlan(beforeSnapshot);
        if (!beforePlan.safeToApply) {
            const error = new Error('O banco possui conflitos que bloqueiam a aplicaÃ§Ã£o automÃ¡tica.');
            error.details = beforePlan.blockingReasons;
            throw error;
        }

        const applied = await applyUrgentOperationalPlan(db, beforePlan);
        const integrityAfter = await validateDatabase(db);
        const afterSnapshot = await readUrgentOperationalSnapshot(db);
        const afterPlan = buildUrgentOperationalPlan(afterSnapshot);

        if (!afterPlan.safeToApply) {
            const error = new Error('A pÃ³s-validaÃ§Ã£o encontrou conflitos.');
            error.details = afterPlan.blockingReasons;
            throw error;
        }
        if (afterPlan.admin.candidates.length || afterPlan.squads.automaticCandidates.length) {
            throw new Error('A pÃ³s-validaÃ§Ã£o ainda encontrou candidatos nÃ£o aplicados.');
        }

        return {
            ok: true,
            mode: 'apply',
            write: true,
            generatedAt: new Date().toISOString(),
            database: {
                path: options.db,
                sha256After: await sha256(options.db),
                bytesAfter: fs.statSync(options.db).size,
                integrityBefore,
                integrityAfter,
            },
            backup,
            repairKey: REPAIR_KEY,
            before: publicPlanSummary(beforePlan),
            applied,
            after: publicPlanSummary(afterPlan),
        };
    } finally {
        await db.close().catch(() => null);
    }
}

function printHuman(report, outputPath) {
    const plan = report.mode === 'apply' ? report.before : report.plan;
    console.log('');
    console.log('===== CORREÃ‡ÃƒO URGENTE CLOVER =====');
    console.log('Modo:', report.mode);
    console.log('Seguro para aplicar:', plan.safeToApply ? 'SIM' : 'NÃƒO');
    console.log('Equipe ADM a sincronizar:', plan.summary.adminProjectionCandidates);
    console.log('VÃ­nculos de esquadrÃ£o autorizados para criar:', plan.summary.squadMembershipCandidates);
    console.log('Cadastros de esquadrÃ£o aguardando mapa aprovado:', plan.summary.squadMembershipReviewCount);
    console.log('CapitÃ£es ainda dependentes de identificaÃ§Ã£o manual:', plan.summary.manualCaptainIdentities);
    console.log('OperaÃ§Ãµes ADM antigas para revisÃ£o:', plan.summary.staleAdminOperations);
    console.log('Raids presas para revisÃ£o:', plan.summary.stuckRaids);
    console.log('Raids ativas preservadas:', plan.summary.activeRaids);
    if (report.mode === 'apply') {
        console.log('Linhas ADM alteradas:', report.applied.adminRows);
        console.log('VÃ­nculos criados:', report.applied.membershipRows);
        console.log('Backup:', report.backup.path);
        console.log('PÃ³s-validaÃ§Ã£o:', report.after.safeToApply ? 'APROVADA' : 'REPROVADA');
    }
    if (outputPath) console.log('RelatÃ³rio:', outputPath);
    console.log('');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(options.db)) throw new Error(`Banco nÃ£o encontrado: ${options.db}`);
    const report = options.apply ? await apply(options) : await dryRun(options);
    const outputPath = writeReport(options.output, report);
    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report, outputPath);
    if (!report.plan?.safeToApply && report.mode === 'dry-run') process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'urgent_operational_repair_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    CONFIRMATION,
    createConsistentBackup,
    dryRun,
    parseArgs,
    publicPlanSummary,
    sha256,
    validateDatabase,
};

