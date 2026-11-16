'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  candidate, restrictedPath, scanText, inspectEntries,
} = require('../scripts/security/publicExportAudit');

test('tracked identity records never qualify as export candidates', () => {
  assert.equal(candidate('data/player-canonical-batch-1.json'), false);
  assert.equal(candidate('data/player-canonical-batch-1-import.json'), false);
  assert.equal(candidate('data/player-canonical-batch-1.resolution-note.md'), false);
  assert.equal(candidate('helpers/clover/raidService.js'), true);
  assert.equal(candidate('tests/raidIdempotentHttp.test.js'), true);
  assert.equal(candidate('assets/hero.png'), false);
  assert.equal(candidate('.github/workflows/clover-safety-tests.yml'), false);
});

test('restricted data and assets require review even without obvious IDs', () => {
  assert.equal(restrictedPath('data/fictional.json'), 'requires_explicit_exclusion_or_license_review');
  assert.equal(restrictedPath('assets/portrait.png'), 'requires_explicit_exclusion_or_license_review');
  assert.equal(restrictedPath('config/.env.production'), 'restricted_path');
});

test('WhatsApp identities, keys, and personal email domains are recognized', () => {
  assert.ok(scanText('participant=149700000000001@lid').includes('whatsapp_lid'));
  assert.ok(scanText('jid=5511999999999@s.whatsapp.net').includes('whatsapp_jid'));
  assert.ok(scanText('mail=user@example@gmail.com').includes('personal_email'));
  assert.ok(scanText('ghp_' + 'X'.repeat(36)).includes('github_credential'));
  assert.ok(scanText('-----BEGIN RSA PRIVATE KEY-----').includes('private_key'));
});

test('report includes only paths and categories, never actual IDs or tokens', () => {
  const fakeId = '149700000000001@lid';
  const fakeToken = 'ghp_' + 'X'.repeat(36);
  const report = inspectEntries([
    { filename: 'data/player.json', text: JSON.stringify({ playerId: fakeId }) },
    { filename: 'helpers/example.js', text: 'const x = "' + fakeToken + '";' },
  ]);
  assert.equal(report.flaggedFiles, 2);
  assert.equal(report.blockedCandidates, 1);
  const serialized = JSON.stringify(report);
  assert.ok(serialized.includes('whatsapp_lid'));
  assert.ok(serialized.includes('github_credential'));
  assert.equal(serialized.includes(fakeId), false);
  assert.equal(serialized.includes(fakeToken), false);
});

test('code without private markers is not falsely blocked by this scanner', () => {
  const report = inspectEntries([
    { filename: 'helpers/example.js', text: 'module.exports = () => 42;' },
  ]);
  assert.equal(report.flaggedFiles, 0);
  assert.equal(report.candidateFiles, 1);
  assert.equal(report.blockedCandidates, 0);
});
