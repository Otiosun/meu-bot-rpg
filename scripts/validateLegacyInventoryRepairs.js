'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    applyRepairPlan,
    previewRepairPlan,
    undoRepairBatch,
} = require('../helpers/clover/legacyInventoryRepairExecutor');
const {
    backupSqliteDatabase,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

async function snapshots(db, itemIds, templateKeys) {
    const items = {};
    for (const id of itemIds) {
        items[id] = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [id]) || null;
    }
    const templates = {};
    for (const key of templateKeys) {
        templates[key] = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ?', [key]) || null;
    }
    return { items, templates };
}

function planTargets(plan) {
    const itemIds = new Set();
    const templateKeys = new Set();
    for (const proposal of plan.readyForManualApproval || []) {
        for (const id of proposal.inventoryItemIds || []) itemIds.add(Number(id));
        if (proposal.proposedTemplate?.templateKey) templateKeys.add(proposal.proposedTemplate.templateKey);
        if (proposal.proposedTemplateKey) templateKeys.add(proposal.proposedTemplateKey);
    }
    return { itemIds: [...itemIds].sort((a, b) => a - b), templateKeys: [...templateKeys].sort() };
}

function assertCurrentPlanShape(plan) {
    const proposals = Array.isArray(plan?.readyForManualApproval) ? plan.readyForManualApproval : [];
    assert.equal(proposals.length, 4, 'O plano precisa conter exatamente quatro propostas aprováveis.');
    const merge = proposals.find((proposal) => proposal.operation === 'inventory.legacy.merge_fragments.propose');
    assert.ok(merge, 'A proposta do Pergaminho não foi encontrada.');
    assert.equal(
        merge.proposedTemplate?.templateKey,
        'pergaminho_do_ferreiro',
        'O plano está desatualizado. Regenere a auditoria e o plano antes da validação.'
    );
}

async function main() {
    const sourcePath = path.resolve(argumentValue('db') || 'banco.sqlite');
    const planPath = path.resolve(
        argumentValue('plan')
        || path.join('artifacts', 'legacy-inventory-audit', 'legacy-inventory-repair-plan.json')
    );
    const copyPath = path.resolve(
        argumentValue('copy')
        || path.join('artifacts', 'legacy-inventory-repair', 'validation-copy.sqlite')
    );
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'legacy-inventory-repair', 'validation-result.json')
    );

    if (!fs.existsSync(sourcePath)) throw new Error(`Banco não encontrado: ${sourcePath}`);
    if (!fs.existsSync(planPath)) throw new Error(`Plano não encontrado: ${planPath}`);
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assertCurrentPlanShape(plan);
    const targets = planTargets(plan);
    const backup = await backupSqliteDatabase(sourcePath, copyPath);
    assert.equal(backup.method, 'node:sqlite.backup');

    const db = await open({ filename: copyPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE });
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec('PRAGMA busy_timeout = 10000');

    let report;
    try {
        const preview = await previewRepairPlan(db, plan);
        assert.equal(preview.writesPerformed, false);
        assert.equal(preview.summary.proposals, 4);
        assert.equal(preview.summary.inventoryItemsCovered, 10);
        assert.equal(preview.summary.templatesToCreate, 4);

        const before = await snapshots(db, targets.itemIds, targets.templateKeys);
        const legacyBefore = Number((await db.get(
            "SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key IS NULL OR TRIM(template_key) = ''"
        )).total || 0);
        assert.equal(legacyBefore, 18);

        const applied = await applyRepairPlan(db, plan, {
            confirm: 'APPLY',
            repairCode: 'LIR-VALIDATION-01',
            actorId: 'validation',
            timestamp: '2026-07-26T17:45:00.000Z',
        });
        assert.equal(applied.status, 'applied');
        assert.equal(applied.units.length, 4);

        const legacyApplied = Number((await db.get(
            "SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key IS NULL OR TRIM(template_key) = ''"
        )).total || 0);
        assert.equal(legacyApplied, 8);
        assert.equal(await db.get('SELECT id FROM clover_inventory_items WHERE id = 11'), undefined);
        const pergaminho = await db.get('SELECT * FROM clover_inventory_items WHERE id = 10');
        assert.equal(pergaminho.item_name, 'Pergaminho do Ferreiro');
        assert.equal(pergaminho.template_key, 'pergaminho_do_ferreiro');
        for (const key of targets.templateKeys) {
            assert.ok(await db.get('SELECT template_key FROM clover_item_templates WHERE template_key = ?', [key]));
        }
        const appliedIntegrity = await db.get('PRAGMA integrity_check');
        assert.equal(appliedIntegrity.integrity_check || Object.values(appliedIntegrity)[0], 'ok');

        const duplicateApply = await applyRepairPlan(db, plan, {
            confirm: 'APPLY',
            repairCode: 'LIR-VALIDATION-01',
            actorId: 'validation',
        });
        assert.equal(duplicateApply.duplicate, true);

        const undone = await undoRepairBatch(db, {
            confirm: 'UNDO',
            repairCode: 'LIR-VALIDATION-01',
            actorId: 'validation',
            timestamp: '2026-07-26T17:46:00.000Z',
        });
        assert.equal(undone.status, 'undone');
        assert.equal(undone.units, 4);

        const afterUndo = await snapshots(db, targets.itemIds, targets.templateKeys);
        assert.deepEqual(stable(afterUndo.items), stable(before.items));
        assert.deepEqual(stable(afterUndo.templates), stable(before.templates));
        const legacyUndone = Number((await db.get(
            "SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key IS NULL OR TRIM(template_key) = ''"
        )).total || 0);
        assert.equal(legacyUndone, 18);
        const undoIntegrity = await db.get('PRAGMA integrity_check');
        assert.equal(undoIntegrity.integrity_check || Object.values(undoIntegrity)[0], 'ok');

        report = {
            ok: true,
            sourceDatabase: path.basename(sourcePath),
            validationCopy: path.basename(copyPath),
            backup: {
                method: backup.method,
                integrity: backup.integrity,
                bytes: backup.bytes,
            },
            preview: preview.summary,
            applied: {
                repairCode: applied.repairCode,
                units: applied.units.length,
                legacyBefore,
                legacyAfter: legacyApplied,
                integrity: 'ok',
            },
            idempotency: { duplicateApplyBlocked: true },
            undone: {
                units: undone.units,
                legacyRestored: legacyUndone,
                itemSnapshotsRestored: true,
                templateSnapshotsRestored: true,
                integrity: 'ok',
            },
            liveDatabaseWrites: false,
        };
    } finally {
        await db.close();
    }

    const copyVerification = await verifySqliteDatabase(copyPath);
    assert.equal(copyVerification.ok, true);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    console.log(`Validação salva em: ${outputPath}`);
}

main().catch((error) => {
    console.error(error?.stack || error);
    if (error?.code) console.error(`Código: ${error.code}`);
    if (error?.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
});
