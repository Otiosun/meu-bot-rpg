'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  included, risks, workflow, build,
} = require('../scripts/buildPublicCiSnapshot');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-public-export-test-'));
  const src = path.join(base, 'private-source');
  fs.mkdirSync(src);
  const write = (name, content) => {
    const target = path.join(src, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('package.json', '{"name":"test","version":"1.0.0"}');
  write('package-lock.json', '{"name":"test","lockfileVersion":3}');
  write('database.js', 'module.exports = {};');
  write('index.js', 'module.exports = {};');
  write('.nvmrc', '24\n');
  write('config/bot.js', 'module.exports = { COMMAND_PREFIX: ".#" };');
  write('helpers/clover/example.js', 'module.exports = () => 42;');
  write('data/clover/magias.json', '{"magias":["Fogo"]}');
  write('tests/raidBotPlayerJourney.test.js', "require('node:test')('synthetic', () => {});");
  write('data/player-canonical-batch-1.json', '{"players":[{"playerId":"123456789012345@lid"}]}');
  write('docs/jogadores.md', 'DO NOT EXPORT any player details');
  write('assets/real-player.jpg', 'NOT AN IMAGE');
  write('.git/config', '[core]\n');
  return { base, src, out: path.join(base, 'public-snapshot'), write };
}
test('only allowlisted source and synthetic-focused tests can leave private repo', () => {
  assert.equal(included('data/player-canonical-batch-1.json'), false);
  assert.equal(included('data/player-canonical-batch-1.resolution-note.md'), false);
  assert.equal(included('data/inventory/legacy-event-reward-resolutions-v1.json'), false);
  assert.equal(included('docs/example.md'), false);
  assert.equal(included('assets/player.jpg'), false);
  assert.equal(included('.github/workflows/production.yml'), false);
  assert.equal(included('tests/raidRewardProposalAuthorshipGuard.test.js'), false);
  assert.equal(included('tests/raidBotPlayerJourney.test.js'), true);
  assert.equal(included('../secrets.json'), false);
});
test('detect sensitive JIDs, tokens, paths and email without printing values', () => {
  assert.ok(risks('helpers/a.js', '"1234567890123@lid"').includes('whatsapp-identity'));
  assert.ok(risks('helpers/a.js', 'ghp_' + 'A'.repeat(30)).includes('secret-like-value'));
  assert.ok(risks('config/bot.js', 'name@example.com').length === 0);
  assert.ok(risks('config/bot.js', 'private.person@realcompany.com').includes('email-address'));
  assert.ok(risks('config/bot.js', 'C:\\Users\\someone\\Documents\\data').includes('personal-local-path'));
});
test('builds only new-history-safe files and a CI workflow, never a git history', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const result = build(f.src, f.out);
  assert.equal(result.status, 'prepared-not-published');
  assert.equal(result.tests, 1);
  assert.ok(fs.existsSync(path.join(f.out, '.github/workflows/clover-ci.yml')));
  assert.ok(fs.existsSync(path.join(f.out, 'snapshot-manifest.json')));
  assert.ok(!fs.existsSync(path.join(f.out, '.git')));
  assert.ok(!fs.existsSync(path.join(f.out, 'docs')));
  assert.ok(!fs.existsSync(path.join(f.out, 'assets')));
  assert.ok(!fs.existsSync(path.join(f.out, 'data/player-canonical-batch-1.json')));
  assert.ok(fs.existsSync(path.join(f.out, 'data/clover/magias.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'snapshot-manifest.json'), 'utf8'));
  assert.ok(manifest.files.every((entry) => !entry.path.includes('player-canonical')));
  assert.match(workflow(), /node-version: '24'/);
});
test('blocks a sensitive identifier before creating any output', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  f.write('helpers/clover/example.js', 'const id = "1234567890123@lid";');
  assert.throws(() => build(f.src, f.out), (err) => err.code === 'PUBLIC_EXPORT_BLOCKED'
    && /whatsapp-identity/.test(err.message)
    && !/1234567890123/.test(err.message));
  assert.equal(fs.existsSync(f.out), false);
});
test('never overwrites output or places it inside source', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  assert.throws(() => build(f.src, path.join(f.src, 'export')), /outside source/);
  build(f.src, f.out);
  assert.throws(() => build(f.src, f.out), /never overwrite/);
});
