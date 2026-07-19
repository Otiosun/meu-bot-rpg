'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

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
    `);

    const phone = '553197168289';
    const lid = '27702773956629';
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, ficha_status, jogo_status)
         VALUES (?, 'Cacador', 'Cacador', 'incompleta', 'bloqueado')`,
        [`${phone}@s.whatsapp.net`]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, ficha_status, jogo_status)
         VALUES (?, 'Wendell', 'Wendell', 'incompleta', 'bloqueado')`,
        [`${lid}@lid`]
    );
    for (let index = 0; index < 4; index += 1) {
        await db.run('INSERT INTO player_rolls (player_id) VALUES (?)', [`${lid}@lid`]);
    }
    for (let index = 0; index < 2; index += 1) {
        await db.run('INSERT INTO clover_trait_attempts (player_id) VALUES (?)', [`${lid}@lid`]);
    }
    await db.close();

    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, `lid-mapping-${phone}.json`), JSON.stringify({ lid }), 'utf8');
    fs.writeFileSync(path.join(authDir, `lid-mapping-${lid}_reverse.json`), JSON.stringify({ phoneNumber: phone }), 'utf8');

    return { dbFile, authDir, lid };
}

test('auditoria identifica alias simples e recomenda o cadastro LID ativo', async (t) => {
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
    assert.match(result.stdout, /Telefones duplicados: 1/);
    assert.match(result.stdout, /Nenhum dado foi alterado/);

    const reports = fs.readdirSync(reportDir).filter((name) => name.endsWith('.json'));
    assert.equal(reports.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, reports[0]), 'utf8'));
    assert.equal(report.duplicatePhones, 1);
    assert.equal(report.manualMergeRequired, 0);
    assert.equal(report.simpleAliases, 1);
    assert.equal(report.groups[0].classification, 'simple_alias');
    assert.equal(report.groups[0].recommendedCanonicalId, `${fixture.lid}@lid`);
    assert.equal(report.groups[0].candidates.find((item) => item.id === `${fixture.lid}@lid`).activity.rolls, 4);
});
