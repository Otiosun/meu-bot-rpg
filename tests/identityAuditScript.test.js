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
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, ficha_status, jogo_status)
         VALUES (?, ?, ?, 'incompleta', 'bloqueado')`,
        [id, name, name]
    );
}

function writeMapping(authDir, phone, lid) {
    fs.writeFileSync(path.join(authDir, `lid-mapping-${phone}.json`), JSON.stringify({ lid }), 'utf8');
    fs.writeFileSync(path.join(authDir, `lid-mapping-${lid}_reverse.json`), JSON.stringify({ phoneNumber: phone }), 'utf8');
}

async function addRows(db, table, column, playerId, amount) {
    for (let index = 0; index < amount; index += 1) {
        await db.run(`INSERT INTO ${table} (${column}) VALUES (?)`, [playerId]);
    }
}

async function createFixture(root) {
    const dbFile = path.join(root, 'audit.sqlite');
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            raca TEXT,
            classe TEXT,
            grimorio TEXT,
            magia TEXT,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT
        );
        CREATE TABLE player_rolls (player_id TEXT);
        CREATE TABLE clover_trait_attempts (player_id TEXT);
        CREATE TABLE clover_inventory_items (player_id TEXT);
        CREATE TABLE clover_character_stats (player_id TEXT);
        CREATE TABLE clover_site_sessions (player_id TEXT);
        CREATE TABLE player_onboarding (player_id TEXT);
        CREATE TABLE clover_market_listings (seller_id TEXT);
        CREATE TABLE clover_raid_participants (player_id TEXT);
    `);

    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const simple = { phone: '553197168289', lid: '27702773956629' };
    simple.phoneId = `${simple.phone}@s.whatsapp.net`;
    simple.lidId = `${simple.lid}@lid`;
    await insertPlayer(db, simple.phoneId);
    await insertPlayer(db, simple.lidId, 'Wendell');
    await addRows(db, 'player_rolls', 'player_id', simple.lidId, 4);
    await addRows(db, 'clover_trait_attempts', 'player_id', simple.lidId, 2);
    await addRows(db, 'clover_character_stats', 'player_id', simple.phoneId, 1);
    await addRows(db, 'player_onboarding', 'player_id', simple.phoneId, 1);
    writeMapping(authDir, simple.phone, simple.lid);

    const migration = { phone: '559888768701', lid: '76738801471621' };
    migration.phoneId = `${migration.phone}@s.whatsapp.net`;
    migration.lidId = `${migration.lid}@lid`;
    await insertPlayer(db, migration.phoneId, 'Junko Libardirti');
    await insertPlayer(db, migration.lidId);
    await addRows(db, 'player_rolls', 'player_id', migration.phoneId, 4);
    await addRows(db, 'clover_trait_attempts', 'player_id', migration.phoneId, 2);
    writeMapping(authDir, migration.phone, migration.lid);

    const manual = { phone: '559985412280', lid: '149701705904226' };
    manual.phoneId = `${manual.phone}@s.whatsapp.net`;
    manual.lidId = `${manual.lid}@lid`;
    await insertPlayer(db, manual.phoneId);
    await insertPlayer(db, manual.lidId, 'Artorius D.Malth');
    await addRows(db, 'clover_inventory_items', 'player_id', manual.phoneId, 1);
    await addRows(db, 'player_rolls', 'player_id', manual.lidId, 4);
    writeMapping(authDir, manual.phone, manual.lid);

    const empty = { phone: '556696030511', lid: '65881090580683' };
    empty.phoneId = `${empty.phone}@s.whatsapp.net`;
    empty.lidId = `${empty.lid}@lid`;
    await insertPlayer(db, empty.phoneId);
    await insertPlayer(db, empty.lidId);
    await addRows(db, 'player_onboarding', 'player_id', empty.phoneId, 1);
    await addRows(db, 'clover_character_stats', 'player_id', empty.lidId, 1);
    writeMapping(authDir, empty.phone, empty.lid);

    await db.close();
    return { dbFile, authDir, simple, migration, manual, empty };
}

function byPhone(report, phone) {
    return report.groups.find((group) => group.phone === phone);
}

test('auditoria separa alias simples, migração canônica, fusão manual e duplicata vazia', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-audit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const fixture = await createFixture(root);
    const reportDir = path.join(root, 'reports');
    const result = spawnSync(
        process.execPath,
        [path.join(__dirname, '..', 'scripts', 'auditPlayerIdentityAliases.js'), fixture.dbFile, reportDir],
        {
            encoding: 'utf8',
            env: { ...process.env, CLOVER_AUTH_INFO_DIR: fixture.authDir },
        }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Telefones duplicados: 4/);
    assert.match(result.stdout, /Exigem fusão manual: 1/);
    assert.match(result.stdout, /Exigem migração ao ID canônico: 1/);
    assert.match(result.stdout, /Aliases simples: 1/);
    assert.match(result.stdout, /Duplicatas vazias: 1/);
    assert.match(result.stdout, /Nenhum dado foi alterado/);

    const reports = fs.readdirSync(reportDir).filter((name) => name.endsWith('.json'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, reports[0]), 'utf8'));
    assert.equal(report.duplicatePhones, 4);
    assert.equal(report.manualMergeRequired, 1);
    assert.equal(report.canonicalMigrationsRequired, 1);
    assert.equal(report.simpleAliases, 1);
    assert.equal(report.emptyDuplicates, 1);

    const simple = byPhone(report, fixture.simple.phone);
    assert.equal(simple.classification, 'simple_alias');
    assert.equal(simple.recommendedDataOwnerId, fixture.simple.lidId);
    assert.equal(simple.recommendedCanonicalId, fixture.simple.lidId);
    assert.equal(simple.migrationRequired, false);
    assert.equal(simple.candidates.find((item) => item.id === fixture.simple.phoneId).supportActivityTotal, 2);
    assert.equal(simple.candidates.find((item) => item.id === fixture.simple.phoneId).hasSubstantiveData, false);

    const migration = byPhone(report, fixture.migration.phone);
    assert.equal(migration.classification, 'canonical_migration_required');
    assert.equal(migration.recommendedDataOwnerId, fixture.migration.phoneId);
    assert.equal(migration.recommendedCanonicalId, fixture.migration.lidId);
    assert.equal(migration.migrationRequired, true);

    const manual = byPhone(report, fixture.manual.phone);
    assert.equal(manual.classification, 'manual_merge_required');
    assert.equal(manual.candidates.filter((item) => item.hasSubstantiveData).length, 2);

    const empty = byPhone(report, fixture.empty.phone);
    assert.equal(empty.classification, 'empty_duplicate');
    assert.equal(empty.candidates.every((item) => item.hasSubstantiveData === false), true);
});
