'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const test = require('node:test');
const {
    parseRosterText,
    resolveRosterAgainstDatabase,
} = require('../scripts/resolvePreResetKeepRosterReadOnly');

function sha(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-roster-ro-'));
    const filename = path.join(dir, 'database.sqlite');
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
            player_id_destino TEXT,
            alias_type TEXT,
            alias_value TEXT,
            active INTEGER DEFAULT 1
        );
        CREATE TABLE clover_player_target_aliases (player_id TEXT, alias_key TEXT);
        CREATE TABLE clover_prereset_purge_tombstones (player_id TEXT PRIMARY KEY);
    `);
    await db.run("INSERT INTO jogadores VALUES ('5511999990001@s.whatsapp.net','Alpha','Alpha','Hero A','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO jogadores VALUES ('canonical-b','Beta','Beta','Hero B','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO clover_player_aliases VALUES ('canonical-b','phone','5511999990002',1)");
    await db.run("INSERT INTO jogadores VALUES ('ambiguous-c','Gamma','Gamma','Hero C','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO jogadores VALUES ('ambiguous-d','Delta','Delta','Hero D','aprovada',0,NULL,NULL)");
    await db.run("INSERT INTO clover_player_aliases VALUES ('ambiguous-c','phone','5511999990003',1)");
    await db.run("INSERT INTO clover_player_aliases VALUES ('ambiguous-d','phone','5511999990003',1)");
    await db.close();
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    return filename;
}

test('roster parser aceita formato humano sem versionar telefone no codigo', () => {
    const rows = parseRosterText('Alpha — +55 11 99999-0001\nBeta - +55 11 99999-0002');
    assert.deepEqual(rows.map((row) => row.name), ['Alpha','Beta']);
    assert.deepEqual(rows.map((row) => row.phone.replace(/\D/g,'')), ['5511999990001','5511999990002']);
});

test('resolver F11/F12 abre SQLite read-only, resolve exato e falha fechado em ambiguidade', async (t) => {
    const filename = await fixture(t);
    const before = sha(filename);
    const report = await resolveRosterAgainstDatabase({
        dbPath:filename,
        entries:[
            { name:'Alpha', phone:'+55 11 99999-0001' },
            { name:'Beta', phone:'+55 11 99999-0002' },
            { name:'Gamma', phone:'+55 11 99999-0003' },
        ],
    });
    assert.equal(report.results[0].status, 'RESOLVED');
    assert.equal(report.results[0].playerId, '5511999990001@s.whatsapp.net');
    assert.equal(report.results[1].status, 'RESOLVED');
    assert.equal(report.results[1].playerId, 'canonical-b');
    assert.equal(report.results[2].status, 'AMBIGUOUS');
    assert.equal(report.allResolved, false);
    assert.equal(report.results.every((row) => !row.phoneMasked.includes('551199999')), true);
    assert.equal(sha(filename), before);
});
