'use strict';

/**
 * SAFE, READ-ONLY public-export preflight. It NEVER copies or publishes files.
 * Output contains only file paths and finding categories, NEVER matched values.
 *
 * A green scan is not authorization to publish: a fresh repository with no
 * shared Git history, a license review, and a manual content review are needed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CANDIDATE_PREFIXES = Object.freeze([
  'comandos/', 'helpers/', 'tests/', 'database/', 'config/',
]);
const CANDIDATE_ROOT = new Set([
  'index.js', 'database.js', 'package.json', 'package-lock.json',
  '.node-version', '.nvmrc', '.gitignore',
]);

function candidate(pathname) {
  return CANDIDATE_ROOT.has(pathname) ||
    CANDIDATE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function restrictedPath(pathname) {
  if (/^(?:data|assets|docs|scripts|\.github|\.circleci)\//i.test(pathname)) {
    return 'requires_explicit_exclusion_or_license_review';
  }
  if (/(?:^|\/)(?:auth_info|backups?|secrets?|private|logs|tmp|temp)(?:\/|$)/i.test(pathname) ||
      /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(pathname)) {
    return 'restricted_path';
  }
  return null;
}

const PATTERNS = Object.freeze({
  whatsapp_lid: /\b\d{8,20}@lid\b/i,
  whatsapp_jid: /\b\d{10,18}@s\.whatsapp\.net\b/i,
  whatsapp_group: /\b\d{10,22}(?:-\d{8,16})?@g\.us\b/i,
  possible_phone: /(?:^|[^\d])(?:\+?55[\s().-]?)?\(?\d{2}\)?[\s().-]?\d{4,5}[\s().-]?\d{4}(?!\d)/,
  personal_email: /\b[A-Z0-9._%+-]+@(?:gmail|outlook|hotmail|yahoo|icloud|protonmail|proton)\.(?:com|com\.br|me)\b/i,
  github_credential: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  api_credential: /\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16})\b/,
  private_key: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  literal_secret: /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|SESSION_SECRET)\s*[:=]\s*['"][^'"$\r\n]{12,}['"]/i,
});

function scanText(content) {
  const categories = [];
  for (const [category, pattern] of Object.entries(PATTERNS)) {
    if (pattern.test(content)) categories.push(category);
  }
  return categories;
}

function inspectEntries(entries) {
  const details = [];
  let candidates = 0;
  let blockedCandidates = 0;
  for (const { filename, text, isBinary = false } of entries) {
    const selected = candidate(filename);
    if (selected) candidates++;
    const findings = [];
    const restricted = restrictedPath(filename);
    if (restricted) findings.push(restricted);
    if (isBinary) {
      if (selected) findings.push('binary_not_reviewed');
    } else {
      findings.push(...scanText(text));
    }
    if (findings.length) {
      if (selected) blockedCandidates++;
      details.push({ path: filename, candidate: selected, findings });
    }
  }
  return { scannedFiles: entries.length, candidateFiles: candidates,
    blockedCandidates, flaggedFiles: details.length, details };
}

function trackedEntries(root = process.cwd()) {
  const paths = execFileSync('git', ['ls-files', '-z'], {
    cwd: root, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean);
  return paths.map(filename => {
    if (filename.startsWith('/') || filename.split('/').includes('..')) {
      throw new Error('Unsafe tracked path');
    }
    const stat = fs.lstatSync(path.join(root, filename));
    if (!stat.isFile()) return { filename, text: '', isBinary: true };
    const buffer = fs.readFileSync(path.join(root, filename));
    const binary = buffer.includes(0);
    return {
      filename,
      text: binary ? '' : buffer.toString('utf8'),
      isBinary: binary,
    };
  });
}

function run() {
  const report = inspectEntries(trackedEntries());
  const grouped = {};
  for (const item of report.details) {
    for (const category of item.findings) {
      grouped[category] = (grouped[category] || 0) + 1;
    }
  }
  const sanitized = {
    status: 'NOT_APPROVED_FOR_PUBLICATION',
    reason: 'Source history, licenses and all flagged paths require separate review',
    scannedFiles: report.scannedFiles,
    candidateFiles: report.candidateFiles,
    blockedCandidates: report.blockedCandidates,
    flaggedFiles: report.flaggedFiles,
    findingCounts: grouped,
    findings: report.details.map(entry => ({
      path: entry.path,
      candidate: entry.candidate,
      categories: entry.findings,
    })),
    warnings: [
      'No secrets or personal values are printed in this report.',
      'Original Git history cannot be made safe by deleting files in a later commit.',
      'Never make the original repository public as part of this process.',
      'This tool does not scan historical commits or prove licensing compliance.',
      'A distinct sanitized repository must start with a fresh initial commit.',
    ],
  };

  const dir = path.join(process.cwd(), 'artifacts', 'public-ci-safety');
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, 'audit.json');
  fs.writeFileSync(output, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
  console.log('PUBLIC CI AUDIT — NOT APPROVED FOR PUBLICATION');
  console.log(JSON.stringify({
    scannedFiles: report.scannedFiles, candidateFiles: report.candidateFiles,
    blockedCandidates: report.blockedCandidates,
    flaggedFiles: report.flaggedFiles, findingCounts: grouped,
    report: 'artifacts/public-ci-safety/audit.json',
  }, null, 2));
  if (report.flaggedFiles) process.exitCode = 2;
}

if (require.main === module) run();
module.exports = { candidate, restrictedPath, scanText, inspectEntries, trackedEntries };
