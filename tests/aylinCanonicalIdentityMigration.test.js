'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const script = path.resolve(__dirname, '..', 'scripts', 'migrateAylinCanonicalIdentity.js');
const sourceId = '559391047134@s.whatsapp.net';
const targetId = '225769720701008@lid';

async function createFixture(filename, { targetConflict = false } = {}) {
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            canonical_player_id TEXT,
            nome TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            jogo_status TEXT
        );
        CREATE TABLE clover_character_stats (
            player_id TEXT PRIMARY KEY,
            distribution_status TEXT
        );
        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL
        );
        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alias_value TEXT NOT NULL,
            player_id_destino TEXT NOT NULL
        );
        CREATE TABLE clover_antighost_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT,
            player_id TEXT
        );
        CREATE TABLE clover_antighost_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id TEXT,
            message_id TEXT
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, canonical_player_id, nome, personagem_nome, ficha_status, jogo_status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sourceId, sourceId, 'Aylin', 'Aylin Seraphin Veil.', 'aprovada', 'liberado']
    );
    await db.run(
        'INSERT INTO clover_character_stats (player_id, distribution_status) VALUES (?, ?)',
        [targetConflict ? targetId : sourceId, 'confirmed']
    );
    await db.run('INSERT INTO clover_ph_ledger (player_id, amount) VALUES (?, ?)', [sourceId, 20]);
    await db.run(
        'INSERT INTO clover_player_aliases (alias_value, player_id_destino) VALUES (?, ?)',
        [sourceId, sourceId]
    );
    await db.run(
        'INSERT INTO clover_antighost_events (group_id, player_id) VALUES (?, ?)',
        [targetId, sourceId]
    );
    await db.run(
        'INSERT INTO clover_antighost_messages (participant_id, message_id) VALUES (?, ?)',
        [targetId, 'msg-1']
    );
    await db.close();
}

function execute(args, cwd) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env },
    });
}

test('aceita apenas contexto antighost preexistente e migra Aylin integralmente', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-aylin-identity-'));
    const database = path.join(directory, 'banco.sqlite');
    const output = path.join(directory, 'backups');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await createFixture(database);

    const common = [`--db=${database}`, `--output=${output}`];
    const dryRun = execute(common, directory);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /Contextos preexistentes aceitos/);
    assert.match(dryRun.stdout, /clover_antighost_events\.group_id=1/);
    assert.match(dryRun.stdout, /clover_antighost_messages\.participant_id=1/);
    assert.match(dryRun.stdout, /Nenhum dado foi alterado/);

    const applied = execute([
        ...common,
        '--apply',
        '--confirm=MIGRATE_AYLIN_CANONICAL_IDENTITY',
    ], directory);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.match(applied.stdout, /Migração da Aylin concluída e validada/);

    const db = await open({ filename: database, driver: sqlite3.Database });
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id = ?', [targetId])).personagem_nome, 'Aylin Seraphin Veil.');
    assert.equal(await db.get('SELECT 1 FROM jogadores WHERE id = ?', [sourceId]), undefined);
    assert.equal((await db.get('SELECT player_id FROM clover_character_stats')).player_id, targetId);
    assert.equal((await db.get('SELECT player_id FROM clover_ph_ledger')).player_id, targetId);
    assert.equal((await db.get('SELECT player_id FROM clover_antighost_events')).player_id, targetId);
    assert.equal((await db.get('SELECT group_id FROM clover_antighost_events')).group_id, targetId);
    assert.equal((await db.get('SELECT participant_id FROM clover_antighost_messages')).participant_id, targetId);
    const alias = await db.get('SELECT * FROM clover_player_aliases');
    assert.equal(alias.alias_value, sourceId);
    assert.equal(alias.player_id_destino, targetId);
    await db.close();
});

test('continua bloqueando dado real preexistente no LID de destino', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-aylin-conflict-'));
    const database = path.join(directory, 'banco.sqlite');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await createFixture(database, { targetConflict: true });

    const result = execute([`--db=${database}`], directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clover_character_stats\.player_id=1/);

    const db = await open({ filename: database, driver: sqlite3.Database });
    assert.ok(await db.get('SELECT 1 FROM jogadores WHERE id = ?', [sourceId]));
    assert.equal(await db.get('SELECT 1 FROM jogadores WHERE id = ?', [targetId]), undefined);
    await db.close();
});
