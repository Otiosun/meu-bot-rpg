'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function insertPlayer(db, id, name = 'Cacador') {
    await db.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', [id, name]);
}

async function createFixture(root) {
    const dbFile = path.join(root, 'planner.sqlite');
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            canonical_player_id TEXT
        );
        CREATE TABLE player_rolls (player_id TEXT);
        CREATE TABLE player_onboarding (player_id TEXT);
        CREATE TABLE clover_character_stats (player_id TEXT);
        CREATE TABLE clover_ph_ledger (player_id TEXT);
        CREATE TABLE group_member_welcomes (player_id TEXT);
        CREATE TABLE clover_player_aliases (alias_value TEXT, player_id_destino TEXT);
        CREATE TABLE custom_refs (owner_jid TEXT);
    `);

    const cleanupPhone = '551100000001@s.whatsapp.net';
    const cleanupLid = '101@lid';
    await insertPlayer(db, cleanupPhone);
    await insertPlayer(db, cleanupLid, 'Jogador Real');
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [cleanupLid]);
    await db.run('INSERT INTO player_onboarding (player_id) VALUES (?)', [cleanupPhone]);

    const consolidationPhone = '551100000002@s.whatsapp.net';
    const consolidationLid = '102@lid';
    await insertPlayer(db, consolidationPhone);
    await insertPlayer(db, consolidationLid, 'Histórico Real');
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [consolidationLid]);
    await db.run('INSERT INTO clover_character_stats (player_id) VALUES (?)', [consolidationPhone]);
    await db.run('INSERT INTO clover_ph_ledger (player_id) VALUES (?)', [consolidationPhone]);
    await db.run('INSERT INTO group_member_welcomes (player_id) VALUES (?)', [consolidationPhone]);
    await db.run(
        'INSERT INTO clover_player_aliases (alias_value, player_id_destino) VALUES (?, ?)',
        [consolidationPhone, consolidationPhone]
    );

    const migrationPhone = '551100000003@s.whatsapp.net';
    const migrationLid = '103@lid';
    await insertPlayer(db, migrationPhone, 'Dados no telefone');
    await insertPlayer(db, migrationLid);
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [migrationPhone]);
    await db.run('INSERT INTO player_onboarding (player_id) VALUES (?)', [migrationLid]);

    const unexpectedPhone = '551100000004@s.whatsapp.net';
    const unexpectedLid = '104@lid';
    await insertPlayer(db, unexpectedPhone);
    await insertPlayer(db, unexpectedLid, 'Outro Jogador');
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [unexpectedLid]);
    await db.run('INSERT INTO custom_refs (owner_jid) VALUES (?)', [unexpectedPhone]);

    const emptyPhone = '551100000005@s.whatsapp.net';
    const emptyLid = '105@lid';
    await insertPlayer(db, emptyPhone);
    await insertPlayer(db, emptyLid);
    await db.run('INSERT INTO clover_ph_ledger (player_id) VALUES (?)', [emptyPhone]);

    await db.close();

    const reportFile = path.join(root, 'identity-alias-audit-fixture.json');
    fs.writeFileSync(reportFile, JSON.stringify({
        groups: [
            {
                phone: '551100000001',
                classification: 'simple_alias',
                recommendedDataOwnerId: cleanupLid,
                recommendedCanonicalId: cleanupLid,
                candidates: [{ id: cleanupPhone }, { id: cleanupLid }],
            },
            {
                phone: '551100000002',
                classification: 'simple_alias',
                recommendedDataOwnerId: consolidationLid,
                recommendedCanonicalId: consolidationLid,
                candidates: [{ id: consolidationPhone }, { id: consolidationLid }],
            },
            {
                phone: '551100000003',
                classification: 'canonical_migration_required',
                recommendedDataOwnerId: migrationPhone,
                recommendedCanonicalId: migrationLid,
                candidates: [{ id: migrationPhone }, { id: migrationLid }],
            },
            {
                phone: '551100000004',
                classification: 'simple_alias',
                recommendedDataOwnerId: unexpectedLid,
                recommendedCanonicalId: unexpectedLid,
                candidates: [{ id: unexpectedPhone }, { id: unexpectedLid }],
            },
            {
                phone: '551100000005',
                classification: 'empty_duplicate',
                recommendedDataOwnerId: emptyLid,
                recommendedCanonicalId: emptyLid,
                candidates: [{ id: emptyPhone }, { id: emptyLid }],
            },
        ],
    }, null, 2));

    return { dbFile, reportFile };
}

test('planejador classifica estratégias conhecidas e permanece somente leitura', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-plan-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const fixture = await createFixture(root);
    const outputDir = path.join(root, 'output');
    const before = fs.readFileSync(fixture.dbFile);

    const result = spawnSync(
        process.execPath,
        [
            path.join(__dirname, '..', 'scripts', 'planPlayerIdentityRepairs.js'),
            fixture.dbFile,
            fixture.reportFile,
            outputDir,
        ],
        { encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SOMENTE LEITURA/);
    assert.match(result.stdout, /Nenhum dado foi alterado/);

    const files = fs.readdirSync(outputDir).filter((name) => name.startsWith('identity-repair-plan-'));
    assert.equal(files.length, 1);
    const plan = JSON.parse(fs.readFileSync(path.join(outputDir, files[0]), 'utf8'));

    assert.equal(plan.readOnly, true);
    assert.equal(plan.groupsAnalyzed, 5);
    assert.equal(plan.readyForExecutor, 4);
    assert.equal(plan.blockedOrUnknown, 1);

    const cleanup = plan.groups.find((group) => group.phone === '551100000001');
    assert.equal(cleanup.action, 'transactional_alias_cleanup_ready');
    assert.equal(cleanup.readyForExecutor, true);

    const consolidation = plan.groups.find((group) => group.phone === '551100000002');
    assert.equal(consolidation.action, 'transactional_alias_consolidation_ready');
    assert.equal(consolidation.readyForExecutor, true);
    assert.ok(consolidation.sources[0].references.some(
        (entry) => entry.table === 'clover_ph_ledger' && entry.strategy === 'repoint_history'
    ));
    assert.ok(consolidation.sources[0].references.some(
        (entry) => entry.table === 'clover_player_aliases'
            && entry.column === 'alias_value'
            && entry.strategy === 'preserve_alias_value'
    ));
    assert.ok(consolidation.sources[0].references.some(
        (entry) => entry.table === 'clover_player_aliases'
            && entry.column === 'player_id_destino'
            && entry.strategy === 'repoint_alias_target'
    ));

    const migration = plan.groups.find((group) => group.phone === '551100000003');
    assert.equal(migration.action, 'transactional_canonical_migration');
    assert.equal(migration.readyForExecutor, true);
    assert.ok(migration.sources[0].references.some(
        (entry) => entry.table === 'player_rolls' && entry.strategy === 'repoint_owned_data'
    ));

    const unexpected = plan.groups.find((group) => group.phone === '551100000004');
    assert.equal(unexpected.action, 'review_unknown_references');
    assert.equal(unexpected.readyForExecutor, false);
    assert.equal(unexpected.sources[0].unknownReferences[0].table, 'custom_refs');

    const empty = plan.groups.find((group) => group.phone === '551100000005');
    assert.equal(empty.action, 'transactional_empty_cleanup_ready');
    assert.equal(empty.readyForExecutor, true);

    const after = fs.readFileSync(fixture.dbFile);
    assert.deepEqual(after, before);
});
