'use strict';
/**
 * Build a fail-closed, clean-history, CI-ONLY snapshot.
 * No remote GitHub writes. No original history, documents, media, player
 * records, auth sessions, production config or unreviewed test fixtures.
 * Heuristic scanning does not replace human review before publication.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = new Set(['package.json', 'package-lock.json', '.node-version', '.nvmrc', 'database.js', 'index.js']);
const GAME_DATA = new Set([
  'anomalias', 'aptidoesComuns', 'aptidoesRaras', 'classesSociais',
  'estagios', 'familias', 'grimorios', 'magias', 'marcasComuns',
  'marcasRaras', 'racas', 'raridadesMagicas', 'reinos',
].map((name) => 'data/clover/' + name + '.json').concat([
  'data/clover/trees/criacao.json', 'data/clover/trees/fisico.json',
  'data/clover/trees/mana.json', 'data/clover/trees/reforco.json',
  'data/clover/trees/suporte.json', 'data/traits/canonical-system-traits-v1.json',
]));
const TESTS = new Set([
  'raidBotPlayerJourney', 'continuePlayerJourney', 'raidHelpCommandContract',
  'raidIdempotentHttp', 'siteApiCanonicalRaidEvidence', 'siteApiBaseRaidLifecycleEvidence',
  'squadStarNegativeBalanceContract', 'captainsSeasonStars',
  'rewardSnapshotIntegrityContract', 'raidRewardProposalRevisionHistory',
].map((name) => 'tests/' + name + '.test.js'));

function included(name) {
  const p = String(name).replace(/\\/g, '/');
  if (p.startsWith('/') || p.split('/').includes('..')) return false;
  return ROOT.has(p) || GAME_DATA.has(p) || TESTS.has(p)
    || /^(?:comandos|helpers|database)\/[A-Za-z0-9_./-]+\.js$/.test(p)
    || /^helpers\/[A-Za-z0-9_./-]+\.json$/.test(p)
    || p === 'config/bot.js';
}
function risks(name, content) {
  const result = [];
  if (/\b\d{8,20}@(lid|s\.whatsapp\.net|c\.us)\b/i.test(content)) result.push('whatsapp-identity');
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{18,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{18,}|sk-[A-Za-z0-9_-]{24,})/.test(content)) result.push('secret-like-value');
  if (/\b(?:playerId|whatsappId|senderJid|ownerJid|phoneNumber)\s*[:=]\s*['"]\+?\d{10,20}['"]/i.test(content)) result.push('embedded-personal-identifier');
  const emails = content.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  if (emails.some((x) => !/@(?:example\.(?:com|org|net)|test\.(?:com|org)|s\.whatsapp\.net|invalid)$/i.test(x))) result.push('email-address');
  if (/C:\\Users\\[^\\\r\n"' ]+\\/i.test(content) || /\/(?:Users|home)\/[^/\r\n"' ]+\//.test(content)) result.push('personal-local-path');
  if (/\b(?:access[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|password)\b\s*[:=]\s*['"][^"'\r\n]{18,}['"]/i.test(content)) result.push('possible-embedded-credential');
  if (/^data\/player-canonical-/.test(name) || /\bidentityHints\b/.test(name)) result.push('identity-artifact');
  return result;
}
function files(source, relative = '', output = []) {
  for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
    if (['.git', 'node_modules', 'logs', 'backups', 'auth_info', 'tmp', 'artifacts'].includes(entry.name)) continue;
    const next = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) {
      if (included(next)) output.push({ name: next, type: 'symlink' });
    } else if (entry.isDirectory()) files(source, next, output);
    else if (entry.isFile()) output.push({ name: next, type: 'file' });
  }
  return output;
}
function workflow() {
  return [
    'name: Clover sanitized CI',
    'on: [push, pull_request, workflow_dispatch]',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  focused-tests:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 25',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '24'",
    '      - run: npm ci --no-audit --no-fund',
    '      - name: Run available focused tests',
    '        shell: bash',
    '        run: |',
    '          if ! compgen -G "tests/*.test.js" > /dev/null; then echo "No tests available"; exit 1; fi',
    '          node --test tests/*.test.js',
    '',
  ].join('\n');
}
function build(source, target) {
  const from = fs.realpathSync(path.resolve(source));
  const to = path.resolve(target);
  if (to === from || to.startsWith(from + path.sep)) throw new Error('Output must be outside source');
  if (fs.existsSync(to)) throw new Error('Output exists; never overwrite');
  if (!fs.existsSync(path.join(from, 'package-lock.json'))) throw new Error('Missing package-lock.json');
  const all = files(from);
  const picked = all.filter((x) => included(x.name));
  const errors = [];
  const safe = [];
  for (const f of picked) {
    if (f.type !== 'file') {
      errors.push({ reason: 'symlink-not-allowed', path: f.name }); continue;
    }
    const full = path.join(from, ...f.name.split('/'));
    const stat = fs.statSync(full);
    if (stat.size > 1024 * 1024) {
      errors.push({ reason: 'large-file-not-reviewed', path: f.name }); continue;
    }
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) {
      errors.push({ reason: 'binary-not-allowed', path: f.name }); continue;
    }
    const text = bytes.toString('utf8');
    for (const reason of risks(f.name, text)) {
      errors.push({ reason, path: f.name });
    }
    safe.push({ name: f.name, text });
  }
  if (errors.length) {
    // All selected paths are code files with fixed or constrained names.
    // Suppress long number sequences in filenames as a second safety layer.
    const flagged = errors.map((entry) => ({
      reason: entry.reason,
      path: entry.path.replace(/\d{5,}/g, '[number]'),
    }));
    const error = new Error('BLOCKED: ' + JSON.stringify(flagged) + '. No content was published.');
    error.code = 'PUBLIC_EXPORT_BLOCKED';
    throw error;
  }
  if (safe.length < 5 || !safe.some((x) => x.name === 'package.json')) throw new Error('Incomplete snapshot');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-clean-ci-'));
  try {
    const manifest = [];
    for (const f of safe) {
      const dest = path.join(staging, ...f.name.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.text);
      manifest.push({ path: f.name, sha256: crypto.createHash('sha256').update(f.text).digest('hex') });
    }
    const workflowFile = path.join(staging, '.github', 'workflows', 'clover-ci.yml');
    fs.mkdirSync(path.dirname(workflowFile), { recursive: true });
    fs.writeFileSync(workflowFile, workflow());
    fs.writeFileSync(path.join(staging, 'PUBLIC-SNAPSHOT.md'), [
      '# Clover — CI-only snapshot',
      'Fresh snapshot; no original Git history. Excludes player identity data,',
      'private docs, media, original workflows, runtime sessions and deployment configuration.',
      'Automated content heuristics do not prove this is safe to publish.',
      'Manual privacy and licensing review required before publishing.',
      'Never deploy this snapshot as the production WhatsApp bot.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(staging, 'snapshot-manifest.json'), JSON.stringify({
      format: 'clover-clean-ci-v1', files: manifest,
    }, null, 2) + '\n');
    fs.renameSync(staging, to);
    return { status: 'prepared-not-published', selected: manifest.length, excluded: all.length - picked.length, tests: safe.filter((x) => TESTS.has(x.name)).length, output: to };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--out');
  if (index < 0 || !args[index + 1]) {
    console.error('Usage: node scripts/buildPublicCiSnapshot.js --out /path/outside-repo [--source /path/repo]');
    process.exitCode = 2; return;
  }
  const other = args.indexOf('--source');
  try {
    const result = build(other >= 0 ? args[other + 1] : process.cwd(), args[index + 1]);
    console.log(JSON.stringify(result));
    console.log('This command did not create a public repository or push code.');
  } catch (e) {
    console.error(e.code || 'SNAPSHOT_FAILED', e.message);
    process.exitCode = 1;
  }
}
module.exports = { included, risks, files, workflow, build };
if (require.main === module) main();
