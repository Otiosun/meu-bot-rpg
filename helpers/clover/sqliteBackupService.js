'use strict';

const crypto = require('crypto');
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

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function fsyncFile(filePath) {
    const fd = fs.openSync(filePath, 'r+');
    try {
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function makeStagingPath(destinationPath) {
    const token = crypto.randomBytes(8).toString('hex');
    return path.join(
        path.dirname(destinationPath),
        `.${path.basename(destinationPath)}.creating-${process.pid}-${token}`
    );
}

function pragmaValue(row) {
    return row ? (Object.values(row)[0] ?? null) : null;
}

async function verifySqliteDatabase(databasePath) {
    const db = await open({
        filename: path.resolve(databasePath),
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    try {
        await db.exec('PRAGMA query_only = ON');
        const quickRow = await db.get('PRAGMA quick_check');
        const integrityRow = await db.get('PRAGMA integrity_check');
        const foreignKeyViolations = await db.all('PRAGMA foreign_key_check');
        const quick = pragmaValue(quickRow);
        const integrity = pragmaValue(integrityRow);
        return {
            ok: quick === 'ok' && integrity === 'ok' && foreignKeyViolations.length === 0,
            quick,
            integrity,
            foreignKeyViolations: foreignKeyViolations.length,
        };
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
    if (fs.existsSync(destinationPath)) {
        const error = new Error(`Destino de backup já existe: ${destinationPath}`);
        error.code = 'backup_destination_exists';
        throw error;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const stagingPath = makeStagingPath(destinationPath);
    let promoted = false;
    try {
        await backupWithNativeNodeSqlite(sourcePath, stagingPath);

        const stagingVerification = await verifySqliteDatabase(stagingPath);
        if (!stagingVerification.ok) {
            const error = new Error(
                `Backup criado, mas falhou na verificação: quick=${stagingVerification.quick || 'desconhecido'}, integrity=${stagingVerification.integrity || 'desconhecida'}, fk=${stagingVerification.foreignKeyViolations}`
            );
            error.code = 'backup_integrity_failed';
            throw error;
        }

        fsyncFile(stagingPath);
        const stagingBytes = fs.statSync(stagingPath).size;
        const stagingSha256 = sha256File(stagingPath);

        try {
            fs.copyFileSync(stagingPath, destinationPath, fs.constants.COPYFILE_EXCL);
            promoted = true;
        } catch (error) {
            if (error?.code === 'EEXIST') {
                const conflict = new Error(`Destino de backup já existe: ${destinationPath}`);
                conflict.code = 'backup_destination_exists';
                throw conflict;
            }
            throw error;
        }
        fsyncFile(destinationPath);

        const destinationVerification = await verifySqliteDatabase(destinationPath);
        const destinationBytes = fs.statSync(destinationPath).size;
        const destinationSha256 = sha256File(destinationPath);
        if (
            !destinationVerification.ok
            || destinationBytes !== stagingBytes
            || destinationSha256 !== stagingSha256
        ) {
            const error = new Error('Backup promovido divergiu do snapshot verificado.');
            error.code = 'backup_promotion_verification_failed';
            throw error;
        }

        return {
            sourcePath,
            destinationPath,
            bytes: destinationBytes,
            sha256: destinationSha256,
            quick: destinationVerification.quick,
            integrity: destinationVerification.integrity,
            foreignKeyViolations: destinationVerification.foreignKeyViolations,
            method: 'node:sqlite.backup',
        };
    } catch (error) {
        if (promoted) {
            try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch {}
        }
        throw error;
    } finally {
        try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch {}
    }
}

async function restoreSqliteBackupToNewPath(backupPathInput, destinationPathInput) {
    const backupPath = path.resolve(backupPathInput);
    const destinationPath = path.resolve(destinationPathInput);

    if (!fs.existsSync(backupPath)) throw new Error(`Backup de origem não encontrado: ${backupPath}`);
    if (backupPath === destinationPath) throw new Error('Origem e destino do restore não podem ser iguais.');
    if (fs.existsSync(destinationPath)) {
        const error = new Error(`Destino de restore já existe: ${destinationPath}`);
        error.code = 'restore_destination_exists';
        throw error;
    }

    const sourceVerification = await verifySqliteDatabase(backupPath);
    if (!sourceVerification.ok) {
        const error = new Error(
            `Backup recusado pela verificação: quick=${sourceVerification.quick || 'desconhecido'}, integrity=${sourceVerification.integrity || 'desconhecida'}, fk=${sourceVerification.foreignKeyViolations}`
        );
        error.code = 'restore_source_integrity_failed';
        throw error;
    }
    const sourceBytes = fs.statSync(backupPath).size;
    const sourceSha256 = sha256File(backupPath);

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    let copiedByUs = false;
    try {
        try {
            fs.copyFileSync(backupPath, destinationPath, fs.constants.COPYFILE_EXCL);
            copiedByUs = true;
        } catch (error) {
            if (error?.code === 'EEXIST') {
                const conflict = new Error(`Destino de restore já existe: ${destinationPath}`);
                conflict.code = 'restore_destination_exists';
                throw conflict;
            }
            throw error;
        }
        fsyncFile(destinationPath);
        const restoredVerification = await verifySqliteDatabase(destinationPath);
        if (!restoredVerification.ok) {
            const error = new Error(
                `Restore criado, mas falhou na verificação: quick=${restoredVerification.quick || 'desconhecido'}, integrity=${restoredVerification.integrity || 'desconhecida'}, fk=${restoredVerification.foreignKeyViolations}`
            );
            error.code = 'restore_destination_integrity_failed';
            throw error;
        }

        const destinationBytes = fs.statSync(destinationPath).size;
        const destinationSha256 = sha256File(destinationPath);
        if (destinationBytes !== sourceBytes || destinationSha256 !== sourceSha256) {
            const error = new Error('Restore divergiu byte-a-byte do backup verificado.');
            error.code = 'restore_hash_mismatch';
            throw error;
        }

        return {
            backupPath,
            destinationPath,
            bytes: destinationBytes,
            sha256: destinationSha256,
            sourceSha256,
            quick: restoredVerification.quick,
            integrity: restoredVerification.integrity,
            foreignKeyViolations: restoredVerification.foreignKeyViolations,
            method: 'verified-copy-to-new-path',
        };
    } catch (error) {
        if (copiedByUs) {
            try { if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath); } catch {}
        }
        throw error;
    }
}

module.exports = {
    backupSqliteDatabase,
    backupWithNativeNodeSqlite,
    loadNativeSqliteBackup,
    restoreSqliteBackupToNewPath,
    sha256File,
    verifySqliteDatabase,
};
