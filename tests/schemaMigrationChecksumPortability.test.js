'use strict';

// Diagnóstico read-only: documenta a sensibilidade histórica do checksum a CRLF/LF.
// NÃO normaliza checksums existentes nem toca o ledger SQLite.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CORE_MIGRATIONS, migrationChecksum } = require('../helpers/clover/schemaMigrationService');

function checksumWithSource(migration, source) {
    const payload = {
        version: migration.version,
        key: migration.key,
        description: migration.description || '',
        up: source,
    };
    if (migration.checksumMaterial !== undefined) {
        payload.checksumMaterial = migration.checksumMaterial;
    }
    return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

test('checksum do migrador corresponde ao material de origem sem reescrita', () => {
    for (const migration of CORE_MIGRATIONS) {
        assert.equal(
            migrationChecksum(migration),
            checksumWithSource(migration, String(migration.up)),
            migration.key
        );
    }
});

test('CRLF e LF produzem hashes diferentes para migrations multilinha', () => {
    let checked = 0;
    for (const migration of CORE_MIGRATIONS) {
        const original = String(migration.up);
        if (!original.includes('\n')) continue;
        const lf = original.replace(/\r\n/g, '\n');
        const crlf = lf.replace(/\n/g, '\r\n');
        assert.notEqual(checksumWithSource(migration, lf), checksumWithSource(migration, crlf), migration.key);
        checked += 1;
    }
    assert.ok(checked > 0, 'nenhuma migration multilinha exercitada');
});

test('mudança de material explícito permanece detectável', () => {
    const migration = CORE_MIGRATIONS.find((item) => item.checksumMaterial !== undefined);
    assert.ok(migration, 'migration com checksumMaterial necessária');
    const changed = { ...migration, checksumMaterial: [{ changed: true }] };
    assert.notEqual(migrationChecksum(migration), migrationChecksum(changed));
});
