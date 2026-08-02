'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isGrantActiveAt,
    parseDatabaseTimestamp,
} = require('../helpers/clover/canonicalRoleGrantSchema');

test('timestamp SQLite sem fuso é interpretado como UTC em qualquer host', () => {
    const parsed = parseDatabaseTimestamp('2026-08-02 03:00:00');
    assert.equal(parsed.toISOString(), '2026-08-02T03:00:00.000Z');

    const fractional = parseDatabaseTimestamp('2026-08-02 03:00:00.12');
    assert.equal(fractional.toISOString(), '2026-08-02T03:00:00.120Z');
});

test('grant criado por CURRENT_TIMESTAMP fica ativo imediatamente fora de UTC', () => {
    const grant = {
        status: 'active',
        validFrom: '2026-08-02 03:00:00',
        validUntil: null,
    };

    assert.equal(
        isGrantActiveAt(grant, new Date('2026-08-02T03:00:01.000Z')),
        true
    );
    assert.equal(
        isGrantActiveAt(grant, new Date('2026-08-02T02:59:59.000Z')),
        false
    );
});

test('timestamps ISO com fuso explícito preservam a semântica original', () => {
    assert.equal(
        parseDatabaseTimestamp('2026-08-02T00:00:00-03:00').toISOString(),
        '2026-08-02T03:00:00.000Z'
    );
});
