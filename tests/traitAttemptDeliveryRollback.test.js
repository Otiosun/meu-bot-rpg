'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const originalLoad = Module._load;
let sendReplyResult = null;
const replyPayloads = [];

Module._load = function loadWithAttemptCommandStubs(request, parent, isMain) {
    const parentFile = String(parent?.filename || '').replace(/\\/g, '/');
    const isAttemptCommand = parentFile.endsWith('/comandos/tentativa.js')
        || parentFile.endsWith('/comandos/tracos.js');

    if (isAttemptCommand && request === '../helpers/chatReply') {
        return {
            sendReply: async (payload) => {
                replyPayloads.push(payload);
                return sendReplyResult || payload;
            },
        };
    }

    return originalLoad.call(this, request, parent, isMain);
};

const tentativaPath = require.resolve('../comandos/tentativa');
const tracosPath = require.resolve('../comandos/tracos');
delete require.cache[tentativaPath];
delete require.cache[tracosPath];
const tentativaCommand = require('../comandos/tentativa');
const tracosCommand = require('../comandos/tracos');
Module._load = originalLoad;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_trait_attempts (
            player_id TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            category TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT NOT NULL,
            chosen_key TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, attempt_number)
        );
    `);
    return db;
}

async function countAttempts(db, playerId = 'player@lid') {
    const row = await db.get(
        'SELECT COUNT(*) AS total FROM clover_trait_attempts WHERE player_id = ?',
        [playerId]
    );
    return Number(row?.total || 0);
}

async function execute(command, db, body) {
    await command.executar({
        sock: {},
        m: { key: { id: 'message-1' } },
        idChat: 'player@lid',
        idJogador: 'player@lid',
        db,
        body,
    });
}

test('tentativa especial nao consome uso quando resposta PV do comando foi pulada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    replyPayloads.length = 0;
    sendReplyResult = { skipped: true, reason: 'pv_command_reply_not_queued' };

    await execute(tentativaCommand, db, 'anomalia');

    assert.equal(await countAttempts(db), 0);
});

test('atalho de tracos tambem reverte tentativa quando resposta PV do comando foi pulada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    replyPayloads.length = 0;
    sendReplyResult = { skipped: true, reason: 'pv_command_reply_not_queued' };

    await execute(tracosCommand, db, 'tentar marca');

    assert.equal(await countAttempts(db), 0);
});

test('tentativa especial continua consumindo quando a resposta foi entregue', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    replyPayloads.length = 0;
    sendReplyResult = { key: { id: 'sent-1' } };

    await execute(tentativaCommand, db, 'aptidao');

    assert.equal(await countAttempts(db), 1);
});

test('resultado de tentativa mostra tentativas gravadas sem consumir nova tentativa', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    replyPayloads.length = 0;
    sendReplyResult = null;
    await db.run(
        `INSERT INTO clover_trait_attempts
         (player_id, attempt_number, category, status, result, chosen_key)
         VALUES ('player@lid', 1, 'anomaly', 'completed', 'success', NULL)`
    );

    await execute(tentativaCommand, db, 'resultado');

    assert.equal(await countAttempts(db), 1);
    assert.match(replyPayloads.at(-1).text, /Tentativa 1: Anomalia - PASSOU/);
});
