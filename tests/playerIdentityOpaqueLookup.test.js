'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const {open} = require('sqlite');
const {getRawPlayerById, getCanonicalPlayer} = require('../helpers/clover/targetResolver');

test('identificadores opacos não se confundem com dígitos de outros jogadores', async t => {
    const db = await open({filename:':memory:',driver:sqlite3.Database});
    t.after(()=>db.close());
    await db.exec('CREATE TABLE jogadores (id TEXT PRIMARY KEY, personagem_nome TEXT)');
    await db.run('INSERT INTO jogadores(id, personagem_nome) VALUES (?,?)',['fixture-e2e-player','Personagem de teste']);
    assert.equal(await getRawPlayerById(db,'fixture-e2e-admin'),null);
    assert.equal(await getCanonicalPlayer(db,'fixture-e2e-admin'),null);
    assert.equal(await getRawPlayerById(db,'2'),null);
    assert.equal((await getRawPlayerById(db,'fixture-e2e-player')).id,'fixture-e2e-player');
    await db.run('INSERT INTO jogadores(id, personagem_nome) VALUES (?,?)',['102@s.whatsapp.net','Jogador numérico']);
    assert.equal((await getRawPlayerById(db,'102')).id,'102@s.whatsapp.net');
    assert.equal((await getRawPlayerById(db,'102:4@s.whatsapp.net')).id,'102@s.whatsapp.net');
    assert.equal(await getRawPlayerById(db,'fixture-102'),null);
});
