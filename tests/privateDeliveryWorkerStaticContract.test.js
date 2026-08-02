'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('worker permanece desconectado do index nesta etapa', () => {
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    assert.equal(index.includes("require('./helpers/clover/privateDeliveryWorker')"), false);
    assert.equal(index.includes('processNextPrivateDelivery('), false);
});
