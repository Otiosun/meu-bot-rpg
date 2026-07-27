'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    applyResolutionPlan,
    previewResolutionPlan,
    undoResolutionBatch,
    verifyResolvedPlan,
} = require('../helpers/clover/legacyEventRewardResolutionExecutor');
const {
    getPlayerPossessions,
} = require('../helpers/clover/possessionsService');
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

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function exactJson(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function writeJson(filename, payload) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function openDatabase(filename, readOnly = false) {
    const db = await open({
        filename,
        driver: sqlite3.Database,
        mode: readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE,
    });
    await db.exec('PRAGMA busy_timeout = 10000');
    if (readOnly) await db.exec('PRAGMA query_only = ON');
    else await db.exec('PRAGMA foreign_keys = ON');
    return db;
}

async function readRows(db, ids) {
    const placeholders = ids.map(() => '?').join(', ');
    return db.all(
        `SELECT * FROM clover_inventory_items WHERE id IN (${placeholders}) ORDER BY id ASC`,
        ids
    );
}

async function readTemplates(db, keys) {
    const placeholders = keys.map(() => '?').join(', ');
    return db.all(
        `SELECT * FROM clover_item_templates WHERE template_key IN (${placeholders}) ORDER BY template_key ASC`,
        keys
    );
}

async function main() {
    const sourceDatabase = path.resolve(requiredArgument('source-db'));
    const planPath = path.resolve(requiredArgument('plan'));
    const outputDir = path.resolve(requiredArgument('output-dir'));
    if (!fs.existsSync(sourceDatabase)) throw new Error(`Banco não encontrado: ${sourceDatabase}`);
    if (!fs.existsSync(planPath)) throw new Error(`Plano não encontrado: ${planPath}`);

    fs.mkdirSync(outputDir, { recursive: true });
    const testDatabase = path.join(outputDir, 'lifecycle-test.sqlite');
    const applyBackup = path.join(outputDir, 'before-apply.sqlite');
    const undoBackup = path.join(outputDir, 'before-undo.sqlite');
    const summaryPath = path.join(outputDir, 'validation-summary.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const itemIds = plan.actions.map((action) => Number(action.inventoryItemId)).sort((a, b) => a - b);
    const targetKeys = [...new Set(plan.actions.map((action) => action.after.templateKey))].sort();
    const createdKeys = [...new Set(plan.templatesToCreate.map((template) => template.templateKey))].sort();
    const resolutionCode = 'LER-LIFECYCLE-VALIDATION';

    const sourceCopy = await backupSqliteDatabase(sourceDatabase, testDatabase);
    const db = await openDatabase(testDatabase, false);
    try {
        const beforeRows = await readRows(db, itemIds);
        const beforeTemplates = await readTemplates(db, targetKeys);
        const playerRows = await db.all(
            `SELECT id, player_id FROM clover_inventory_items
             WHERE id IN (${itemIds.map(() => '?').join(', ')}) ORDER BY id ASC`,
            itemIds
        );
        const playerIds = [...new Set(playerRows.map((row) => row.player_id))];

        const preview = await previewResolutionPlan(db, plan);
        const backupBeforeApply = await backupSqliteDatabase(testDatabase, applyBackup);
        const applied = await applyResolutionPlan(db, plan, {
            confirm: 'APPLY-LEGACY-EVENT-REWARDS',
            resolutionCode,
            actorId: 'lifecycle-validator',
            timestamp: '2026-07-27T03:30:00.000Z',
        });
        const verified = await verifyResolvedPlan(db, plan);

        const possessionResults = [];
        for (const playerId of playerIds) {
            const possessions = await getPlayerPossessions(db, playerId, {
                inventoryLimit: 300,
                historyLimit: 20,
            });
            possessionResults.push({ playerId, possessions });
        }
        const allSpecial = possessionResults.flatMap((entry) => entry.possessions.items.special);
        const allPending = possessionResults.flatMap((entry) => entry.possessions.items.pendingRewards || []);
        const targetSpecial = allSpecial.filter((item) => itemIds.includes(Number(item.id)));
        const targetPending = allPending.filter((item) => itemIds.includes(Number(item.id)));
        const dungeonItems = targetSpecial.filter(
            (item) => item.template_key === 'acesso_dungeon_exclusiva'
        );
        const pendingItems = targetPending.filter(
            (item) => item.possessionCategory === 'pending_reward'
        );
        const dungeonUnits = dungeonItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        const pendingWithUseAction = pendingItems.filter((item) => item.useAction).length;
        const dungeonWithCorrectAction = dungeonItems.filter(
            (item) => item.useAction?.actionKey === 'redeem_exclusive_dungeon_access'
        ).length;
        const pendingKinds = [...new Set(pendingItems.map((item) => item.kind))].sort();
        const resolvedRows = await readRows(db, itemIds);
        const legacyNamesRemaining = resolvedRows.filter((row) => (
            ['Feitiço', 'Dungeon exclusiva', 'Item mágico', 'Pedra misteriosa de 12cm'].includes(row.item_name)
        )).length;
        const pendingAsTickets = pendingItems.filter(
            (item) => item.kind === 'ticket_feitico' || item.possessionCategory === 'ticket'
        ).length;

        if (preview.summary.actions !== 8
            || preview.summary.inventoryUnits !== 9
            || preview.summary.dungeonAccessUnits !== 4
            || preview.summary.pendingRewards !== 5
            || preview.summary.templatesToCreate !== 4) {
            throw new Error('Preview integrado divergiu do escopo aprovado.');
        }
        if (applied.updatedRows !== 8 || applied.updatedUnits !== 9 || applied.createdTemplates.length !== 4) {
            throw new Error('Aplicação integrada divergiu do escopo aprovado.');
        }
        if (verified.verifiedRows !== 8
            || verified.verifiedUnits !== 9
            || verified.dungeonAccessUnits !== 4
            || verified.pendingRewardRows !== 5) {
            throw new Error('Verificação integrada divergiu do escopo aprovado.');
        }
        if (dungeonItems.length !== 3 || dungeonUnits !== 4 || dungeonWithCorrectAction !== 3) {
            throw new Error('Os acessos de Dungeon não aparecem corretamente em Posses.');
        }
        if (pendingItems.length !== 5 || pendingWithUseAction !== 0 || pendingAsTickets !== 0) {
            throw new Error('As recompensas pendentes foram apresentadas incorretamente.');
        }
        if (legacyNamesRemaining !== 0) {
            throw new Error('Algum nome legado genérico permaneceu após a resolução.');
        }

        const backupBeforeUndo = await backupSqliteDatabase(testDatabase, undoBackup);
        const undone = await undoResolutionBatch(db, {
            confirm: 'UNDO-LEGACY-EVENT-REWARDS',
            resolutionCode,
            actorId: 'lifecycle-validator',
            timestamp: '2026-07-27T03:35:00.000Z',
        });
        const afterUndoRows = await readRows(db, itemIds);
        const afterUndoTemplates = await readTemplates(db, targetKeys);
        const createdTemplatesAfterUndo = await readTemplates(db, createdKeys);
        const integrity = await db.get('PRAGMA integrity_check');
        const baseRowsRestoredExactly = exactJson(afterUndoRows, beforeRows);
        const templatesRestoredExactly = exactJson(afterUndoTemplates, beforeTemplates);

        if (!baseRowsRestoredExactly || !templatesRestoredExactly || createdTemplatesAfterUndo.length !== 0) {
            throw new Error('Undo não restaurou exatamente as linhas e os modelos relevantes.');
        }

        const summary = {
            ok: true,
            validatorVersion: 1,
            liveDatabaseWrites: false,
            sourceSnapshot: {
                method: sourceCopy.method,
                integrity: sourceCopy.integrity,
                bytes: sourceCopy.bytes,
            },
            preview: preview.summary,
            applied: {
                rows: applied.updatedRows,
                units: applied.updatedUnits,
                templatesCreated: applied.createdTemplates.length,
            },
            verified: {
                rows: verified.verifiedRows,
                units: verified.verifiedUnits,
                dungeonAccessUnits: verified.dungeonAccessUnits,
                pendingRewardRows: verified.pendingRewardRows,
            },
            presentation: {
                playersChecked: playerIds.length,
                dungeonRowsVisible: dungeonItems.length,
                dungeonUnitsVisible: dungeonUnits,
                dungeonActionsCorrect: dungeonWithCorrectAction,
                pendingRowsVisible: pendingItems.length,
                pendingRowsWithUseAction: pendingWithUseAction,
                pendingRowsClassifiedAsTicket: pendingAsTickets,
                pendingKinds,
                legacyNamesRemaining,
            },
            undo: {
                rowsRestored: undone.restoredRows,
                templatesRemoved: undone.removedTemplates,
                baseRowsRestoredExactly,
                templatesRestoredExactly,
                createdTemplatesRemaining: createdTemplatesAfterUndo.length,
            },
            backups: {
                beforeApply: {
                    method: backupBeforeApply.method,
                    integrity: backupBeforeApply.integrity,
                    bytes: backupBeforeApply.bytes,
                },
                beforeUndo: {
                    method: backupBeforeUndo.method,
                    integrity: backupBeforeUndo.integrity,
                    bytes: backupBeforeUndo.bytes,
                },
            },
            database: {
                integrity: integrity?.integrity_check || Object.values(integrity || {})[0] || null,
            },
            files: {
                testDatabase,
                applyBackup,
                undoBackup,
                summary: summaryPath,
            },
        };
        writeJson(summaryPath, summary);
        console.log(JSON.stringify(summary, null, 2));
        console.log(`Resumo: ${summaryPath}`);
    } finally {
        await db.close();
    }

    const finalVerification = await verifySqliteDatabase(testDatabase);
    if (!finalVerification.ok) {
        throw new Error(`Banco de validação terminou inválido: ${finalVerification.integrity}`);
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    if (error?.code) console.error(`Código: ${error.code}`);
    if (error?.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
});
