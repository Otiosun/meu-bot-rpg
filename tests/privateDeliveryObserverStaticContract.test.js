'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('script abre SQLite somente leitura e não inicializa o bot', () => {
    const script = fs.readFileSync(
        path.join(ROOT, 'scripts', 'observePrivateDeliveryQueue.js'),
        'utf8'
    );

    assert.equal(script.includes('sqlite3.OPEN_READONLY'), true);
    assert.equal(script.includes("require('../index')"), false);
    assert.equal(script.includes("require('../database')"), false);
    assert.equal(script.includes('makeWASocket'), false);
    assert.equal(script.includes('sendMessage('), false);
});

test('script não contém SQL mutável contra a fila', () => {
    const script = fs.readFileSync(
        path.join(ROOT, 'scripts', 'observePrivateDeliveryQueue.js'),
        'utf8'
    );

    for (const keyword of ['INSERT INTO', 'UPDATE clover_delivery_jobs', 'DELETE FROM', 'ALTER TABLE', 'DROP TABLE']) {
        assert.equal(script.includes(keyword), false, `SQL mutável encontrado: ${keyword}`);
    }
});

test('relatório não carrega payload ou jid integral', () => {
    const observer = fs.readFileSync(
        path.join(ROOT, 'helpers', 'clover', 'privateDeliveryObserver.js'),
        'utf8'
    );

    assert.equal(observer.includes('payload_json:'), false);
    assert.equal(observer.includes('target_jid:'), false);
    assert.equal(observer.includes("createHash('sha256')"), true);
});
