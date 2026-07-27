'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    backupSqliteDatabase,
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

function removeIfExists(filePath) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runNode(scriptPath, argumentsList) {
    const result = spawnSync(process.execPath, [scriptPath, ...argumentsList], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Comando falhou (${result.status}): ${path.basename(scriptPath)}`);
    }
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: esperado ${expected}, recebido ${actual}`);
    }
}

async function main() {
    const liveDatabasePath = path.resolve(requiredArgument('live-db'));
    const oldAuditPath = path.resolve(requiredArgument('old-audit'));
    const outputDirectory = path.resolve(
        argumentValue('output-dir')
        || path.join('artifacts', 'trait-description-canonical', 'repair-validation')
    );

    if (!fs.existsSync(liveDatabasePath)) {
        throw new Error(`Banco vivo não encontrado: ${liveDatabasePath}`);
    }
    if (!fs.existsSync(oldAuditPath)) {
        throw new Error(`Auditoria antiga não encontrada: ${oldAuditPath}`);
    }

    fs.mkdirSync(outputDirectory, { recursive: true });

    const files = {
        snapshot: path.join(outputDirectory, 'source-snapshot.sqlite'),
        snapshotMetadata: path.join(outputDirectory, 'source-snapshot.json'),
        plan: path.join(outputDirectory, 'canonical-plan.json'),
        diagnostic: path.join(outputDirectory, 'history-diagnostic.json'),
        duplicateAudit: path.join(outputDirectory, 'duplicate-assignment-audit.json'),
        preview: path.join(outputDirectory, 'preview.json'),
        testDatabase: path.join(outputDirectory, 'apply-test.sqlite'),
        applyBackup: path.join(outputDirectory, 'apply-test-before.sqlite'),
        apply: path.join(outputDirectory, 'apply.json'),
        verify: path.join(outputDirectory, 'verify.json'),
        afterApplyPlan: path.join(outputDirectory, 'after-apply-plan.json'),
        duplicatePreview: path.join(outputDirectory, 'duplicate-preview.json'),
        duplicateApplyBackup: path.join(outputDirectory, 'duplicate-apply-before.sqlite'),
        duplicateApply: path.join(outputDirectory, 'duplicate-apply.json'),
        duplicateVerify: path.join(outputDirectory, 'duplicate-verify.json'),
        duplicateUndoBackup: path.join(outputDirectory, 'duplicate-undo-before.sqlite'),
        duplicateUndo: path.join(outputDirectory, 'duplicate-undo.json'),
        duplicateAfterUndoPreview: path.join(outputDirectory, 'duplicate-after-undo-preview.json'),
        undoBackup: path.join(outputDirectory, 'apply-test-before-undo.sqlite'),
        undo: path.join(outputDirectory, 'undo.json'),
        afterUndoPreview: path.join(outputDirectory, 'after-undo-preview.json'),
        summary: path.join(outputDirectory, 'validation-summary.json'),
    };

    Object.values(files).forEach(removeIfExists);

    const snapshot = await backupSqliteDatabase(liveDatabasePath, files.snapshot);
    fs.writeFileSync(
        files.snapshotMetadata,
        `${JSON.stringify({
            generatedAt: new Date().toISOString(),
            sourceFile: path.basename(liveDatabasePath),
            snapshotPath: snapshot.destinationPath,
            bytes: snapshot.bytes,
            integrity: snapshot.integrity,
            method: snapshot.method,
        }, null, 2)}\n`,
        'utf8'
    );

    runNode(path.join(__dirname, 'planCanonicalTraitDescriptions.js'), [
        `--db=${files.snapshot}`,
        `--output=${files.plan}`,
    ]);

    runNode(path.join(__dirname, 'diagnoseTraitDescriptionHistory.js'), [
        `--db=${files.snapshot}`,
        `--old-audit=${oldAuditPath}`,
        `--canonical-plan=${files.plan}`,
        `--output=${files.diagnostic}`,
    ]);

    runNode(path.join(__dirname, 'auditDuplicateTraitAssignments.js'), [
        `--db=${files.snapshot}`,
        `--plan=${files.plan}`,
        `--output=${files.duplicateAudit}`,
    ]);

    runNode(path.join(__dirname, 'executeCanonicalTraitDescriptions.js'), [
        '--mode=preview',
        `--db=${files.snapshot}`,
        `--plan=${files.plan}`,
        `--output=${files.preview}`,
    ]);

    fs.copyFileSync(files.snapshot, files.testDatabase);
    const repairCode = 'TDR-SNAPSHOT-VALIDATION';
    const migrationCode = 'TAM-SNAPSHOT-VALIDATION';

    runNode(path.join(__dirname, 'executeCanonicalTraitDescriptions.js'), [
        '--mode=apply',
        `--db=${files.testDatabase}`,
        `--plan=${files.plan}`,
        `--backup=${files.applyBackup}`,
        `--repair-code=${repairCode}`,
        '--confirm=APPLY-CANONICAL-TRAIT-DESCRIPTIONS',
        '--actor=isolated-validator',
        `--output=${files.apply}`,
    ]);

    runNode(path.join(__dirname, 'executeCanonicalTraitDescriptions.js'), [
        '--mode=verify',
        `--db=${files.testDatabase}`,
        `--plan=${files.plan}`,
        `--output=${files.verify}`,
    ]);

    runNode(path.join(__dirname, 'planCanonicalTraitDescriptions.js'), [
        `--db=${files.testDatabase}`,
        `--output=${files.afterApplyPlan}`,
    ]);

    runNode(path.join(__dirname, 'executeDuplicateAnomalyMigration.js'), [
        '--mode=preview',
        `--db=${files.testDatabase}`,
        `--audit=${files.duplicateAudit}`,
        `--output=${files.duplicatePreview}`,
    ]);

    runNode(path.join(__dirname, 'executeDuplicateAnomalyMigration.js'), [
        '--mode=apply',
        `--db=${files.testDatabase}`,
        `--audit=${files.duplicateAudit}`,
        `--backup=${files.duplicateApplyBackup}`,
        `--migration-code=${migrationCode}`,
        '--confirm=APPLY-DUPLICATE-ANOMALY-MIGRATION',
        '--actor=isolated-validator',
        `--output=${files.duplicateApply}`,
    ]);

    runNode(path.join(__dirname, 'executeDuplicateAnomalyMigration.js'), [
        '--mode=verify',
        `--db=${files.testDatabase}`,
        `--migration-code=${migrationCode}`,
        `--output=${files.duplicateVerify}`,
    ]);

    runNode(path.join(__dirname, 'executeDuplicateAnomalyMigration.js'), [
        '--mode=undo',
        `--db=${files.testDatabase}`,
        `--backup=${files.duplicateUndoBackup}`,
        `--migration-code=${migrationCode}`,
        '--confirm=UNDO-DUPLICATE-ANOMALY-MIGRATION',
        '--actor=isolated-validator',
        `--output=${files.duplicateUndo}`,
    ]);

    runNode(path.join(__dirname, 'executeDuplicateAnomalyMigration.js'), [
        '--mode=preview',
        `--db=${files.testDatabase}`,
        `--audit=${files.duplicateAudit}`,
        `--output=${files.duplicateAfterUndoPreview}`,
    ]);

    runNode(path.join(__dirname, 'executeCanonicalTraitDescriptions.js'), [
        '--mode=undo',
        `--db=${files.testDatabase}`,
        `--backup=${files.undoBackup}`,
        `--repair-code=${repairCode}`,
        '--confirm=UNDO-CANONICAL-TRAIT-DESCRIPTIONS',
        '--actor=isolated-validator',
        `--output=${files.undo}`,
    ]);

    runNode(path.join(__dirname, 'executeCanonicalTraitDescriptions.js'), [
        '--mode=preview',
        `--db=${files.testDatabase}`,
        `--plan=${files.plan}`,
        `--output=${files.afterUndoPreview}`,
    ]);

    const plan = readJson(files.plan);
    const diagnostic = readJson(files.diagnostic);
    const duplicateAudit = readJson(files.duplicateAudit);
    const preview = readJson(files.preview);
    const apply = readJson(files.apply);
    const verify = readJson(files.verify);
    const afterApplyPlan = readJson(files.afterApplyPlan);
    const duplicatePreview = readJson(files.duplicatePreview);
    const duplicateApply = readJson(files.duplicateApply);
    const duplicateVerify = readJson(files.duplicateVerify);
    const duplicateUndo = readJson(files.duplicateUndo);
    const duplicateAfterUndoPreview = readJson(files.duplicateAfterUndoPreview);
    const undo = readJson(files.undo);
    const afterUndoPreview = readJson(files.afterUndoPreview);

    assertEqual(plan.summary.templatesRead, 50, 'Modelos no plano');
    assertEqual(plan.summary.plannedUpdates, 40, 'Atualizações planejadas');
    assertEqual(plan.summary.alreadyDescribed, 8, 'Descrições preservadas');
    assertEqual(plan.summary.unmatched, 2, 'Modelos sem correspondência');
    assertEqual(plan.summary.ambiguous, 0, 'Correspondências ambíguas');
    assertEqual(diagnostic.current.storedNamesWithMojibakePattern, 0, 'Mojibake real');
    assertEqual(diagnostic.database.unchanged, true, 'Snapshot inalterado na auditoria');
    assertEqual(duplicateAudit.summary.unmatchedSystemTemplates, 2, 'Modelos globais duplicados');
    assertEqual(duplicateAudit.summary.safeMigrationCandidates, 2, 'Candidatos de migração');
    assertEqual(preview.updates, 40, 'Atualizações na prévia');
    assertEqual(preview.writesPerformed, false, 'Escritas na prévia');
    assertEqual(apply.updated, 40, 'Atualizações aplicadas na cópia');
    assertEqual(apply.namesChanged, 0, 'Nomes alterados na aplicação');
    assertEqual(verify.verified, 40, 'Atualizações verificadas');
    assertEqual(afterApplyPlan.summary.plannedUpdates, 0, 'Pendências após aplicação');
    assertEqual(afterApplyPlan.summary.alreadyDescribed, 48, 'Descrições após aplicação');
    assertEqual(afterApplyPlan.summary.unmatched, 2, 'Não correspondidos após aplicação');
    assertEqual(duplicatePreview.migrations, 2, 'Migrações duplicadas na prévia');
    assertEqual(duplicatePreview.writesPerformed, false, 'Escritas na prévia de duplicações');
    assertEqual(duplicateApply.migrated, 2, 'Duplicações migradas na cópia');
    assertEqual(duplicateApply.fixedOverrides, 2, 'Overrides fixos aplicados');
    assertEqual(duplicateApply.extrasDeactivated, 2, 'Anomalias extras desativadas');
    assertEqual(duplicateVerify.verified, 2, 'Migrações duplicadas verificadas');
    assertEqual(duplicateUndo.restored, 2, 'Migrações duplicadas desfeitas');
    assertEqual(duplicateUndo.extrasReactivated, 2, 'Anomalias extras reativadas');
    assertEqual(duplicateAfterUndoPreview.migrations, 2, 'Duplicações restauradas após undo');
    assertEqual(undo.restored, 40, 'Atualizações desfeitas');
    assertEqual(undo.namesChanged, 0, 'Nomes alterados no undo');
    assertEqual(afterUndoPreview.updates, 40, 'Estado restaurado após undo');

    const summary = {
        ok: true,
        generatedAt: new Date().toISOString(),
        liveDatabaseWrites: false,
        snapshot: {
            path: files.snapshot,
            integrity: snapshot.integrity,
            method: snapshot.method,
        },
        canonicalDescriptions: {
            planned: 40,
            preservedCustom: 8,
            unmatchedSystem: 2,
            appliedOnCopy: apply.updated,
            verifiedOnCopy: verify.verified,
            undoneOnCopy: undo.restored,
            namesChanged: 0,
        },
        duplicateAnomalyMigration: {
            planned: duplicatePreview.migrations,
            appliedOnCopy: duplicateApply.migrated,
            verifiedOnCopy: duplicateVerify.verified,
            undoneOnCopy: duplicateUndo.restored,
            fixedOverrides: duplicateApply.fixedOverrides,
            extrasDeactivated: duplicateApply.extrasDeactivated,
            extrasReactivated: duplicateUndo.extrasReactivated,
        },
        duplicateAssignments: duplicateAudit.targets.map((target) => ({
            templateId: target.template.id,
            name: target.template.name,
            safeMigrationCandidate: target.migrationAssessment.safeCandidate,
            proposedAction: target.migrationAssessment.proposedAction,
            assignments: target.assignments,
            siblings: target.siblings,
            sharedPlayerKeys: target.sharedPlayerKeys,
        })),
        files,
    };

    fs.writeFileSync(files.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log('\nVALIDAÇÃO ISOLADA CONCLUÍDA.');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Resumo: ${files.summary}`);
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
