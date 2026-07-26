'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

function loadNativeSqliteBackup() {
    try {
        const native = require('node:sqlite');
        if (typeof native?.backup === 'function' && typeof native?.DatabaseSync === 'function') {
            return native;
        }
    } catch {}
    return null;
}

async function verifySqliteDatabase(databasePath) {
    const db = await open({
        filename: path.resolve(databasePath),
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    try {
        await db.exec('PRAGMA query_only = ON');
        const row = await db.get('PRAGMA integrity_check');
        const integrity = row?.integrity_check || Object.values(row || {})[0] || null;
        return { ok: integrity === 'ok', integrity };
    } finally {
        await db.close();
    }
}

async function backupWithNativeNodeSqlite(sourcePath, destinationPath) {
    const native = loadNativeSqliteBackup();
    if (!native) {
        const error = new Error(
            'O Node atual não oferece node:sqlite.backup(). Use Node 22.16+ ou Node 24 para criar um snapshot seguro.'
        );
        error.code = 'native_sqlite_backup_unavailable';
        throw error;
    }

    const source = new native.DatabaseSync(sourcePath, {
        readOnly: true,
        timeout: 10000,
    });
    try {
        await native.backup(source, destinationPath, { rate: 256 });
    } finally {
        source.close();
    }
}

async function backupSqliteDatabase(sourcePathInput, destinationPathInput) {
    const sourcePath = path.resolve(sourcePathInput);
    const destinationPath = path.resolve(destinationPathInput);
    if (!fs.existsSync(sourcePath)) throw new Error(`Banco de origem não encontrado: ${sourcePath}`);
    if (sourcePath === destinationPath) throw new Error('Origem e destino do backup não podem ser iguais.');

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);

    await backupWithNativeNodeSqlite(sourcePath, destinationPath);

    const verification = await verifySqliteDatabase(destinationPath);
    if (!verification.ok) {
        try { fs.unlinkSync(destinationPath); } catch {}
        throw new Error(`Backup criado, mas falhou na integridade: ${verification.integrity || 'desconhecida'}`);
    }
    return {
        sourcePath,
        destinationPath,
        bytes: fs.statSync(destinationPath).size,
        integrity: verification.integrity,
        method: 'node:sqlite.backup',
    };
}

module.exports = {
    backupSqliteDatabase,
    backupWithNativeNodeSqlite,
    loadNativeSqliteBackup,
    verifySqliteDatabase,
};
