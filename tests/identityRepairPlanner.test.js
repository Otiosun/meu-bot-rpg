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
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT);
        CREATE TABLE player_rolls (player_id TEXT);
        CREATE TABLE player_onboarding (player_id TEXT);
        CREATE TABLE custom_refs (owner_jid TEXT);
    `);

    const simplePhone = '551100000001@s.whatsapp.net';
    const simpleLid = '101@lid';
    await insertPlayer(db, simplePhone);
    await insertPlayer(db, simpleLid, 'Jogador Real');
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [simpleLid]);
    await db.run('INSERT INTO player_onboarding (player_id) VALUES (?)', [simplePhone]);

    const migrationPhone = '551100000002@s.whatsapp.net';
    const migrationLid = '102@lid';
    await insertPlayer(db, migrationPhone, 'Dados no telefone');
    await insertPlayer(db, migrationLid);
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [migrationPhone]);
    await db.run('INSERT INTO player_onboarding (player_id) VALUES (?)', [migrationLid]);

    const unexpectedPhone = '551100000003@s.whatsapp.net';
    const unexpectedLid = '103@lid';
    await insertPlayer(db, unexpectedPhone);
    await insertPlayer(db, unexpectedLid, 'Outro Jogador');
    await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [unexpectedLid]);
    await db.run('INSERT INTO custom_refs (owner_jid) VALUES (?)', [unexpectedPhone]);

    await db.close();

    const reportFile = path.join(root, 'identity-alias-audit-fixture.json');
    fs.writeFileSync(reportFile, JSON.stringify({
        groups: [
            {
                phone: '551100000001',
                classification: 'simple_alias',
                recommendedDataOwnerId: simpleLid,
                recommendedCanonicalId: simpleLid,
                candidates: [{ id: simplePhone }, { id: simpleLid }],
            },
            {
                phone: '551100000002',
                classification: 'canonical_migration_required',
                recommendedDataOwnerId: migrationPhone,
                recommendedCanonicalId: migrationLid,
                candidates: [{ id: migrationPhone }, { id: migrationLid }],
            },
            {
                phone: '551100000003',
                classification: 'simple_alias',
                recommendedDataOwnerId: unexpectedLid,
                recommendedCanonicalId: unexpectedLid,
                candidates: [{ id: unexpectedPhone }, { id: unexpectedLid }],
            },
        ],
    }, null, 2));

    return { dbFile, reportFile };
}

test('planejador encontra referências e não altera o banco', async (t) => {
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
    assert.equal(plan.groupsAnalyzed, 3);

    const simple = plan.groups.find((group) => group.phone === '551100000001');
    assert.equal(simple.action, 'safe_alias_cleanup_candidate');
    assert.equal(simple.automatic, true);
    assert.deepEqual(
        simple.sources[0].references.map((entry) => entry.table).sort(),
        ['jogadores', 'player_onboarding']
    );

    const migration = plan.groups.find((group) => group.phone === '551100000002');
    assert.equal(migration.action, 'transactional_migration_required');
    assert.equal(migration.automatic, false);
    assert.ok(migration.sources[0].references.some((entry) => entry.table === 'player_rolls'));

    const unexpected = plan.groups.find((group) => group.phone === '551100000003');
    assert.equal(unexpected.action, 'review_unexpected_references');
    assert.equal(unexpected.automatic, false);
    assert.equal(unexpected.sources[0].unexpectedReferences[0].table, 'custom_refs');

    const after = fs.readFileSync(fixture.dbFile);
    assert.deepEqual(after, before);
});
