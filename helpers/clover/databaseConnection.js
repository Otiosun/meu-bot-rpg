'use strict';

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const DEFAULT_BUSY_TIMEOUT_MS = 10_000;

function normalizeBusyTimeout(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BUSY_TIMEOUT_MS;
    return Math.floor(parsed);
}

async function readPragmaScalar(db, pragmaName) {
    const row = await db.get(`PRAGMA ${pragmaName}`);
    if (!row) return null;
    const values = Object.values(row);
    return values.length ? values[0] : null;
}

async function configureCloverDatabaseConnection(db, options = {}) {
    if (!db || typeof db.exec !== 'function') {
        throw new TypeError('Conexão SQLite inválida.');
    }

    const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs);
    const foreignKeys = options.foreignKeys !== false;
    const journalMode = options.journalMode === undefined ? 'WAL' : options.journalMode;

    db.configure?.('busyTimeout', busyTimeoutMs);
    await db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

    if (foreignKeys) {
        await db.exec('PRAGMA foreign_keys = ON');
        const enabled = Number(await readPragmaScalar(db, 'foreign_keys'));
        if (enabled !== 1) {
            const error = new Error('SQLite não confirmou PRAGMA foreign_keys=ON.');
            error.code = 'foreign_keys_not_enabled';
            throw error;
        }
    }

    if (journalMode) {
        const normalizedJournal = String(journalMode).trim().toUpperCase();
        if (!/^[A-Z]+$/.test(normalizedJournal)) {
            throw new TypeError('journalMode inválido.');
        }
        await db.exec(`PRAGMA journal_mode = ${normalizedJournal}`);
    }

    return db;
}

async function openCloverDatabase(options = {}) {
    const filename = options.filename || './banco.sqlite';
    const driver = options.driver || sqlite3.Database;
    const openOptions = { filename, driver };
    if (options.mode !== undefined) openOptions.mode = options.mode;

    const db = await open(openOptions);
    try {
        await configureCloverDatabaseConnection(db, options);
        return db;
    } catch (error) {
        await db.close().catch(() => {});
        throw error;
    }
}

module.exports = {
    DEFAULT_BUSY_TIMEOUT_MS,
    configureCloverDatabaseConnection,
    openCloverDatabase,
    readPragmaScalar,
};
