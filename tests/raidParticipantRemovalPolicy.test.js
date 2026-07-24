'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    normalizeRemovalReason,
} = require('../helpers/clover/raidService');

test('remoção de participante exige motivo auditável', () => {
    assert.throws(
        () => normalizeRemovalReason(''),
        { code: 'removal_reason_required' }
    );
    assert.throws(
        () => normalizeRemovalReason('  '),
        { code: 'removal_reason_required' }
    );
    assert.throws(
        () => normalizeRemovalReason('x'),
        { code: 'removal_reason_required' }
    );
});

test('motivo é normalizado e limitado sem perder conteúdo auditável', () => {
    assert.equal(
        normalizeRemovalReason('  Ausente   durante a conclusão  '),
        'Ausente durante a conclusão'
    );
    assert.equal(normalizeRemovalReason('a'.repeat(700)).length, 500);
});
