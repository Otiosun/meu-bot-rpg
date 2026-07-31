'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
    defaultCollectorCwd,
} = require('../helpers/clover/phase0EvidenceCollectorConfig');

test('caminho padrão do coletor aponta para a raiz do repositório', () => {
    assert.equal(defaultCollectorCwd(), path.resolve(__dirname, '..'));
});
