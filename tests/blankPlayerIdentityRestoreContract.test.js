'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const cleanup = require('../helpers/clover/blankPlayerIdentityCleanupService');
const restore = require('../helpers/clover/blankPlayerIdentityRestoreService');
const runner = require('../scripts/restoreBlankPlayerIdentities');

const PLAYER_COLUMNS = [
    'id',
    'nome',
    'display_name',
    'personagem_nome',
    'canonical_player_id',
    'ficha_status',
    'jogo_status',
    'esquadrao',
    'is_shadow',
    'merged_into',
    'archived_at',
    'archive_reason',
];

function placeholder(overrides = {}) {
    return {
        id: null,
        nome: 'Cacador',
        display_name: 'Cacador',
        personagem_nome: '-',
        canonical_player_id: null,
        ficha_status: 'incompleta',
        jogo_status: 'bloqueado',
        esquadrao: '-',
        is_shadow: 0,
        merged_into: null,
        archived_at: null,
        archive_reason: null,
        ...overrides,
    };
}

function cleanupReceipt(archiveIds = [1, 2], rowids = [48, 54]) {
    return {
        version: 'clover.blank-player-identity-cleanup.v1',
        write: true,
        mode: 'apply',
        database: {
            sha256Before: 'source-hash',
            sha256After: 'cleaned-hash',
        },
        plan: {
            safe: true,
            rowCount: rowids.length,
            rowids,
        },
        applied: {
            archivedCount: rowids.length,
            deletedCount: rowids.length,
            containmentInstalled: true,
            archived: rowids.map((sourceRowid, index) => ({
                archiveId: archiveIds[index],
                sourceRowid,
            })),
        },
    };
}

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            canonical_player_id TEXT DEFAULT NULL,
            ficha_status TEXT DEFAULT 'incompleta',
            jogo_status TEXT DEFAULT 'bloqueado',
            esquadrao TEXT DEFAULT '-',
            is_shadow INTEGER DEFAULT 0,
            merged_into TEXT DEFAULT NULL,
            archived_at TEXT DEFAULT NULL,
            archive_reason TEXT DEFAULT NULL
        )
    `);
    await cleanup.ensureContainmentSchema(db);
    const archiveIds = [];
    for (const sourceRowid of [48, 54]) {
        const result = await db.run(
            `INSERT INTO ${cleanup.ARCHIVE_TABLE}
             (source_database_sha256, source_rowid, row_json, archived_by, reason)
             VALUES (?, ?, ?, ?, ?)`,
            [
                'source-hash',
                sourceRowid,
                JSON.stringify(placeholder()),
                'phase0-simulation',
                'Limpeza simulada dos placeholders',
            ]
        );
        archiveIds.push(Number(result.lastID));
    }
    return {
        db,
        archiveIds,
        receipt: cleanupReceipt(archiveIds),
    };
}

test('parseArgs aceita recibo e apply exige metadados antes de IO', () => {
    const parsed = runner.parseArgs([
        '--db=cleaned.sqlite',
        '--cleanup-receipt=cleanup.json',
        '--output=restore.json',
        '--backup=before-restore.sqlite',
        '--expected-runner-sha=abc123',
        '--expected-db-sha256=cleaned-hash',
        '--actor=owner@lid',
        '--reason=Restauração controlada',
        '--apply',
    ]);
    assert.equal(parsed.cleanupReceipt, 'cleanup.json');
    assert.equal(parsed.apply, true);
    assert.equal(runner.sameSha('abcdef1234', 'abcdef'), true);
    assert.throws(
        () => runner.validateApplyOptions({ apply: true }),
        (error) => error?.code === 'apply_output_required'
    );
    assert.throws(
        () => runner.validateApplyOptions({
            apply: true,
            output: 'out.json',
            backup: 'backup.sqlite',
            actor: 'owner',
            reason: 'curto',
        }),
        (error) => error?.code === 'restore_reason_required'
    );
});

test('recibo válido autoriza apenas os arquivos e rowids declarados', () => {
    const evidence = restore.validateCleanupReceipt(cleanupReceipt(), 'cleaned-hash');
    assert.equal(evidence.expectedCount, 2);
    assert.deepEqual(evidence.archiveIds, [1, 2]);
    assert.deepEqual(evidence.sourceRowids, [48, 54]);
    assert.equal(evidence.sourceDatabaseSha256, 'source-hash');

    const tampered = cleanupReceipt();
    tampered.database.sha256After = 'outro-hash';
    tampered.applied.deletedCount = 1;
    assert.throws(
        () => restore.validateCleanupReceipt(tampered, 'cleaned-hash'),
        (error) => error?.code === 'unsafe_cleanup_receipt'
            && error.details.errors.includes('cleanup_receipt_database_hash_mismatch')
            && error.details.errors.includes('cleanup_count_mismatch')
    );
});

test('plano read-only confirma schema, arquivo, rowids e contenção', async (t) => {
    const { db, receipt } = await fixture();
    t.after(() => db.close());
    const evidence = restore.validateCleanupReceipt(receipt, 'cleaned-hash');
    const plan = await restore.buildRestorePlan(db, evidence);
    assert.equal(plan.safe, true);
    assert.equal(plan.rowCount, 2);
    assert.deepEqual(plan.rowids, [48, 54]);
    assert.deepEqual(plan.columns, PLAYER_COLUMNS);
    assert.deepEqual(plan.triggers, [cleanup.INSERT_TRIGGER, cleanup.UPDATE_TRIGGER].sort());
});

test('plano bloqueia linha já restaurada, assinatura alterada e conflito de rowid', async (t) => {
    const first = await fixture();
    t.after(() => first.db.close());
    await first.db.run(
        `UPDATE ${cleanup.ARCHIVE_TABLE}
         SET restored_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [first.archiveIds[0]]
    );
    const firstEvidence = restore.validateCleanupReceipt(first.receipt, 'cleaned-hash');
    await assert.rejects(
        () => restore.buildRestorePlan(first.db, firstEvidence),
        (error) => error?.code === 'archive_row_already_restored'
    );

    const second = await fixture();
    t.after(() => second.db.close());
    await second.db.run(
        `UPDATE ${cleanup.ARCHIVE_TABLE}
         SET row_json = ?
         WHERE id = ?`,
        [JSON.stringify(placeholder({ nome: 'Jogador real' })), second.archiveIds[0]]
    );
    const secondEvidence = restore.validateCleanupReceipt(second.receipt, 'cleaned-hash');
    await assert.rejects(
        () => restore.buildRestorePlan(second.db, secondEvidence),
        (error) => error?.code === 'archived_placeholder_signature_mismatch'
    );

    const third = await fixture();
    t.after(() => third.db.close());
    await third.db.run(
        `INSERT INTO jogadores (rowid, id, nome)
         VALUES (48, 'occupied@lid', 'Ocupado')`
    );
    const thirdEvidence = restore.validateCleanupReceipt(third.receipt, 'cleaned-hash');
    await assert.rejects(
        () => restore.buildRestorePlan(third.db, thirdEvidence),
        (error) => error?.code === 'restore_rowid_conflict'
    );
});

test('apply restaura rowids e payloads, marca arquivo e reinstala contenção', async (t) => {
    const { db, receipt } = await fixture();
    t.after(() => db.close());
    const evidence = restore.validateCleanupReceipt(receipt, 'cleaned-hash');
    const plan = await restore.buildRestorePlan(db, evidence);
    const result = await restore.applyRestorePlan(db, plan, {
        actor: 'owner@lid',
        reason: 'Restauração transacional da simulação privada',
    });

    assert.equal(result.write, true);
    assert.equal(result.restoredCount, 2);
    assert.equal(result.archiveRowsMarkedRestored, 2);
    assert.equal(result.containmentReinstalled, true);

    const players = await db.all(
        `SELECT rowid AS source_rowid, *
         FROM jogadores
         ORDER BY rowid`
    );
    assert.deepEqual(players.map((row) => row.source_rowid), [48, 54]);
    assert.equal(players.every((row) => cleanup.isExactCacadorPlaceholder(row)), true);

    const archived = await db.all(
        `SELECT restored_at, restored_by, restore_reason
         FROM ${cleanup.ARCHIVE_TABLE}
         ORDER BY id`
    );
    assert.equal(archived.every((row) => Boolean(row.restored_at)), true);
    assert.equal(archived.every((row) => row.restored_by === 'owner@lid'), true);

    await assert.rejects(
        () => db.run("INSERT INTO jogadores (id, nome) VALUES (NULL, 'probe')"),
        /player_id_required/
    );
    await assert.rejects(
        () => db.run("UPDATE jogadores SET id = NULL WHERE rowid = 48"),
        /player_id_required/
    );
});

test('schema diferente do arquivo impede restauração', async (t) => {
    const { db, receipt } = await fixture();
    t.after(() => db.close());
    await db.exec('ALTER TABLE jogadores ADD COLUMN nova_coluna TEXT DEFAULT NULL');
    const evidence = restore.validateCleanupReceipt(receipt, 'cleaned-hash');
    await assert.rejects(
        () => restore.buildRestorePlan(db, evidence),
        (error) => error?.code === 'archived_player_schema_mismatch'
            && error.details.missingInArchive.includes('nova_coluna')
    );
});

test('drift detectado dentro da transação executa rollback sem restaurar parcialmente', async (t) => {
    const { db, receipt, archiveIds } = await fixture();
    t.after(() => db.close());
    const evidence = restore.validateCleanupReceipt(receipt, 'cleaned-hash');
    const plan = await restore.buildRestorePlan(db, evidence);

    await db.run(
        `UPDATE ${cleanup.ARCHIVE_TABLE}
         SET row_json = ?
         WHERE id = ?`,
        [JSON.stringify(placeholder({ jogo_status: 'liberado' })), archiveIds[1]]
    );

    await assert.rejects(
        () => restore.applyRestorePlan(db, plan, {
            actor: 'owner@lid',
            reason: 'Restauração que deve falhar por drift',
        }),
        (error) => error?.code === 'archived_placeholder_signature_mismatch'
    );

    const players = await db.get('SELECT COUNT(*) AS total FROM jogadores');
    const restored = await db.get(
        `SELECT COUNT(*) AS total
         FROM ${cleanup.ARCHIVE_TABLE}
         WHERE restored_at IS NOT NULL`
    );
    assert.equal(Number(players.total), 0);
    assert.equal(Number(restored.total), 0);
});
