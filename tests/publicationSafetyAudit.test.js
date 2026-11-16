'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathReasons, contentReasons } = require('../scripts/publicationSafetyAudit');

test('blocks tracked runtime credential and database filenames', () => {
  assert.deepEqual(pathReasons('.env.local'), ['sensitive-file-path']);
  assert.deepEqual(pathReasons('auth_info/session.json'), ['sensitive-file-path']);
  assert.deepEqual(pathReasons('storage/database.sqlite'), ['sensitive-file-path']);
  assert.deepEqual(pathReasons('config/private-key.json'), ['sensitive-file-path']);
});

test('blocks player canonical batch identity files without printing values', () => {
  assert.deepEqual(pathReasons('data/player-canonical-batch-1.json'), ['sensitive-file-path']);
  assert.ok(contentReasons('data/player-canonical-batch-1.json',
    '{"playerId":"sample","identityHints":{}}').includes('player-identity-record'));
});

test('flags WhatsApp identities in data and narrative documents', () => {
  assert.ok(contentReasons('data/example.json',
    '{"example":"1234567890123@lid"}').includes('whatsapp-identity'));
  assert.ok(contentReasons('docs/notes.md',
    'synthetic test person: 5511987654321@s.whatsapp.net').includes('whatsapp-identity'));
});

test('flags strong private key indicators', () => {
  assert.ok(contentReasons('config/file.txt',
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).includes('secret-like-content'));
});

test('allows ordinary fixtures, commands and game catalogues', () => {
  assert.deepEqual(pathReasons('data/clover/magias.json'), []);
  assert.deepEqual(contentReasons('data/clover/magias.json',
    '{"magia":"Fogo","nivel":2}'), []);
  assert.deepEqual(contentReasons('tests/player.test.js',
    'const playerId = "example";'), []);
});
