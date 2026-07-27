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
} = require('../helpers/clover/traitDuplicateAnomalyMigrationExecutorV2');

const ORIGINAL_HISTORY = JSON.stringify([
    {
        type: 'anomalia',
        title: 'Infância em Conserva',
        description: 'Descrição pessoal.',
    },
]);

async function createDatabase() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            historias_extras TEXT,
            aptidao_comum TEXT,
            marca_comum TEXT,
            aptidao_rara TEXT,
            marca_rara TEXT,
            anomalia TEXT
        );
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
        `INSERT INTO jogadores
         (id, personagem_nome, historias_extras, anomalia)
         VALUES ('P-RAW', 'Caelus', ?, 'Infância em Conserva')`,
        [ORIGINAL_HISTORY]
    );
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, trait_kind, source)
         VALUES (?, ?, 'anomalia', NULL, NULL, NULL, 'system', 'legacy_fixed_slot')`,
        ['SYS-1', 'Infância em Conserva']
    );
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, trait_kind, source)
         VALUES (?, ?, 'extra_anomaly', ?, NULL, NULL, 'custom', 'legacy_historias_extras')`,
        ['CUS-1', 'Infância em Conserva', 'Descrição pessoal.']
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
                 1, 'legacy_historias_extras', 'jogadores.historias_extras[0]', 'extra-20')`
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
                            effectText: null,
                            restrictionsText: null,
                            source: 'legacy_historias_extras',
                        },
                        assignments: [
                            {
                                assignmentId: 20,
                                traitId: 'CUS-1',
                                slotKey: 'extra_anomaly',
                                valueText: 'Infância em Conserva',
                                source: 'legacy_historias_extras',
                                legacyRef: 'jogadores.historias_extras[0]',
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

function metadata(row) {
    return JSON.parse(row.metadata_json || '{}');
}

test('V2 preview inclui a remoção da entrada legada sem escrever', async () => {
    const db = await createDatabase();
    try {
        const result = await previewMigration(db, auditFixture());
        assert.equal(result.executorVersion, 2);
        assert.equal(result.writesPerformed, false);
        assert.equal(result.migrations, 1);
        assert.equal(result.legacyEntriesRemoved, 1);
        const player = await db.get('SELECT historias_extras FROM jogadores WHERE id = ?', ['P-RAW']);
        const fixed = await db.get('SELECT metadata_json FROM clover_player_traits WHERE id = 10');
        const extra = await db.get('SELECT active FROM clover_player_traits WHERE id = 20');
        assert.equal(player.historias_extras, ORIGINAL_HISTORY);
        assert.equal(metadata(fixed).traitOverride, undefined);
        assert.equal(extra.active, 1);
    } finally {
        await db.close();
    }
});

test('V2 apply remove o fallback legado e preserva o texto no slot fixo', async () => {
    const db = await createDatabase();
    try {
        const result = await applyMigration(db, auditFixture(), {
            confirm: APPLY_CONFIRMATION,
            migrationCode: 'TAM-V2-APPLY',
            actorId: 'test-admin',
        });
        assert.equal(result.executorVersion, 2);
        assert.equal(result.migrated, 1);
        assert.equal(result.legacyEntriesRemoved, 1);

        const fixed = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extra = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        const player = await db.get('SELECT historias_extras FROM jogadores WHERE id = ?', ['P-RAW']);
        assert.deepEqual(metadata(fixed).traitOverride, {
            description: 'Descrição pessoal.',
        });
        assert.equal(extra.active, 0);
        assert.equal(extra.operation_code, 'TAM-V2-APPLY');
        assert.equal(player.historias_extras, '[]');
    } finally {
        await db.close();
    }
});

test('V2 verify e undo restauram vínculo e historias_extras exatamente', async () => {
    const db = await createDatabase();
    try {
        const fixedBefore = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extraBefore = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        const playerBefore = await db.get('SELECT historias_extras FROM jogadores WHERE id = ?', ['P-RAW']);

        await applyMigration(db, auditFixture(), {
            confirm: APPLY_CONFIRMATION,
            migrationCode: 'TAM-V2-UNDO',
            actorId: 'apply-admin',
        });
        const verified = await verifyMigration(db, { migrationCode: 'TAM-V2-UNDO' });
        assert.equal(verified.verified, 1);
        assert.equal(verified.legacyEntriesRemoved, 1);

        const undone = await undoMigration(db, {
            confirm: UNDO_CONFIRMATION,
            migrationCode: 'TAM-V2-UNDO',
            actorId: 'undo-admin',
        });
        assert.equal(undone.restored, 1);
        assert.equal(undone.legacyEntriesRestored, 1);

        const fixedAfter = await db.get('SELECT * FROM clover_player_traits WHERE id = 10');
        const extraAfter = await db.get('SELECT * FROM clover_player_traits WHERE id = 20');
        const playerAfter = await db.get('SELECT historias_extras FROM jogadores WHERE id = ?', ['P-RAW']);
        for (const field of ['metadata_json', 'operation_code', 'removed_by', 'removed_at', 'active']) {
            assert.equal(fixedAfter[field], fixedBefore[field]);
            assert.equal(extraAfter[field], extraBefore[field]);
        }
        assert.equal(playerAfter.historias_extras, playerBefore.historias_extras);
        assert.equal(playerAfter.historias_extras, ORIGINAL_HISTORY);
    } finally {
        await db.close();
    }
});

test('V2 bloqueia lote inteiro quando historias_extras mudou após auditoria', async () => {
    const db = await createDatabase();
    try {
        await db.run(
            'UPDATE jogadores SET historias_extras = ? WHERE id = ?',
            [JSON.stringify([{ type: 'anomalia', title: 'Outro título', description: 'Outro texto.' }]), 'P-RAW']
        );
        await assert.rejects(
            applyMigration(db, auditFixture(), {
                confirm: APPLY_CONFIRMATION,
                migrationCode: 'TAM-V2-STALE-LEGACY',
            }),
            (error) => error?.code === 'legacy_extra_changed_since_audit'
        );
        const fixed = await db.get('SELECT metadata_json FROM clover_player_traits WHERE id = 10');
        const extra = await db.get('SELECT active FROM clover_player_traits WHERE id = 20');
        assert.equal(metadata(fixed).traitOverride, undefined);
        assert.equal(extra.active, 1);
        const table = await db.get(
            `SELECT 1 AS found FROM sqlite_master
             WHERE type = 'table' AND name = 'clover_trait_duplicate_anomaly_migrations_v2'`
        );
        assert.equal(table, undefined);
    } finally {
        await db.close();
    }
});
