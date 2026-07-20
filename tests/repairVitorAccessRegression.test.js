'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    PLAYER_ID,
    REPAIR_ACTOR,
    REQUIRED_CONFIRMATION,
    repairVitorAccess,
} = require('../scripts/repairVitorAccessRegression');

async function createDatabase(root, options = {}) {
    const databaseFile = path.join(root, 'banco.sqlite');
    const db = await open({ filename: databaseFile, driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            canonical_player_id TEXT,
            personagem_nome TEXT,
            display_name TEXT,
            nome TEXT,
            nome_real TEXT,
            ficha_status TEXT,
            personagem_aparencia_status TEXT,
            historia_status TEXT,
            historia_status_updated_at TEXT,
            jogo_status TEXT,
            jogo_bloqueio_motivo TEXT,
            jogo_liberado_at TEXT,
            jogo_liberado_by TEXT,
            identity_status TEXT DEFAULT 'active',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            merged_into TEXT
        );
        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            started_at TEXT,
            welcome_sent_at TEXT,
            last_seen_at TEXT,
            current_step TEXT,
            step_payload TEXT
        );
    `);

    await db.run(
        `INSERT INTO jogadores (
            id, canonical_player_id, personagem_nome, ficha_status,
            personagem_aparencia_status, historia_status, historia_status_updated_at,
            jogo_status, jogo_bloqueio_motivo, jogo_liberado_at, jogo_liberado_by,
            identity_status, lifecycle_status, is_shadow, merged_into
         ) VALUES (?, ?, 'Vitor', 'aprovada', 'pending', 'pendente',
                   '2026-06-07 23:50:03', ?, ?, ?, ?, 'active', 'active', 0, NULL)`,
        [
            PLAYER_ID,
            PLAYER_ID,
            options.gameStatus || 'bloqueado',
            options.blockReason ?? null,
            options.releasedAt ?? null,
            options.releasedBy ?? null,
        ]
    );

    await db.run(
        `INSERT INTO player_onboarding (
            player_id, started_at, welcome_sent_at, last_seen_at, current_step, step_payload
         ) VALUES (?, '2026-06-07 22:42:05', '2026-06-07 22:42:05',
                   '2026-06-10 05:03:15', ?, ?)`,
        [
            PLAYER_ID,
            options.currentStep || 'jogo_liberado',
            options.stepPayload || JSON.stringify({ last_message: 'jogo_liberado_historia_pendente_migracao' }),
        ]
    );

    await db.close();
    return databaseFile;
}

async function readPlayer(databaseFile) {
    const db = await open({ filename: databaseFile, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        return await db.get('SELECT * FROM jogadores WHERE id = ?', [PLAYER_ID]);
    } finally {
        await db.close();
    }
}

test('simulação repara e faz rollback; aplicação cria backup e libera Vitor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitor-access-repair-'));
    const outputDir = path.join(root, 'backups');
    const databaseFile = await createDatabase(root);

    const dryRun = await repairVitorAccess({ databaseFile, outputDir, apply: false });
    assert.equal(dryRun.repaired, true);
    assert.equal(dryRun.committed, false);
    assert.equal((await readPlayer(databaseFile)).jogo_status, 'bloqueado');

    const applied = await repairVitorAccess({
        databaseFile,
        outputDir,
        apply: true,
        confirmation: REQUIRED_CONFIRMATION,
    });

    assert.equal(applied.repaired, true);
    assert.equal(applied.committed, true);
    assert.ok(applied.backupFile);
    assert.ok(fs.existsSync(applied.backupFile));

    const player = await readPlayer(databaseFile);
    assert.equal(player.jogo_status, 'liberado');
    assert.equal(player.jogo_liberado_at, '2026-06-10 05:03:15');
    assert.equal(player.jogo_liberado_by, REPAIR_ACTOR);
    assert.equal(player.jogo_bloqueio_motivo, null);
});

test('reexecução reconhece Vitor já liberado sem nova alteração', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitor-access-idempotent-'));
    const databaseFile = await createDatabase(root, {
        gameStatus: 'liberado',
        releasedAt: '2026-06-10 05:03:15',
        releasedBy: REPAIR_ACTOR,
    });

    const result = await repairVitorAccess({
        databaseFile,
        outputDir: path.join(root, 'backups'),
        apply: true,
        confirmation: REQUIRED_CONFIRMATION,
    });

    assert.equal(result.alreadyReleased, true);
    assert.equal(result.repaired, false);
    assert.equal(result.committed, false);
    const player = await readPlayer(databaseFile);
    assert.equal(player.jogo_liberado_by, REPAIR_ACTOR);
});

test('bloqueio administrativo ou onboarding sem evidência impedem reparação', async () => {
    const rootWithReason = fs.mkdtempSync(path.join(os.tmpdir(), 'vitor-access-reason-'));
    const databaseWithReason = await createDatabase(rootWithReason, { blockReason: 'bloqueio administrativo' });

    await assert.rejects(
        repairVitorAccess({ databaseFile: databaseWithReason, outputDir: path.join(rootWithReason, 'backups') }),
        /assinatura exata da regressão/
    );
    assert.equal((await readPlayer(databaseWithReason)).jogo_status, 'bloqueado');

    const rootWithoutEvidence = fs.mkdtempSync(path.join(os.tmpdir(), 'vitor-access-no-evidence-'));
    const databaseWithoutEvidence = await createDatabase(rootWithoutEvidence, {
        currentStep: 'cadastro_aprovado',
        stepPayload: JSON.stringify({ last_message: 'ficha_confirmada' }),
    });

    await assert.rejects(
        repairVitorAccess({ databaseFile: databaseWithoutEvidence, outputDir: path.join(rootWithoutEvidence, 'backups') }),
        /onboarding não comprova/
    );
    assert.equal((await readPlayer(databaseWithoutEvidence)).jogo_status, 'bloqueado');
});
