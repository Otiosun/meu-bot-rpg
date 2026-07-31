'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

function gitHead() {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
    }).trim();
}

function sha256(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function createSource(filename) {
    const db = new DatabaseSync(filename);
    try {
        db.exec(`
            CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO evidence (value) VALUES ('preservado');
        `);
    } finally {
        db.close();
    }
}

function readValues(filename) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
        return db.prepare('SELECT id, value FROM evidence ORDER BY id').all()
            .map((row) => ({ id: Number(row.id), value: row.value }));
    } finally {
        db.close();
    }
}

function runSnapshot(source, destination, metadata, extraArgs = []) {
    return execFileSync(process.execPath, [
        path.resolve(__dirname, '../scripts/createCloverPhase0Snapshot.js'),
        `--db=${source}`,
        `--output=${destination}`,
        `--metadata=${metadata}`,
        '--runtime-sha=runtime-fixture-sha',
        `--expected-auditor-sha=${gitHead()}`,
        ...extraArgs,
    ], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
    });
}

test('snapshot P0 é consistente, identificado e não altera a origem', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase0-snapshot-'));
    const source = path.join(directory, 'source.sqlite');
    const destination = path.join(directory, 'snapshot.sqlite');
    const metadataPath = path.join(directory, 'snapshot.metadata.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    createSource(source);
    const sourceHashBefore = sha256(source);
    const sourceValuesBefore = readValues(source);
    const stdout = runSnapshot(source, destination, metadataPath);
    const sourceHashAfter = sha256(source);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    assert.match(stdout, /O banco de origem não foi modificado/);
    assert.equal(fs.existsSync(destination), true);
    assert.equal(metadata.metadataVersion, 'clover-phase0-snapshot-v2');
    assert.equal(metadata.runtimeObserved.deployedSha, 'runtime-fixture-sha');
    assert.equal(metadata.auditor.expectedShaMatchesHead, true);
    assert.equal(metadata.snapshot.integrity, 'ok');
    assert.equal(metadata.snapshot.method, 'node:sqlite.backup');
    assert.match(metadata.snapshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(metadata.snapshot.sha256, sha256(destination));
    assert.deepEqual(readValues(destination), sourceValuesBefore);
    assert.deepEqual(readValues(source), sourceValuesBefore);
    assert.equal(sourceHashAfter, sourceHashBefore);
});

test('snapshot P0 recusa sobrescrever destino existente', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-phase0-overwrite-'));
    const source = path.join(directory, 'source.sqlite');
    const destination = path.join(directory, 'snapshot.sqlite');
    const metadataPath = path.join(directory, 'snapshot.metadata.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    createSource(source);
    fs.writeFileSync(destination, 'não substituir', 'utf8');
    const destinationBefore = fs.readFileSync(destination, 'utf8');
    let status = null;

    try {
        runSnapshot(source, destination, metadataPath);
    } catch (error) {
        status = error.status;
    }

    assert.equal(status, 1);
    assert.equal(fs.readFileSync(destination, 'utf8'), destinationBefore);
    assert.equal(fs.existsSync(metadataPath), false);
});
