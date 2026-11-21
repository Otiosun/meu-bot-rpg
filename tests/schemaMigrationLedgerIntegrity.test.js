'use strict';

// Test-only: verifies that a changed migration checksum never rewrites a historical ledger.
// No production DB, sqlite driver or schema mutation is required.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CORE_MIGRATIONS,
  migrationChecksum,
  assertAppliedMigrationsCompatible,
  runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');

function ledgerStub(rows) {
  const calls = [];
  return {
    calls,
    async exec(sql) { calls.push(['exec', sql]); },
    async all(sql) {
      calls.push(['all', sql]);
      if (/FROM clover_schema_migrations/.test(sql)) return rows.map(row => ({ ...row }));
      throw new Error('Unexpected SQL in ledgerStub');
    },
  };
}

test('changed historical checksum fails closed before any domain write', async () => {
  const first = CORE_MIGRATIONS[0];
  const rows = [{
    version: first.version,
    migration_key: first.key,
    checksum: '0'.repeat(64),
    schema_fingerprint: 'historical-fingerprint',
    applied_at: '2026-01-01',
    metadata_json: '{}',
  }];
  assert.notEqual(rows[0].checksum, migrationChecksum(first));
  const db = ledgerStub(rows);
  await assert.rejects(
    assertAppliedMigrationsCompatible(db, CORE_MIGRATIONS),
    error => error.code === 'migration_checksum_mismatch'
  );
  assert.deepEqual(rows[0].checksum, '0'.repeat(64));
  assert.ok(db.calls.every(([kind, sql]) =>
    kind === 'all' || /CREATE TABLE IF NOT EXISTS clover_schema_migrations/.test(sql)
  ));
});

test('migration runner refuses checksum mismatch before BEGIN IMMEDIATE', async () => {
  const first = CORE_MIGRATIONS[0];
  const db = ledgerStub([{
    version: first.version,
    migration_key: first.key,
    checksum: 'f'.repeat(64),
    schema_fingerprint: 'original',
  }]);
  await assert.rejects(
    runCloverSchemaMigrations(db),
    error => error.code === 'migration_checksum_mismatch'
  );
  assert.equal(db.calls.some(([, sql]) => /BEGIN IMMEDIATE|UPDATE |DELETE |INSERT INTO/i.test(sql)), false);
});

test('unchanged historical checksum is accepted without changing ledger', async () => {
  const first = CORE_MIGRATIONS[0];
  const db = ledgerStub([{
    version: first.version,
    migration_key: first.key,
    checksum: migrationChecksum(first),
    schema_fingerprint: 'original',
  }]);
  const applied = await assertAppliedMigrationsCompatible(db, CORE_MIGRATIONS);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].checksum, migrationChecksum(first));
});
