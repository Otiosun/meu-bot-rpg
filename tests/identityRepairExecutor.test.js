'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'executePlayerIdentityRepairs.js');

async function createFixture(root) {
    const dbFile = path.join(root, 'executor.sqlite');
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            canonical_player_id TEXT
        );
        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            step TEXT
        );
        CREATE TABLE clover_character_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL UNIQUE,
            ph_available INTEGER DEFAULT 0
        );
        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL
        );
        CREATE TABLE player_rolls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            result TEXT
        );
        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alias_value TEXT,
            player_id_destino TEXT
        );
    `);

    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', ['551100000001@s.whatsapp.net', 'Cacador', null]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', ['101@lid', 'Real', '101@lid']);
    await db.run('INSERT INTO player_onboarding VALUES (?, ?)', ['551100000001@s.whatsapp.net', 'start']);
    await db.run('INSERT INTO player_onboarding VALUES (?, ?)', ['101@lid', 'done']);
    await db.run('INSERT INTO clover_character_stats (player_id, ph_available) VALUES (?, ?)', ['551100000001@s.whatsapp.net', 0]);
    await db.run('INSERT INTO clover_character_stats (player_id, ph_available) VALUES (?, ?)', ['101@lid', 25]);
    await db.run('INSERT INTO clover_ph_ledger (player_id, amount) VALUES (?, ?)', ['551100000001@s.whatsapp.net', 3]);
    await db.run('INSERT INTO clover_player_aliases (alias_value, player_id_destino) VALUES (?, ?)', ['551100000001@s.whatsapp.net', '551100000001@s.whatsapp.net']);

    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', ['551100000002@s.whatsapp.net', 'Migrar', null]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', ['102@lid', 'Cacador', '102@lid']);
    await db.run('INSERT INTO clover_character_stats (player_id, ph_available) VALUES (?, ?)', ['551100000002@s.whatsapp.net', 90]);
    await db.run('INSERT INTO clover_character_stats (player_id, ph_available) VALUES (?, ?)', ['102@lid', 0]);
    await db.run('INSERT INTO player_rolls (player_id, result) VALUES (?, ?)', ['551100000002@s.whatsapp.net', 'rare']);

    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', ['551100000003@s.whatsapp.net', 'Conflito A', null]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', ['103@lid', 'Conflito B', '103@lid']);
    await db.close();

    const planFile = path.join(root, 'identity-repair-plan-fixture.json');
    fs.writeFileSync(planFile, JSON.stringify({
        readOnly: true,
        groups: [
            {
                phone: '551100000001',
                action: 'transactional_alias_consolidation_ready',
                readyForExecutor: true,
                canonicalId: '101@lid',
                dataOwnerId: '101@lid',
                sources: [{
                    sourceId: '551100000001@s.whatsapp.net',
                    unknownReferences: [],
                    references: [
                        { table: 'jogadores', column: 'id', rows: 1, strategy: 'source_record' },
                        { table: 'player_onboarding', column: 'player_id', rows: 1, strategy: 'merge_or_delete_auxiliary' },
                        { table: 'clover_character_stats', column: 'player_id', rows: 1, strategy: 'merge_singleton' },
                        { table: 'clover_ph_ledger', column: 'player_id', rows: 1, strategy: 'repoint_history' },
                        { table: 'clover_player_aliases', column: 'alias_value', rows: 1, strategy: 'preserve_alias_value' },
                        { table: 'clover_player_aliases', column: 'player_id_destino', rows: 1, strategy: 'repoint_alias_target' }
                    ]
                }]
            },
            {
                phone: '551100000002',
                action: 'transactional_canonical_migration',
                readyForExecutor: true,
                canonicalId: '102@lid',
                dataOwnerId: '551100000002@s.whatsapp.net',
                sources: [{
                    sourceId: '551100000002@s.whatsapp.net',
                    unknownReferences: [],
                    references: [
                        { table: 'jogadores', column: 'id', rows: 1, strategy: 'source_record' },
                        { table: 'clover_character_stats', column: 'player_id', rows: 1, strategy: 'merge_singleton' },
                        { table: 'player_rolls', column: 'player_id', rows: 1, strategy: 'repoint_owned_data' }
                    ]
                }]
            },
            {
                phone: '551100000003',
                action: 'blocked_manual_merge',
                readyForExecutor: false,
                canonicalId: '103@lid',
                dataOwnerId: '103@lid',
                sources: [{ sourceId: '551100000003@s.whatsapp.net', references: [] }]
            }
        ]
    }, null, 2));

    return { dbFile, planFile };
}

function execute(fixture, root, apply = false, confirm = true) {
    const args = [
        SCRIPT,
        `--db=${fixture.dbFile}`,
        `--plan=${fixture.planFile}`,
        `--output=${root}`,
    ];
    if (apply) {
        args.push('--apply');
        if (confirm) args.push('--confirm=APPLY_READY_IDENTITY_REPAIRS');
    }
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

async function snapshot(dbFile) {
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    const result = {};
    for (const table of ['jogadores', 'player_onboarding', 'clover_character_stats', 'clover_ph_ledger', 'player_rolls', 'clover_player_aliases']) {
        result[table] = await db.all(`SELECT * FROM ${table} ORDER BY 1`);
    }
    await db.close();
    return result;
}

test('simulação executa todas as validações e reverte integralmente', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-exec-dry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);
    const before = await snapshot(fixture.dbFile);
    const result = execute(fixture, root, false);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SIMULAÇÃO COM ROLLBACK/);
    assert.match(result.stdout, /Grupos processados: 2/);
    assert.match(result.stdout, /Grupos bloqueados e intocados: 1/);
    assert.deepEqual(await snapshot(fixture.dbFile), before);
});

test('aplicação consolida apenas grupos prontos e preserva aliases históricos', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-exec-apply-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);
    const result = execute(fixture, root, true);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Commit no banco: SIM/);

    const db = await open({ filename: fixture.dbFile, driver: sqlite3.Database });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores WHERE id = ?', ['551100000001@s.whatsapp.net'])).n, 0);
    assert.equal((await db.get('SELECT ph_available FROM clover_character_stats WHERE player_id = ?', ['101@lid'])).ph_available, 25);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_ph_ledger WHERE player_id = ?', ['101@lid'])).n, 1);
    const alias = await db.get('SELECT alias_value, player_id_destino FROM clover_player_aliases');
    assert.equal(alias.alias_value, '551100000001@s.whatsapp.net');
    assert.equal(alias.player_id_destino, '101@lid');

    const migrated = await db.get('SELECT nome FROM jogadores WHERE id = ?', ['102@lid']);
    assert.equal(migrated.nome, 'Migrar');
    assert.equal((await db.get('SELECT ph_available FROM clover_character_stats WHERE player_id = ?', ['102@lid'])).ph_available, 90);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM player_rolls WHERE player_id = ?', ['102@lid'])).n, 1);

    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores WHERE id IN (?, ?)', ['551100000003@s.whatsapp.net', '103@lid'])).n, 2);
    await db.close();
});

test('aplicação é recusada sem confirmação literal', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-exec-confirm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);
    const result = execute(fixture, root, true, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPLY_READY_IDENTITY_REPAIRS/);
});
