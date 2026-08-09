'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const EXPECTED_HELPER_BLOB = '74f5333de6679b0bbb0d882e9ba9c815c57046bd';
const V1_COMMIT = '2649831a07af9db1e64075d9a0185abadca8653d';
const V1_PATH = 'scripts/applyOrphanQuickEvaluation336StarBackfillPinnedV1.js';
const EXPECTED_V1_BLOB = '9c3cc273c238ee209646871811da2e200a203657';

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

function normalizeEol(buffer) {
  return Buffer.from(
    buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    'utf8'
  );
}

function fail(message) {
  throw new Error(message);
}

function main() {
  const repo = path.resolve(argValue('repo') || process.cwd());
  const helperPath = path.join(repo, 'helpers', 'clover', 'sqliteBackupService.js');
  const helperRaw = fs.readFileSync(helperPath);
  const helperNormalized = normalizeEol(helperRaw);
  const helperBlob = gitBlobSha(helperNormalized);
  if (helperBlob !== EXPECTED_HELPER_BLOB) {
    fail(`sqliteBackupService.js divergiu de verdade: esperado ${EXPECTED_HELPER_BLOB}, normalizado atual ${helperBlob}.`);
  }

  let v1;
  try {
    v1 = cp.execFileSync(
      'git',
      ['-C', repo, 'show', `${V1_COMMIT}:${V1_PATH}`],
      { encoding: null, maxBuffer: 4 * 1024 * 1024 }
    );
  } catch (error) {
    fail(`Não foi possível recuperar o V1 pinado ${V1_COMMIT}: ${error?.message || error}`);
  }

  const v1Blob = gitBlobSha(v1);
  if (v1Blob !== EXPECTED_V1_BLOB) {
    fail(`V1 pinado divergiu: esperado ${EXPECTED_V1_BLOB}, atual ${v1Blob}.`);
  }

  const source = v1.toString('utf8');
  const oldLine = '  const helperBlob = gitBlobSha(backupHelperBytes);';
  const newLine = "  const helperBlob = gitBlobSha(Buffer.from(backupHelperBytes.toString('utf8').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n'), 'utf8'));";
  const occurrences = source.split(oldLine).length - 1;
  if (occurrences !== 1) {
    fail(`Patch EOL recusado: esperava 1 ocorrência da trava, encontrei ${occurrences}.`);
  }

  const patched = source.replace(oldLine, newLine);
  const tempPath = path.join(os.tmpdir(), `applyOrphanQuickEvaluation336StarBackfillPinnedV2-${process.pid}.js`);
  fs.writeFileSync(tempPath, patched, { encoding: 'utf8' });

  try {
    const result = cp.spawnSync(
      process.execPath,
      [tempPath, ...process.argv.slice(2)],
      { stdio: 'inherit', cwd: repo, env: process.env }
    );
    if (result.error) throw result.error;
    process.exitCode = Number.isInteger(result.status) ? result.status : 1;
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

try {
  main();
} catch (error) {
  console.error(`ORPHAN_QE_336_STAR_BACKFILL_V2_ERROR=${error?.message || error}`);
  process.exit(1);
}
