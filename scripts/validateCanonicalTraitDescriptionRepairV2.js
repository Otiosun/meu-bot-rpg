'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    getAdminPlayerTraitOverview,
} = require('../helpers/clover/adminPlayerTraitOverviewService');
const {
    presentNarrative,
} = require('../helpers/clover/characterPresentationNarrative');

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

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: esperado ${expected}, recebido ${actual}`);
    }
}

function normalizedKey(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function runBaseValidator(liveDb, oldAudit, outputDir) {
    const result = spawnSync(
        process.execPath,
        [
            path.join(__dirname, 'validateCanonicalTraitDescriptionRepair.js'),
            `--live-db=${liveDb}`,
            `--old-audit=${oldAudit}`,
            `--output-dir=${outputDir}`,
        ],
        {
            cwd: path.resolve(__dirname, '..'),
            stdio: 'inherit',
            windowsHide: true,
        }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Validador integrado base falhou (${result.status}).`);
    }
}

async function openReadonly(databasePath) {
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    await db.exec('PRAGMA query_only = ON');
    return db;
}

async function openWritable(databasePath) {
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READWRITE,
    });
    await db.exec('PRAGMA foreign_keys = ON');
    return db;
}

async function readTemplateState(db, templateId) {
    return db.get(
        `SELECT id, name, description, effect_text, restrictions_text, updated_at
         FROM clover_trait_templates WHERE id = ?`,
        [templateId]
    );
}

async function readAssignmentState(db, assignmentId) {
    return db.get(
        `SELECT id, player_id, trait_id, slot_key, value_text, active,
                operation_code, removed_by, removed_at, metadata_json
         FROM clover_player_traits WHERE id = ?`,
        [assignmentId]
    );
}

async function readPlayerState(db, playerId) {
    return db.get(
        'SELECT id, historias_extras FROM jogadores WHERE id = ?',
        [playerId]
    );
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function exactJson(value) {
    return JSON.stringify(stable(value));
}

async function validatePresentation(files, duplicateAudit, outputDir) {
    const presentationDbPath = path.join(outputDir, 'presentation-check.sqlite');
    if (fs.existsSync(presentationDbPath)) fs.rmSync(presentationDbPath, { force: true });
    fs.copyFileSync(files.duplicateUndoBackup, presentationDbPath);

    const db = await openWritable(presentationDbPath);
    let playersChecked = 0;
    let fixedDescriptionsVisible = 0;
    let duplicateExtrasAbsent = 0;
    let singleVisibleOccurrences = 0;
    try {
        for (const target of duplicateAudit.targets || []) {
            const fixedAssignmentId = Number(target.assignments?.[0]?.assignmentId);
            const fixedAssignment = await db.get(
                'SELECT player_id FROM clover_player_traits WHERE id = ?',
                [fixedAssignmentId]
            );
            const playerId = String(fixedAssignment?.player_id || '');
            if (!playerId) throw new Error('Jogador da validação de apresentação não encontrado.');

            const overview = await getAdminPlayerTraitOverview(db, playerId);
            const narrative = presentNarrative(overview, {});
            const targetKey = normalizedKey(target.template?.name);
            const fixedMatches = (narrative.fixedTraits || []).filter(
                (entry) => normalizedKey(entry.name) === targetKey
            );
            const extraMatches = (narrative.extraAnomalies || []).filter(
                (entry) => normalizedKey(entry.name) === targetKey
            );
            const expectedDescription = target.siblings?.[0]?.template?.description || null;

            assertEqual(fixedMatches.length, 1, 'Ocorrências no slot fixo após migração');
            assertEqual(fixedMatches[0].description, expectedDescription, 'Descrição pessoal no slot fixo');
            assertEqual(fixedMatches[0].hasDescription, true, 'Indicador de descrição no slot fixo');
            assertEqual(extraMatches.length, 0, 'Duplicatas em Anomalias Extras após migração');
            assertEqual(fixedMatches.length + extraMatches.length, 1, 'Ocorrências visíveis totais');

            playersChecked += 1;
            fixedDescriptionsVisible += 1;
            duplicateExtrasAbsent += 1;
            singleVisibleOccurrences += 1;
        }
        const integrity = await db.get('PRAGMA integrity_check');
        assertEqual(integrity?.integrity_check, 'ok', 'Integridade da cópia de apresentação');
    } finally {
        await db.close();
    }

    return {
        database: presentationDbPath,
        playersChecked,
        fixedDescriptionsVisible,
        duplicateExtrasAbsent,
        singleVisibleOccurrences,
    };
}

async function main() {
    const liveDb = path.resolve(requiredArgument('live-db'));
    const oldAudit = path.resolve(requiredArgument('old-audit'));
    const outputDir = path.resolve(
        argumentValue('output-dir')
        || path.join('artifacts', 'trait-description-canonical', 'repair-validation-v2')
    );

    if (!fs.existsSync(liveDb)) throw new Error(`Banco vivo não encontrado: ${liveDb}`);
    if (!fs.existsSync(oldAudit)) throw new Error(`Auditoria antiga não encontrada: ${oldAudit}`);
    fs.mkdirSync(outputDir, { recursive: true });

    runBaseValidator(liveDb, oldAudit, outputDir);

    const summaryPath = path.join(outputDir, 'validation-summary.json');
    const summary = readJson(summaryPath);
    const files = summary.files || {};
    const plan = readJson(files.plan);
    const duplicateAudit = readJson(files.duplicateAudit);
    const apply = readJson(files.apply);
    const undo = readJson(files.undo);
    const duplicateApply = readJson(files.duplicateApply);
    const duplicateVerify = readJson(files.duplicateVerify);
    const duplicateUndo = readJson(files.duplicateUndo);
    const duplicateAfterUndoPreview = readJson(files.duplicateAfterUndoPreview);

    assertEqual(summary.ok, true, 'Resumo integrado base');
    assertEqual(summary.liveDatabaseWrites, false, 'Escritas no banco vivo');
    assertEqual(apply.executorVersion, 2, 'Versão do executor canônico apply');
    assertEqual(undo.executorVersion, 2, 'Versão do executor canônico undo');
    assertEqual(apply.timestampsCaptured, 40, 'Timestamps capturados');
    assertEqual(undo.timestampsRestored, 40, 'Timestamps restaurados');
    assertEqual(duplicateApply.executorVersion, 2, 'Versão da migração apply');
    assertEqual(duplicateVerify.executorVersion, 2, 'Versão da migração verify');
    assertEqual(duplicateUndo.executorVersion, 2, 'Versão da migração undo');
    assertEqual(duplicateApply.legacyEntriesRemoved, 2, 'Entradas legadas removidas');
    assertEqual(duplicateVerify.legacyEntriesRemoved, 2, 'Entradas legadas verificadas');
    assertEqual(duplicateUndo.legacyEntriesRestored, 2, 'Entradas legadas restauradas');
    assertEqual(duplicateAfterUndoPreview.legacyEntriesRemoved, 2, 'Prévia possível após undo legado');

    const presentation = await validatePresentation(files, duplicateAudit, outputDir);
    assertEqual(presentation.playersChecked, 2, 'Jogadores validados na apresentação');
    assertEqual(presentation.fixedDescriptionsVisible, 2, 'Descrições fixas visíveis');
    assertEqual(presentation.duplicateExtrasAbsent, 2, 'Duplicatas extras ausentes');
    assertEqual(presentation.singleVisibleOccurrences, 2, 'Ocorrências únicas visíveis');

    const sourceDb = await openReadonly(files.snapshot);
    const finalDb = await openReadonly(files.testDatabase);
    let canonicalRowsRestored = 0;
    let assignmentRowsRestored = 0;
    let playerRowsRestored = 0;
    try {
        const sourceIntegrity = await sourceDb.get('PRAGMA integrity_check');
        const finalIntegrity = await finalDb.get('PRAGMA integrity_check');
        assertEqual(sourceIntegrity?.integrity_check, 'ok', 'Integridade do snapshot-fonte');
        assertEqual(finalIntegrity?.integrity_check, 'ok', 'Integridade da cópia final');

        for (const action of plan.actions || []) {
            const before = await readTemplateState(sourceDb, action.templateId);
            const after = await readTemplateState(finalDb, action.templateId);
            if (exactJson(after) !== exactJson(before)) {
                throw new Error(`Estado canônico não restaurado exatamente: ${action.templateId}`);
            }
            canonicalRowsRestored += 1;
        }

        const comparedAssignments = new Set();
        const comparedPlayers = new Set();
        for (const target of duplicateAudit.targets || []) {
            const fixedId = Number(target.assignments?.[0]?.assignmentId);
            const extraId = Number(target.siblings?.[0]?.assignments?.[0]?.assignmentId);
            for (const assignmentId of [fixedId, extraId]) {
                if (!Number.isInteger(assignmentId) || comparedAssignments.has(assignmentId)) continue;
                const before = await readAssignmentState(sourceDb, assignmentId);
                const after = await readAssignmentState(finalDb, assignmentId);
                if (exactJson(after) !== exactJson(before)) {
                    throw new Error(`Vínculo não restaurado exatamente: ${assignmentId}`);
                }
                comparedAssignments.add(assignmentId);
                assignmentRowsRestored += 1;
            }
            const fixedSource = await readAssignmentState(sourceDb, fixedId);
            const playerId = String(fixedSource?.player_id || '');
            if (playerId && !comparedPlayers.has(playerId)) {
                const before = await readPlayerState(sourceDb, playerId);
                const after = await readPlayerState(finalDb, playerId);
                if (exactJson(after) !== exactJson(before)) {
                    throw new Error('historias_extras não foi restaurado exatamente para um jogador auditado.');
                }
                comparedPlayers.add(playerId);
                playerRowsRestored += 1;
            }
        }
    } finally {
        await sourceDb.close();
        await finalDb.close();
    }

    assertEqual(canonicalRowsRestored, 40, 'Modelos canônicos restaurados exatamente');
    assertEqual(assignmentRowsRestored, 4, 'Vínculos restaurados exatamente');
    assertEqual(playerRowsRestored, 2, 'Históricos legados restaurados exatamente');

    summary.validatorVersion = 2;
    summary.exactRollback = {
        canonicalTimestampsCaptured: apply.timestampsCaptured,
        canonicalTimestampsRestored: undo.timestampsRestored,
        canonicalRowsRestoredExactly: canonicalRowsRestored,
        duplicateAssignmentRowsRestoredExactly: assignmentRowsRestored,
        legacyEntriesRemoved: duplicateApply.legacyEntriesRemoved,
        legacyEntriesVerifiedRemoved: duplicateVerify.legacyEntriesRemoved,
        legacyEntriesRestored: duplicateUndo.legacyEntriesRestored,
        playerLegacyHistoriesRestoredExactly: playerRowsRestored,
    };
    summary.presentationValidation = presentation;
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    console.log('\nVALIDAÇÃO V2 CONCLUÍDA.');
    console.log(JSON.stringify({
        ok: summary.ok,
        liveDatabaseWrites: summary.liveDatabaseWrites,
        validatorVersion: summary.validatorVersion,
        exactRollback: summary.exactRollback,
        presentationValidation: summary.presentationValidation,
        summaryPath,
    }, null, 2));
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
