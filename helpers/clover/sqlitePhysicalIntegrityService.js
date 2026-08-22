'use strict';

const CHECK_PRAGMAS = Object.freeze(['quick_check', 'integrity_check']);
const CHECKPOINT_MODES = Object.freeze(['PASSIVE', 'RESTART', 'TRUNCATE']);

async function readCheckRows(db, pragma) {
    return db.all(`PRAGMA ${pragma}`);
}

function assertOkRows(rows, pragma) {
    const values = (rows || []).map((row) => String(Object.values(row || {})[0] || '').toLowerCase());
    if (values.length !== 1 || values[0] !== 'ok') {
        const error = new Error(`SQLite ${pragma} nao confirmou ok.`);
        error.code = 'sqlite_physical_integrity_failed';
        error.pragma = pragma;
        error.rows = rows;
        throw error;
    }
    return true;
}

async function inspectSqlitePhysicalIntegrity(db) {
    const quickCheck = await readCheckRows(db, 'quick_check');
    const integrityCheck = await readCheckRows(db, 'integrity_check');
    const foreignKeyCheck = await readCheckRows(db, 'foreign_key_check');
    assertOkRows(quickCheck, 'quick_check');
    assertOkRows(integrityCheck, 'integrity_check');
    if (foreignKeyCheck.length !== 0) {
        const error = new Error('SQLite foreign_key_check encontrou violacoes.');
        error.code = 'sqlite_foreign_key_check_failed';
        error.rows = foreignKeyCheck;
        throw error;
    }
    return Object.freeze({ quickCheck, integrityCheck, foreignKeyCheck });
}

async function checkpointSqliteWal(db, mode = 'PASSIVE') {
    const normalized = String(mode || '').trim().toUpperCase();
    if (!CHECKPOINT_MODES.includes(normalized)) throw new TypeError('Modo de checkpoint WAL invalido.');
    const row = await db.get(`PRAGMA wal_checkpoint(${normalized})`);
    const values = Object.values(row || {}).map(Number);
    if (values.length < 3 || values.some((value) => !Number.isInteger(value) || value < 0)) {
        const error = new Error('SQLite retornou checkpoint WAL invalido.');
        error.code = 'sqlite_wal_checkpoint_invalid';
        error.mode = normalized;
        error.row = row || null;
        throw error;
    }
    const [busy, logFrames, checkpointedFrames] = values;
    if (busy > 1 || checkpointedFrames > logFrames) {
        const error = new Error('SQLite retornou estado impossivel para checkpoint WAL.');
        error.code = 'sqlite_wal_checkpoint_invalid';
        error.mode = normalized;
        error.row = row;
        throw error;
    }
    return Object.freeze({ mode: normalized, busy, logFrames, checkpointedFrames, row });
}

module.exports = {
    CHECKPOINT_MODES,
    CHECK_PRAGMAS,
    checkpointSqliteWal,
    inspectSqlitePhysicalIntegrity,
};
