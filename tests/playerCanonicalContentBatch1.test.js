'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverPlayerContentSchema,
    getCombinedPlayerContent,
    normalizeContentKey,
} = require('../helpers/clover/playerContentService');

const script = path.resolve(__dirname, '..', 'scripts', 'importCanonicalPlayerContentBatch1.js');
const manifest = path.resolve(__dirname, '..', 'data', 'player-canonical-batch-1-import.json');
const sourceManifest = JSON.parse(fs.readFileSync(manifest, 'utf8'));

async function createFixture(filename) {
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            jogo_status TEXT,
            aptidao_comum TEXT,
            aptidao_comum_key TEXT,
            aptidao_rara TEXT,
            aptidao_rara_key TEXT,
            marca_comum TEXT,
            marca_comum_key TEXT,
            marca_rara TEXT,
            marca_rara_key TEXT,
            anomalia TEXT,
            anomalia_key TEXT,
            gancho_narrativo TEXT,
            historias_extras TEXT
        )
    `);

    for (const [index, player] of sourceManifest.players.entries()) {
        await db.run(
            `INSERT INTO jogadores (
                id, nome, display_name, nome_real, personagem_nome, jogo_status,
                aptidao_comum, aptidao_comum_key, marca_comum, marca_comum_key,
                gancho_narrativo, historias_extras
             ) VALUES (?, ?, ?, ?, ?, 'liberado', ?, ?, ?, ?, '-', '[]')`,
            [
                player.playerId,
                player.expectedName,
                player.expectedName,
                '-',
                player.expectedName,
                `Traço legado ${index + 1}`,
                `traco_legado_${index + 1}`,
                `Marca legada ${index + 1}`,
                `marca_legada_${index + 1}`,
            ]
        );
    }
    await db.close();
}

function execute(database, output, extra = []) {
    return spawnSync(process.execPath, [
        script,
        `--db=${database}`,
        `--manifest=${manifest}`,
        `--output=${output}`,
        ...extra,
    ], {
        encoding: 'utf8',
        env: { ...process.env },
    });
}

async function tableExists(db, name) {
    return Boolean(await db.get(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [name]
    ));
}

test('normaliza chaves e combina conteúdo legado com canônico', async (t) => {
    assert.equal(normalizeContentKey('  Máscara de Raposa! '), 'mascara_de_raposa');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-content-service-'));
    const database = path.join(directory, 'banco.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await createFixture(database);

    const db = await open({ filename: database, driver: sqlite3.Database });
    await ensureCloverPlayerContentSchema(db);
    const first = sourceManifest.players[0];
    await db.run(
        `INSERT INTO clover_player_content (
            player_id, content_type, content_key, title, mechanical_status, review_status
         ) VALUES (?, 'system_trait', 'corpo_de_rotina', 'Corpo de Rotina', 'catalog_managed', 'approved')`,
        [first.playerId]
    );

    const combined = await getCombinedPlayerContent(db, first.playerId);
    assert.equal(combined.legacy.traits.length, 2);
    assert.equal(combined.canonical.systemTraits.length, 1);
    assert.equal(combined.canonical.systemTraits[0].title, 'Corpo de Rotina');
    await db.close();
});

test('simulação faz rollback e aplicação importa 22 registros sem tocar nos campos legados', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-content-batch1-'));
    const database = path.join(directory, 'banco.sqlite');
    const output = path.join(directory, 'backups');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await createFixture(database);

    const dryRun = execute(database, output);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /SIMULAÇÃO COM ROLLBACK/);
    assert.match(dryRun.stdout, /Registros esperados: 22/);
    assert.match(dryRun.stdout, /Nenhum dado foi alterado/);

    let db = await open({ filename: database, driver: sqlite3.Database });
    assert.equal(await tableExists(db, 'clover_player_content'), false);
    const legacyBefore = await db.all(
        `SELECT id, aptidao_comum, marca_comum, gancho_narrativo, historias_extras
         FROM jogadores ORDER BY id`
    );
    await db.close();

    const applied = execute(database, output, [
        '--apply',
        '--confirm=IMPORT_CANONICAL_PLAYER_CONTENT_BATCH1',
    ]);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.match(applied.stdout, /Importação concluída e validada/);
    assert.match(applied.stdout, /Inseridos nesta execução: 22/);

    db = await open({ filename: database, driver: sqlite3.Database });
    assert.equal(await tableExists(db, 'clover_player_content'), true);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_content')).total, 22);
    assert.equal((await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_content
         WHERE content_type = 'system_trait' AND mechanical_status = 'catalog_managed'`
    )).total, 9);
    assert.equal((await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_content
         WHERE content_type = 'custom_trait' AND mechanical_status = 'pending_balance'`
    )).total, 7);
    assert.equal((await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_content
         WHERE content_type = 'narrative_hook'`
    )).total, 4);
    assert.equal((await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_content
         WHERE content_type = 'narrative_item' AND linked_content_id IS NOT NULL`
    )).total, 2);

    const legacyAfter = await db.all(
        `SELECT id, aptidao_comum, marca_comum, gancho_narrativo, historias_extras
         FROM jogadores ORDER BY id`
    );
    assert.deepEqual(legacyAfter, legacyBefore);
    await db.close();

    const files = fs.readdirSync(output);
    assert.ok(files.some((name) => /^before-player-content-batch1-.*\.sqlite$/.test(name)));
    assert.ok(files.some((name) => /^player-content-batch1-.*\.json$/.test(name)));
});

test('reexecução idêntica é idempotente e divergência bloqueia sem sobrescrever', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-content-idempotent-'));
    const database = path.join(directory, 'banco.sqlite');
    const output = path.join(directory, 'backups');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await createFixture(database);

    const applyArgs = [
        '--apply',
        '--confirm=IMPORT_CANONICAL_PLAYER_CONTENT_BATCH1',
    ];
    const first = execute(database, output, applyArgs);
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const second = execute(database, output, applyArgs);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /Inseridos nesta execução: 0/);
    assert.match(second.stdout, /Já idênticos: 22/);

    let db = await open({ filename: database, driver: sqlite3.Database });
    await db.run(
        `UPDATE clover_player_content SET body = 'conteúdo divergente'
         WHERE player_id = ? AND content_type = 'custom_trait' AND content_key = 'mascara_de_raposa'`,
        ['75858433855738@lid']
    );
    await db.close();

    const conflict = execute(database, output, applyArgs);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /Conflito com conteúdo já existente/);

    db = await open({ filename: database, driver: sqlite3.Database });
    const row = await db.get(
        `SELECT body FROM clover_player_content
         WHERE player_id = ? AND content_type = 'custom_trait' AND content_key = 'mascara_de_raposa'`,
        ['75858433855738@lid']
    );
    assert.equal(row.body, 'conteúdo divergente');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_content')).total, 22);
    await db.close();
});
