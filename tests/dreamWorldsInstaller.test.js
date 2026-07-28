'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { installDreamWorldsV1 } = require('../scripts/installDreamWorldsV1');

const ROOT = path.resolve(__dirname, '..');

async function createBaseDatabase(filePath) {
    const db = await open({ filename: filePath, driver: sqlite3.Database });
    try {
        await db.exec(`
            PRAGMA user_version = 7;
            CREATE TABLE jogadores (id TEXT PRIMARY KEY);
            CREATE TABLE clover_yulls_ledger (id INTEGER PRIMARY KEY);
        `);
    } finally {
        await db.close();
    }
}

async function openDb(filePath) {
    return open({ filename: filePath, driver: sqlite3.Database });
}

async function tableExists(db, table) {
    const row = await db.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [table]
    );
    return Boolean(row);
}

test('instalador recusa escrita sem autorizacao explicita', async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-installer-auth-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const database = path.join(temp, 'base.sqlite');
    await createBaseDatabase(database);

    const result = spawnSync(
        process.execPath,
        ['scripts/installDreamWorldsV1.js', `--db=${database}`],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true }
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /allow-live-write/);

    const db = await openDb(database);
    try {
        assert.equal(await tableExists(db, 'clover_dream_worlds'), false);
    } finally {
        await db.close();
    }
});

test('instalador cria backup antes da escrita e instala schema idempotente', async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-installer-live-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const database = path.join(temp, 'base.sqlite');
    await createBaseDatabase(database);

    const first = await installDreamWorldsV1({
        root: temp,
        argv: [`--db=${database}`, '--allow-live-write'],
        now: new Date('2026-07-28T12:00:00.000Z'),
    });
    const second = await installDreamWorldsV1({
        root: temp,
        argv: [`--db=${database}`, '--allow-live-write'],
        now: new Date('2026-07-28T12:01:00.000Z'),
    });

    assert.equal(fs.existsSync(first.backup.path), true);
    assert.equal(fs.existsSync(second.backup.path), true);
    assert.notEqual(first.backup.sha256, '');
    assert.equal(first.audit.summary.healthy, true);
    assert.equal(second.audit.summary.healthy, true);
    assert.equal(first.audit.summary.issueCount, 0);
    assert.equal(second.audit.summary.issueCount, 0);

    for (const counts of [first.counts, second.counts]) {
        assert.equal(counts.clover_dream_worlds, 0);
        assert.equal(counts.clover_dream_requests, 0);
        assert.equal(counts.clover_dream_runs, 0);
        assert.equal(counts.clover_dream_slots, 0);
        assert.equal(counts.clover_resonance_fragments, 0);
        assert.equal(counts.clover_resonance_fragment_versions, 0);
        assert.equal(counts.clover_dream_audit, 0);
    }

    const backupDb = await openDb(first.backup.path);
    try {
        assert.equal(await tableExists(backupDb, 'clover_dream_worlds'), false);
        assert.equal((await backupDb.get('PRAGMA user_version')).user_version, 7);
    } finally {
        await backupDb.close();
    }

    const liveDb = await openDb(database);
    try {
        assert.equal(await tableExists(liveDb, 'clover_dream_worlds'), true);
        assert.equal(await tableExists(liveDb, 'clover_resonance_fragment_versions'), true);
        assert.equal((await liveDb.get('PRAGMA user_version')).user_version, 7);
    } finally {
        await liveDb.close();
    }

    const restored = path.join(temp, 'restored.sqlite');
    fs.copyFileSync(first.backup.path, restored);
    const restoredDb = await openDb(restored);
    try {
        assert.equal(await tableExists(restoredDb, 'clover_dream_worlds'), false);
        assert.equal((await restoredDb.get('PRAGMA user_version')).user_version, 7);
    } finally {
        await restoredDb.close();
    }
});
