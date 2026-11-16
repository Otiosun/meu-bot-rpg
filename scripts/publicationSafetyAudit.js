'use strict';

/**
 * Conservative pre-publication guard for Clover.
 *
 * DOES NOT print matched private values. Does not delete or modify files.
 * This is a minimum safety gate, NOT a certificate that history is clean.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const HIGH_RISK_PATH = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:auth_info|session|sessions|backups?|secrets?|credentials?)(?:\/|$)/i,
  /\.(?:pem|p12|pfx|key|sqlite(?:\d+)?|db)(?:$|\.)/i,
  /(^|\/)(?:owner-access|service-account|private-key)\.(?:json|txt)$/i,
  /^data\/player-canonical-batch-/i,
];

const PERSONAL_RECORD_PATH = /^(?:data|docs|config|scripts)\/|\.(?:json|md|txt|csv|yml|yaml)$/i;
const SECRETS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:github_pat_[A-Za-z0-9_]{18,}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{18,}|sk-[A-Za-z0-9_-]{24,})\b/,
];

function pathReasons(path) {
  return HIGH_RISK_PATH.some((pattern) => pattern.test(path))
    ? ['sensitive-file-path']
    : [];
}

function contentReasons(path, content) {
  const reasons = [];
  if (SECRETS.some((pattern) => pattern.test(content))) reasons.push('secret-like-content');
  if (PERSONAL_RECORD_PATH.test(path)
      && /\b\d{8,20}@(lid|s\.whatsapp\.net)\b/i.test(content)) {
    reasons.push('whatsapp-identity');
  }
  if (PERSONAL_RECORD_PATH.test(path)
      && /^data\/player-canonical-/i.test(path)
      && /"(?:playerId|identityHints|records)"\s*:/i.test(content)) {
    reasons.push('player-identity-record');
  }
  return reasons;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

function historyPaths() {
  // A full-history checkout is required: actions/checkout fetch-depth: 0.
  // This detects known sensitive paths in ANY reachable commit even after deletion.
  return execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only'], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  }).split('\n').map((line) => line.trim()).filter(Boolean);
}

function scan() {
  const findings = new Map();
  const record = (path, reason) => {
    const previous = findings.get(path) || new Set();
    previous.add(reason);
    findings.set(path, previous);
  };

  for (const file of trackedFiles()) {
    for (const reason of pathReasons(file)) record(file, reason);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    if (stat.size > 2 * 1024 * 1024) {
      if (PERSONAL_RECORD_PATH.test(file)) record(file, 'manual-review-large-file');
      continue;
    }
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) {
      if (PERSONAL_RECORD_PATH.test(file)) record(file, 'manual-review-binary-file');
      continue;
    }
    const content = buf.toString('utf8');
    for (const reason of contentReasons(file, content)) record(file, reason);
  }

  const historical = new Set(historyPaths());
  for (const file of historical) {
    if (pathReasons(file).length) record(file, 'sensitive-path-in-git-history');
  }

  return [...findings].map(([path, reasons]) => ({
    path, reasons: [...reasons].sort(),
  })).sort((a,b) => a.path.localeCompare(b.path));
}

function main() {
  let findings;
  try { findings = scan(); }
  catch (err) {
    console.error('PUBLICATION GATE: could not complete audit: ' + err.message);
    process.exitCode = 2;
    return;
  }

  if (findings.length) {
    console.error('PUBLICATION GATE: BLOCKED (' + findings.length + ' paths require review).');
    // Filenames can themselves contain phone numbers and private IDs.
    // Never print raw paths or matching snippets to CI logs.
    const totals = new Map();
    for (const item of findings) {
      for (const reason of item.reasons) {
        totals.set(reason, (totals.get(reason) || 0) + 1);
      }
    }
    for (const [reason, count] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
      console.error('- ' + reason + ': ' + count + ' flagged paths');
    }
    console.error('Identity values, credential contents and raw filenames are deliberately redacted.');
    console.error('Removing these paths in a new commit does NOT erase git history.');
    console.error('Keep the original repository private; prepare a NEW clean-history export.');
    process.exitCode = 1;
  } else {
    console.log('Publication gate: no flagged indicators in tracked files/known history paths.');
    console.log('This is not a complete security, licensing, or privacy audit.');
  }
}

module.exports = { pathReasons, contentReasons, scan };
if (require.main === module) main();
