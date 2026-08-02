'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function countOccurrences(content, needle) {
    return content.split(needle).length - 1;
}

test('index conecta execução única com duas flags e sem timer', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const importNeedle = "require('./helpers/clover/privateDeliveryRuntimeHook')";
    const callNeedle = 'runPrivateDeliveryWorkerOnce({';

    assert.equal(countOccurrences(index, importNeedle), 1);
    assert.equal(countOccurrences(index, callNeedle), 1);
    assert.equal(index.includes("context: 'connection_open'"), true);
    assert.equal(index.includes('CLOVER_PV_DELIVERY_WORKER_ENABLED ='), false);
    assert.equal(index.includes('CLOVER_PV_DELIVERY_RUN_ON_OPEN ='), false);
    assert.equal(/setInterval\s*\([^)]*runPrivateDeliveryWorkerOnce/s.test(index), false);
});

test('safe boot retorna antes da execução da fila', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const safeBoot = index.indexOf("if (process.env.CLOVER_SAFE_BOOT === '1')");
    const hook = index.indexOf('runPrivateDeliveryWorkerOnce({');
    const approvals = index.indexOf('approvePendingOffGroupRequests(sock, db)');

    assert.ok(safeBoot >= 0);
    assert.ok(hook > safeBoot);
    assert.ok(approvals > hook);
});
