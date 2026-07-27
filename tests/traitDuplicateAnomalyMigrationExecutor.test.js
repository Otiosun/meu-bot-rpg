'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    applyMigration,
    previewMigration,
    undoMigration,
    verifyMigration,
} = require('../helpers/clover/traitDuplicateAnomalyMigrationExecutor');

async function createDatabase() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_trait_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            description TEXT,
            effect_text TEXT,
            restrictions_text TEXT,
            trait_kind TEXT NOT NULL,
            source TEXT
        );
        CREATE TABLE clover_player_traits (
            id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            trait_id TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            value_text TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            operation_code TEXT,
            assigned_by TEXT,
            removed_by TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            assigned_at TEXT NOT NULL,
            removed_at TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            source TEXT,
            legacy_ref TEXT,
            assignment_key TEXT
        );
    `);
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, trait_kind, source)
         VALUES (?, ?, 'anomalia', NULL, NULL, NULL, 'system', 'legacy_fixed_slot')`,
        ['SYS-1', 'Infância em Conserva']
    );
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, trait_kind, source)
         VALUES (?, ?, 'extra_anomaly', ?, ?, ?, 'custom', 'legacy_historias_extras')`,
        [
            'CUS-1',
            'Infância em Conserva',
            'Descrição pessoal.',
            'Efeito pessoal.',
            'Restrição pessoal.',
        ]
    );
    await db.run(
        `INSERT INTO clover_player_traits
         (id, player_id, trait_id, slot_key, value_text, active, operation_code,
          assigned_by, removed_by, metadata_json, assigned_at, removed_at,
          position, source, legacy_ref, assignment_key)
         VALUES (10, 'P-RAW', 'SYS-1', 'anomalia', 'Infância em Conserva', 1, NULL,
                 'ADM', NULL, '{"legacyMigration":true}', '2026-07-23T01:30:17.124Z', NULL,
                 0, 'legacy_fixed_slot', 'jogadores.anomalia', 'fixed-10')`
    );
    await db.run(
        `INSERT INTO clover_player_traits
         (id, player_id, trait_id, slot_key, value_text, active, operation_code,
          assigned_by, removed_by, metadata_json, assigned_at, removed_at,
          position, source, legacy_ref, assignment_key)
         VALUES (20, 'P-RAW', 'CUS-1', 'extra_anomaly', 'Infância em Conserva', 1, NULL,
                 'ADM', NULL, '{"legacyMigration":true}', '2026-07-23T01:30:17.340Z', NULL,
                 1, 'legacy_historias_extras', 'jogadores.historias_extras[1]', 'extra-20')`
    );
    return db;
}

function auditFixture() {
    return {
        generatedAt: '2026-07-27T00:00:00.000Z',
        readOnly: true,
        summary: {
            unmatchedSystemTemplates: 1,
            safeMigrationCandidates: 1,
        },
        targets: [
            {
                template: {
                    id: 'SYS-1',
                    name: 'Infância em Conserva',
                    slotKey: 'anomalia',
                    traitKind: 'system',
                    description: null,
                    source: 'legacy_fixed_slot',
                },
                assignments: [
                    {
                        assignmentId: 10,
                        traitId: 'SYS-1',
                        slotKey: 'anomalia',
                        valueText: 'Infância em Conserva',
                        source: 'legacy_fixed_slot',
                        legacyRef: 'jogadores.anomalia',
                    },
                ],
                siblings: [
                    {
                        template: {
                            id: 'CUS-1',
                            name: 'Infância em Conserva',
                            slotKey: 'extra_anomaly',
                            traitKind: 'custom',
                            description: 'Descrição pessoal.',
                            effectText: 'Efeito pessoal.',
                            restrictionsText: 'Restrição pessoal.',
                            source: 'legacy_historias_extras',
                        },
                        assignments: [
                            {
                                assignmentId: 20,
                                traitId: 'CUS-1',
                                slotKey: 'extra_anomaly',
                                valueText: 'Infância em Conserva',
                                source: 'legacy_historias_extras',
                                legacyRef: 'jogadores.historias_extras[1]',
                            },
                        ],
                    },
                ],
                sharedPlayerKeys: ['P-HASH'],
                migrationAssessment: {
                    safeCandidate: true,
                    proposedAction: 'copy_custom_content_to_fixed_assignment_override_and_deactivate_extra_assignment',
                },
            },
        ],
    };
}

function readMetadata(row) {
    return JSON.parse(row.metadata_json || '{}');
}

test('preview valida a duplicação sem escrever', async () => {
    const db = await createDatabase();
    try {
        const result = await previewMigration(db, auditFixture());
        assert.equal(result.writesPerformed, false);
        assert.equal(result.migrations, 1);
        const fixed = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extra = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        assert.equal(readMetadata(fixed).traitOverride, undefined);
        assert.equal(extra.active, 1);
    } finally {
        await db.close();
    }
});

test('apply move conteúdo para override fixo e desativa a cópia extra', async () => {
    const db = await createDatabase();
    try {
        const result = await applyMigration(db, auditFixture(), {
            confirm: APPLY_CONFIRMATION,
            migrationCode: 'TAM-TEST-APPLY',
            actorId: 'test-admin',
        });
        assert.equal(result.migrated, 1);
        const fixed = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extra = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        const metadata = readMetadata(fixed);
        assert.deepEqual(metadata.traitOverride, {
            description: 'Descrição pessoal.',
            effectText: 'Efeito pessoal.',
            restrictionsText: 'Restrição pessoal.',
        });
        assert.equal(metadata.duplicateAnomalyMigration.sourceAssignmentId, 20);
        assert.equal(extra.active, 0);
        assert.equal(extra.operation_code, 'TAM-TEST-APPLY');
        assert.equal(extra.removed_by, 'test-admin');
        assert.ok(extra.removed_at);
    } finally {
        await db.close();
    }
});

test('verify confirma o estado migrado', async () => {
    const db = await createDatabase();
    try {
        await applyMigration(db, auditFixture(), {
            confirm: APPLY_CONFIRMATION,
            migrationCode: 'TAM-TEST-VERIFY',
        });
        const result = await verifyMigration(db, { migrationCode: 'TAM-TEST-VERIFY' });
        assert.equal(result.verified, 1);
        assert.equal(result.fixedOverrides, 1);
        assert.equal(result.extrasDeactivated, 1);
    } finally {
        await db.close();
    }
});

test('undo restaura exatamente os dois vínculos', async () => {
    const db = await createDatabase();
    try {
        const fixedBefore = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extraBefore = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        await applyMigration(db, auditFixture(), {
            confirm: APPLY_CONFIRMATION,
            migrationCode: 'TAM-TEST-UNDO',
            actorId: 'apply-admin',
        });
        const result = await undoMigration(db, {
            confirm: UNDO_CONFIRMATION,
            migrationCode: 'TAM-TEST-UNDO',
            actorId: 'undo-admin',
        });
        assert.equal(result.restored, 1);
        const fixedAfter = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extraAfter = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        for (const field of ['metadata_json', 'operation_code', 'removed_by', 'removed_at', 'active']) {
            assert.equal(fixedAfter[field], fixedBefore[field]);
            assert.equal(extraAfter[field], extraBefore[field]);
        }
    } finally {
        await db.close();
    }
});

test('conteúdo alterado após auditoria bloqueia o lote inteiro', async () => {
    const db = await createDatabase();
    try {
        await db.run(
            'UPDATE clover_trait_templates SET description = ? WHERE id = ?',
            ['Descrição modificada depois da auditoria.', 'CUS-1']
        );
        await assert.rejects(
            applyMigration(db, auditFixture(), {
                confirm: APPLY_CONFIRMATION,
                migrationCode: 'TAM-TEST-ATOMIC',
            }),
            (error) => error?.code === 'custom_content_changed_since_audit'
        );
        const fixed = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extra = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        assert.equal(readMetadata(fixed).traitOverride, undefined);
        assert.equal(extra.active, 1);
        const table = await db.get(
            "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'clover_trait_duplicate_anomaly_migrations'"
        );
        assert.equal(table, undefined);
    } finally {
        await db.close();
    }
});
