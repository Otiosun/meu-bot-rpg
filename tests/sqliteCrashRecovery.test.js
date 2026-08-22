'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { inspectSqlitePhysicalIntegrity } = require('../helpers/clover/sqlitePhysicalIntegrityService');

const WORKER = path.join(__dirname, 'fixtures', 'sqliteCrashWorker.js');

function waitForChildState(child, expected) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}.`)), 10_000);
        child.once('message', (message) => {
            clearTimeout(timer);
            if (message?.state === expected) resolve();
            else reject(new Error(message?.message || `Unexpected child state: ${message?.state}`));
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
}

function waitForExit(child) {
    return new Promise((resolve) => child.once('exit', resolve));
}

async function seed(filename) {
    const db = await openCloverDatabase({ filename });
    await db.exec(`CREATE TABLE crash_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, value TEXT NOT NULL)`);
    await db.close();
}

async function runCrashCase(t, mode) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `clover-crash-${mode}-`));
    const filename = path.join(directory, 'crash.sqlite');
    await seed(filename);
    const child = fork(WORKER, [filename, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await waitForChildState(child, mode);
    const exit = waitForExit(child);
    child.kill('SIGKILL');
    await exit;
    return { directory, filename };
}

test('crash apos COMMIT confirmado preserva o dado e reabre integro', async (t) => {
    const { directory, filename } = await runCrashCase(t, 'committed');
    const db = await openCloverDatabase({ filename });
    t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    assert.deepEqual(await db.get(`SELECT value FROM crash_records WHERE kind = 'committed'`), { value: 'survives' });
    await inspectSqlitePhysicalIntegrity(db);
});

test('crash antes de COMMIT descarta a transacao aberta e reabre integro', async (t) => {
    const { directory, filename } = await runCrashCase(t, 'uncommitted');
    const db = await openCloverDatabase({ filename });
    t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    assert.equal(await db.get(`SELECT value FROM crash_records WHERE kind = 'uncommitted'`), undefined);
    await inspectSqlitePhysicalIntegrity(db);
});
