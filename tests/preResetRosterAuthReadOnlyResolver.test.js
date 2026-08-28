'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const test = require('node:test');
const { resolveRosterWithAuthAgainstDatabase } = require('../scripts/resolvePreResetKeepRosterWithAuthReadOnly');

function sha(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-roster-auth-ro-'));
    const filename = path.join(root, 'database.sqlite');
    const authDir = path.join(root, 'auth_info');
    fs.mkdirSync(authDir);
    const db = await open({ filename, driver:sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            is_shadow INTEGER DEFAULT 0,
            merged_into TEXT,
            canonical_player_id TEXT
        );
        CREATE TABLE clover_player_aliases (
            player_id_destino TEXT, alias_type TEXT, alias_value TEXT, active INTEGER DEFAULT 1
        );
        CREATE TABLE clover_player_target_aliases (player_id TEXT, alias_key TEXT);
        CREATE TABLE clover_prereset_purge_tombstones (player_id TEXT PRIMARY KEY);
    `);
    await db.run("INSERT INTO jogadores VALUES ('123456789012345@lid','Alpha','Alpha','Hero A','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO jogadores VALUES ('223456789012345@lid','Beta','Beta','Hero B','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO jogadores VALUES ('323456789012345@lid','Gamma','Gamma','Hero C','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO jogadores VALUES ('5511999990003@s.whatsapp.net','Delta antigo','Delta antigo','Hero old','incompleta',1,NULL,NULL)");
    await db.run("INSERT INTO jogadores VALUES ('423456789012345@lid','Delta','Delta','Hero D','aprovada',0,NULL,NULL)");
    await db.close();
    fs.writeFileSync(path.join(authDir, 'lid-mapping-123456789012345_reverse.json'), JSON.stringify('5511999990001@s.whatsapp.net'));
    fs.writeFileSync(path.join(authDir, 'lid-mapping-223456789012345_reverse.json'), JSON.stringify({ phoneNumber:'5511999990002@s.whatsapp.net' }));
    fs.writeFileSync(path.join(authDir, 'lid-mapping-323456789012345_reverse.json'), JSON.stringify('5511999990002@s.whatsapp.net'));
    fs.writeFileSync(path.join(authDir, 'lid-mapping-423456789012345_reverse.json'), JSON.stringify('5511999990003@s.whatsapp.net'));
    t.after(() => fs.rmSync(root, { recursive:true, force:true }));
    return { root, filename };
}

test('resolver AUTH read-only usa reverse LID, auto-colapsa somente elegivel e falha fechado em colisao real', async (t) => {
    const fx = await fixture(t);
    const before = sha(fx.filename);
    const report = await resolveRosterWithAuthAgainstDatabase({
        dbPath:fx.filename,
        authRoot:fx.root,
        entries:[
            { name:'Alpha', phone:'+55 11 99999-0001' },
            { name:'Beta', phone:'+55 11 99999-0002' },
            { name:'Delta', phone:'+55 11 99999-0003' },
        ],
    });
    assert.equal(report.auth.reverseMappingsRead, 4);
    assert.equal(report.results[0].status, 'RESOLVED');
    assert.equal(report.results[0].playerId, '123456789012345@lid');
    assert.deepEqual(report.results[0].identityEvidence.databaseCandidates, []);
    assert.deepEqual(report.results[0].identityEvidence.authReverseLidCandidates, ['123456789012345@lid']);

    assert.equal(report.results[1].status, 'AMBIGUOUS');
    assert.deepEqual(report.results[1].candidatePlayerIds, ['223456789012345@lid','323456789012345@lid']);
    assert.equal(report.results[1].candidateDetails.length, 2);
    assert.equal(report.results[1].candidateDetails.every((entry) => entry.eligibility.eligible), true);

    assert.equal(report.results[2].status, 'RESOLVED');
    assert.equal(report.results[2].playerId, '423456789012345@lid');
    assert.equal(report.results[2].identityResolution, 'sole_eligible_candidate');
    assert.equal(report.results[2].candidateDetails.length, 2);
    assert.deepEqual(report.results[2].candidateDetails.map((entry) => entry.eligibility.eligible), [true,false]);

    assert.equal(report.allResolved, false);
    assert.equal(sha(fx.filename), before);
});
