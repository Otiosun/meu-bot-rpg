'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

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

async function backupSqliteDatabase(sourcePathInput, destinationPathInput) {
    const sourcePath = path.resolve(sourcePathInput);
    const destinationPath = path.resolve(destinationPathInput);
    if (!fs.existsSync(sourcePath)) throw new Error(`Banco de origem não encontrado: ${sourcePath}`);
    if (sourcePath === destinationPath) throw new Error('Origem e destino do backup não podem ser iguais.');

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);

    const source = await open({
        filename: sourcePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    try {
        if (typeof source.backup !== 'function') {
            throw new Error('A versão atual do módulo sqlite não oferece Database.backup().');
        }
        await source.backup(destinationPath);
    } finally {
        await source.close();
    }

    const verification = await verifySqliteDatabase(destinationPath);
    if (!verification.ok) {
        throw new Error(`Backup criado, mas falhou na integridade: ${verification.integrity || 'desconhecida'}`);
    }
    return {
        sourcePath,
        destinationPath,
        bytes: fs.statSync(destinationPath).size,
        integrity: verification.integrity,
    };
}

module.exports = {
    backupSqliteDatabase,
    verifySqliteDatabase,
};
