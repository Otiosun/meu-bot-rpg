'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { RESET_JOURNAL_MIGRATION } = require('../helpers/clover/resetJournalSchemaMigration');
const { CLOVER_SCRIPT_JOURNAL_MIGRATION } = require('../helpers/clover/cloverScriptSchemaMigration');
const { GLOBAL_RESET_JOURNAL_FREEZE_MIGRATION } = require('../helpers/clover/globalResetJournalFreezeMigration');
const { GLOBAL_RESET_CHILD_EVENT_GUARD_MIGRATION } = require('../helpers/clover/globalResetChildEventGuardMigration');
const {
    armMigrationOwnedRuntimeSchemaGuard,
} = require('../helpers/clover/migrationOwnedRuntimeSchemaGuard');
const { ensureCloverScriptSchema } = require('../helpers/clover/cloverScriptService');
const { ensurePlayerResetSchema } = require('../helpers/clover/playerResetService');
const { ensureGlobalPlayerResetSchema } = require('../helpers/clover/globalPlayerResetService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-runtime-schema-'));
    const filename = path.join(dir, 'fixture.sqlite');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'bloqueado'
        );
    `);
    await RESET_JOURNAL_MIGRATION.up(db);
    await CLOVER_SCRIPT_JOURNAL_MIGRATION.up(db);
    await GLOBAL_RESET_JOURNAL_FREEZE_MIGRATION.up(db);
    await GLOBAL_RESET_CHILD_EVENT_GUARD_MIGRATION.up(db);
    await armMigrationOwnedRuntimeSchemaGuard(db);

    const tamper = await open({ filename, driver: sqlite3.Database });
    t.after(async () => {
        await tamper.close().catch(() => {});
        await db.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { db, tamper };
}

async function objectExists(db, type, name) {
    const row = await db.get(
        'SELECT 1 AS found FROM sqlite_schema WHERE type = ? AND name = ? LIMIT 1',
        [type, name]
    );
    return Boolean(row?.found);
}

test('schema exato: ensures legados viram no-op certificado, sem DDL real', async (t) => {
    const { db } = await fixture(t);
    await ensureCloverScriptSchema(db);
    await ensurePlayerResetSchema(db);
    await ensureGlobalPlayerResetSchema(db);

    assert.equal(await objectExists(db, 'table', 'clover_script_runs'), true);
    assert.equal(await objectExists(db, 'table', 'clover_player_reset_events'), true);
    assert.equal(await objectExists(db, 'trigger', 'trg_global_reset_child_event_insert_guard'), true);
});

test('drift 0031: CloverScript falha fechado e nao recria tabela removida', async (t) => {
    const { db, tamper } = await fixture(t);
    await tamper.exec('DROP TABLE clover_script_runs');
    assert.equal(await objectExists(db, 'table', 'clover_script_runs'), false);

    await assert.rejects(
        () => ensureCloverScriptSchema(db),
        (error) => error?.code === 'clover_script_runtime_schema_drift'
    );
    assert.equal(await objectExists(db, 'table', 'clover_script_runs'), false);
});

test('drift 0030: reset individual falha fechado e nao auto-repara journal', async (t) => {
    const { db, tamper } = await fixture(t);
    await tamper.exec('DROP TABLE clover_player_reset_restores');
    assert.equal(await objectExists(db, 'table', 'clover_player_reset_restores'), false);

    await assert.rejects(
        () => ensurePlayerResetSchema(db),
        (error) => error?.code === 'reset_journal_runtime_schema_drift'
    );
    assert.equal(await objectExists(db, 'table', 'clover_player_reset_restores'), false);
});

for (const [migration, triggerName] of [
    ['0032', 'trg_global_player_reset_operations_frozen_update'],
    ['0033', 'trg_global_reset_child_event_insert_guard'],
]) {
    test(`drift ${migration}: reset global recusa operar sem guard e nao recria trigger`, async (t) => {
        const { db, tamper } = await fixture(t);
        await tamper.exec(`DROP TRIGGER ${triggerName}`);
        assert.equal(await objectExists(db, 'trigger', triggerName), false);

        await assert.rejects(
            () => ensureGlobalPlayerResetSchema(db),
            (error) => error?.code === 'global_reset_runtime_guard_drift'
        );
        assert.equal(await objectExists(db, 'trigger', triggerName), false);
    });
}
