'use strict';

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const DEFAULT_BUSY_TIMEOUT_MS = 10_000;
const DEFAULT_JOURNAL_MODE = 'WAL';
const DEFAULT_SYNCHRONOUS = 'FULL';
const SYNCHRONOUS_VALUES = Object.freeze({ OFF: 0, NORMAL: 1, FULL: 2, EXTRA: 3 });

function normalizeBusyTimeout(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BUSY_TIMEOUT_MS;
    return Math.floor(parsed);
}

function normalizePragmaKeyword(value, label) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(normalized)) throw new TypeError(`${label} invalido.`);
    return normalized;
}

function isFileBackedDatabase(filename) {
    const value = String(filename || '').trim();
    return Boolean(value) && value !== ':memory:' && !value.startsWith('file::memory:');
}

async function readPragmaScalar(db, pragmaName) {
    const row = await db.get(`PRAGMA ${pragmaName}`);
    if (!row) return null;
    const values = Object.values(row);
    return values.length ? values[0] : null;
}

async function observeCloverDatabaseConnection(db) {
    if (!db || typeof db.get !== 'function') throw new TypeError('Conexao SQLite invalida para observacao.');
    const version = await db.get('SELECT sqlite_version() AS sqlite_version');
    const sqliteVersion = String(version?.sqlite_version || '').trim();
    if (!/^\d+\.\d+\.\d+(?:[.+-][0-9A-Za-z.-]+)?$/.test(sqliteVersion)) {
        const error = new Error('SQLite nao retornou uma versao valida.');
        error.code = 'sqlite_version_invalid';
        error.sqliteVersion = sqliteVersion || null;
        throw error;
    }
    return Object.freeze({
        sqliteVersion,
        journalMode: String(await readPragmaScalar(db, 'journal_mode') || '').toLowerCase(),
        busyTimeoutMs: Number(await readPragmaScalar(db, 'busy_timeout')),
        synchronous: Number(await readPragmaScalar(db, 'synchronous')),
        foreignKeys: Number(await readPragmaScalar(db, 'foreign_keys')),
        walAutocheckpoint: Number(await readPragmaScalar(db, 'wal_autocheckpoint')),
    });
}

function assertCloverDatabaseConnectionContract(observed, expected) {
    if (observed.busyTimeoutMs !== expected.busyTimeoutMs) {
        const error = new Error(`SQLite nao confirmou busy_timeout=${expected.busyTimeoutMs}.`);
        error.code = 'busy_timeout_not_applied';
        error.observed = observed.busyTimeoutMs;
        throw error;
    }
    if (expected.foreignKeys && observed.foreignKeys !== 1) {
        const error = new Error('SQLite nao confirmou PRAGMA foreign_keys=ON.');
        error.code = 'foreign_keys_not_enabled';
        error.observed = observed.foreignKeys;
        throw error;
    }
    if (expected.journalMode && expected.fileBacked && observed.journalMode !== expected.journalMode.toLowerCase()) {
        const error = new Error(`SQLite nao confirmou PRAGMA journal_mode=${expected.journalMode}.`);
        error.code = 'journal_mode_not_applied';
        error.observed = observed.journalMode;
        throw error;
    }
    if (expected.synchronous !== null && observed.synchronous !== SYNCHRONOUS_VALUES[expected.synchronous]) {
        const error = new Error(`SQLite nao confirmou PRAGMA synchronous=${expected.synchronous}.`);
        error.code = 'synchronous_not_applied';
        error.observed = observed.synchronous;
        throw error;
    }
    return observed;
}

async function configureCloverDatabaseConnection(db, options = {}) {
    if (!db || typeof db.exec !== 'function') throw new TypeError('Conexao SQLite invalida.');

    const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs);
    const foreignKeys = options.foreignKeys !== false;
    const journalMode = options.journalMode === undefined ? DEFAULT_JOURNAL_MODE : options.journalMode;
    const synchronous = options.synchronous === undefined ? DEFAULT_SYNCHRONOUS : options.synchronous;
    const fileBacked = options.fileBacked === undefined ? isFileBackedDatabase(options.filename) : Boolean(options.fileBacked);
    const normalizedJournal = journalMode ? normalizePragmaKeyword(journalMode, 'journalMode') : null;
    const normalizedSynchronous = synchronous === null ? null : normalizePragmaKeyword(synchronous, 'synchronous');
    if (normalizedSynchronous !== null && !Object.hasOwn(SYNCHRONOUS_VALUES, normalizedSynchronous)) {
        throw new TypeError('synchronous invalido.');
    }

    db.configure?.('busyTimeout', busyTimeoutMs);
    await db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (foreignKeys) await db.exec('PRAGMA foreign_keys = ON');
    if (normalizedJournal) await db.exec(`PRAGMA journal_mode = ${normalizedJournal}`);
    // SQLite 3.52.0 no driver atual abre em FULL. Preservamos esse valor por
    // readback fail-closed, sem reemitir PRAGMA synchronous e criar uma nova
    // transicao de durabilidade/handle durante o bootstrap Windows.

    assertCloverDatabaseConnectionContract(await observeCloverDatabaseConnection(db), {
        busyTimeoutMs,
        foreignKeys,
        journalMode: normalizedJournal,
        synchronous: normalizedSynchronous,
        fileBacked,
    });
    return db;
}

async function openCloverDatabase(options = {}) {
    const filename = options.filename || './banco.sqlite';
    const driver = options.driver || sqlite3.Database;
    const openOptions = { filename, driver };
    if (options.mode !== undefined) openOptions.mode = options.mode;

    const db = await open(openOptions);
    try {
        await configureCloverDatabaseConnection(db, { ...options, filename });
        return db;
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
}

module.exports = {
    DEFAULT_BUSY_TIMEOUT_MS,
    DEFAULT_JOURNAL_MODE,
    DEFAULT_SYNCHRONOUS,
    SYNCHRONOUS_VALUES,
    assertCloverDatabaseConnectionContract,
    configureCloverDatabaseConnection,
    isFileBackedDatabase,
    observeCloverDatabaseConnection,
    openCloverDatabase,
    readPragmaScalar,
};
