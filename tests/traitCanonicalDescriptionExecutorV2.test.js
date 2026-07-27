'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    applyRepairPlan,
    undoRepairBatch,
} = require('../helpers/clover/traitCanonicalDescriptionExecutorV2');

const ORIGINAL_UPDATED_AT = '2026-06-01T12:34:56.789Z';

async function createDatabase() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_trait_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            effect_text TEXT,
            restrictions_text TEXT,
            updated_at TEXT
        )
    `);
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, description, effect_text, restrictions_text, updated_at)
         VALUES ('T-1', 'Corpo de Rotina', NULL, NULL, NULL, ?)`,
        [ORIGINAL_UPDATED_AT]
    );
    return db;
}

function plan() {
    return {
        mode: 'readonly_plan',
        policy: {
            exactNameOnly: true,
            changesNames: false,
            appliesWrites: false,
            onlyMissing: true,
        },
        actions: [{
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
                effectText: 'Favorece ações praticadas.',
                restrictionsText: 'Não copia técnica avançada.',
            },
        }],
    };
}

test('V2 captura e restaura updated_at exatamente', async () => {
    const db = await createDatabase();
    try {
        const applied = await applyRepairPlan(db, plan(), {
            confirm: APPLY_CONFIRMATION,
            repairCode: 'TDR-V2-TIMESTAMP',
            actorId: 'test',
        });
        assert.equal(applied.timestampsCaptured, 1);
        const afterApply = await db.get(
            'SELECT updated_at FROM clover_trait_templates WHERE id = ?',
            ['T-1']
        );
        assert.notEqual(afterApply.updated_at, ORIGINAL_UPDATED_AT);

        const undone = await undoRepairBatch(db, {
            confirm: UNDO_CONFIRMATION,
            repairCode: 'TDR-V2-TIMESTAMP',
            actorId: 'test-undo',
        });
        assert.equal(undone.timestampsRestored, 1);
        const afterUndo = await db.get(
            'SELECT description, effect_text, restrictions_text, updated_at
             FROM clover_trait_templates WHERE id = ?',
            ['T-1']
        );
        assert.equal(afterUndo.description, null);
        assert.equal(afterUndo.effect_text, null);
        assert.equal(afterUndo.restrictions_text, null);
        assert.equal(afterUndo.updated_at, ORIGINAL_UPDATED_AT);
    } finally {
        await db.close();
    }
});

test('V2 bloqueia undo quando somente updated_at mudou após apply', async () => {
    const db = await createDatabase();
    try {
        await applyRepairPlan(db, plan(), {
            confirm: APPLY_CONFIRMATION,
            repairCode: 'TDR-V2-STALE-TIME',
        });
        await db.run(
            'UPDATE clover_trait_templates SET updated_at = ? WHERE id = ?',
            ['2099-01-01T00:00:00.000Z', 'T-1']
        );
        await assert.rejects(
            undoRepairBatch(db, {
                confirm: UNDO_CONFIRMATION,
                repairCode: 'TDR-V2-STALE-TIME',
            }),
            (error) => error?.code === 'undo_state_mismatch'
        );
        const row = await db.get(
            'SELECT description, updated_at FROM clover_trait_templates WHERE id = ?',
            ['T-1']
        );
        assert.equal(row.description, 'O corpo aprendeu com repetição.');
        assert.equal(row.updated_at, '2099-01-01T00:00:00.000Z');
    } finally {
        await db.close();
    }
});
