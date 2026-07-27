'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    applyRepairPlan,
    ensureSupportedPlan,
    previewRepairPlan,
    undoRepairBatch,
    verifyAppliedPlan,
} = require('../helpers/clover/traitCanonicalDescriptionExecutor');

async function createDatabase() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_trait_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slot_key TEXT,
            description TEXT,
            effect_text TEXT,
            restrictions_text TEXT,
            updated_at TEXT
        )
    `);
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text)
         VALUES (?, ?, ?, NULL, NULL, NULL)`,
        ['T-1', 'Corpo de Rotina', 'aptidao_comum']
    );
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text)
         VALUES (?, ?, ?, ?, NULL, NULL)`,
        ['C-1', 'Infância em Conserva', 'extra_anomaly', 'Descrição pessoal preservada.']
    );
    return db;
}

function validPlan() {
    return {
        mode: 'readonly_plan',
        policy: {
            exactNameOnly: true,
            changesNames: false,
            appliesWrites: false,
            onlyMissing: true,
        },
        actions: [
            {
                templateId: 'T-1',
                matchMethod: 'exact_normalized_name',
                namePreserved: true,
                before: {
                    name: 'Corpo de Rotina',
                    description: null,
                    effectText: null,
                    restrictionsText: null,
                },
                after: {
                    name: 'Corpo de Rotina',
                    description: 'O corpo aprendeu com repetição.',
                    effectText: 'Favorece ações treinadas.',
                    restrictionsText: 'Não copia técnica avançada.',
                },
            },
        ],
    };
}

test('preview valida sem escrever', async () => {
    const db = await createDatabase();
    try {
        const result = await previewRepairPlan(db, validPlan());
        assert.equal(result.writesPerformed, false);
        assert.equal(result.updates, 1);
        const row = await db.get('SELECT * FROM clover_trait_templates WHERE id = ?', ['T-1']);
        assert.equal(row.description, null);
    } finally {
        await db.close();
    }
});

test('apply preenche descrição, efeito e restrições sem alterar nomes ou personalizado', async () => {
    const db = await createDatabase();
    try {
        const result = await applyRepairPlan(db, validPlan(), {
            confirm: APPLY_CONFIRMATION,
            repairCode: 'TDR-TEST-APPLY',
            actorId: 'test',
        });
        assert.equal(result.updated, 1);
        assert.equal(result.namesChanged, 0);
        const target = await db.get('SELECT * FROM clover_trait_templates WHERE id = ?', ['T-1']);
        assert.equal(target.name, 'Corpo de Rotina');
        assert.equal(target.description, 'O corpo aprendeu com repetição.');
        assert.equal(target.effect_text, 'Favorece ações treinadas.');
        assert.equal(target.restrictions_text, 'Não copia técnica avançada.');
        const custom = await db.get('SELECT * FROM clover_trait_templates WHERE id = ?', ['C-1']);
        assert.equal(custom.description, 'Descrição pessoal preservada.');
    } finally {
        await db.close();
    }
});

test('verify confirma o estado aplicado', async () => {
    const db = await createDatabase();
    try {
        await applyRepairPlan(db, validPlan(), {
            confirm: APPLY_CONFIRMATION,
            repairCode: 'TDR-TEST-VERIFY',
        });
        const result = await verifyAppliedPlan(db, validPlan());
        assert.equal(result.verified, 1);
        assert.equal(result.namesChanged, 0);
    } finally {
        await db.close();
    }
});

test('undo restaura exatamente o estado anterior', async () => {
    const db = await createDatabase();
    try {
        await applyRepairPlan(db, validPlan(), {
            confirm: APPLY_CONFIRMATION,
            repairCode: 'TDR-TEST-UNDO',
        });
        const result = await undoRepairBatch(db, {
            confirm: UNDO_CONFIRMATION,
            repairCode: 'TDR-TEST-UNDO',
            actorId: 'test-undo',
        });
        assert.equal(result.restored, 1);
        const target = await db.get('SELECT * FROM clover_trait_templates WHERE id = ?', ['T-1']);
        assert.equal(target.name, 'Corpo de Rotina');
        assert.equal(target.description, null);
        assert.equal(target.effect_text, null);
        assert.equal(target.restrictions_text, null);
    } finally {
        await db.close();
    }
});

test('plano que tenta reescrever nome é bloqueado', () => {
    const plan = validPlan();
    plan.actions[0].after.name = 'Outro Nome';
    assert.throws(
        () => ensureSupportedPlan(plan),
        (error) => error?.code === 'name_rewrite_forbidden'
    );
});

test('divergência em uma ação bloqueia todo o lote antes de escrever', async () => {
    const db = await createDatabase();
    try {
        const plan = validPlan();
        plan.actions.push({
            templateId: 'C-1',
            matchMethod: 'exact_normalized_name',
            namePreserved: true,
            before: {
                name: 'Infância em Conserva',
                description: null,
                effectText: null,
                restrictionsText: null,
            },
            after: {
                name: 'Infância em Conserva',
                description: 'Texto incorreto.',
                effectText: null,
                restrictionsText: null,
            },
        });
        await assert.rejects(
            applyRepairPlan(db, plan, {
                confirm: APPLY_CONFIRMATION,
                repairCode: 'TDR-TEST-ATOMIC',
            }),
            (error) => error?.code === 'stale_plan'
        );
        const target = await db.get('SELECT * FROM clover_trait_templates WHERE id = ?', ['T-1']);
        assert.equal(target.description, null);

        const repairTable = await db.get(
            `SELECT COUNT(*) AS total
             FROM sqlite_master
             WHERE type = 'table' AND name = 'clover_trait_description_repairs'`
        );
        assert.equal(Number(repairTable.total), 0);
    } finally {
        await db.close();
    }
});
