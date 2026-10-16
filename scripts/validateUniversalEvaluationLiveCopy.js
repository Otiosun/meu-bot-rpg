'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { CANONICAL_SCHEMA_MIGRATIONS } = require('../database');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { LIVE_SCHEMA_HISTORY_ATTESTATIONS } = require('../helpers/clover/liveSchemaHistoryAttestations');
const {
    resolveMigrationCompatibilityPlan,
} = require('../helpers/clover/schemaMigrationCompatibilityPlan');
const { runCloverSchemaMigrations } = require('../helpers/clover/schemaMigrationService');
const {
    backupSqliteDatabase,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

const EXPECTED_SOURCE_VERSION = 54;
const EXPECTED_FINAL_VERSION = 58;
const EXPECTED_RELEASE = Object.freeze([55, 56, 57, 58]);

function sourceFromArgs(argv = process.argv.slice(2)) {
    const arg = argv.find((value) => value.startsWith('--source='));
    if (!arg) throw new Error('Use --source=C:\\caminho\\banco.sqlite');
    return path.resolve(arg.slice('--source='.length));
}

async function readVersionReadOnly(filename) {
    const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        const uv = await db.get('PRAGMA user_version');
        const ledger = await db.get(
            "SELECT MAX(version) AS latest FROM clover_schema_migrations"
        );
        return {
            userVersion: Number(Object.values(uv || {})[0] || 0),
            latest: Number(ledger?.latest || 0),
        };
    } finally {
        await db.close().catch(() => {});
    }
}

async function validateLiveCopy(sourcePath) {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error(`SQLite fonte não encontrado: ${sourcePath}`);
    }

    const sourceBefore = await readVersionReadOnly(sourcePath);
    if (
        sourceBefore.userVersion !== EXPECTED_SOURCE_VERSION
        || sourceBefore.latest !== EXPECTED_SOURCE_VERSION
    ) {
        throw new Error(
            `Fonte precisa estar em v${EXPECTED_SOURCE_VERSION}; `
            + `user_version=${sourceBefore.userVersion}, ledger=${sourceBefore.latest}.`
        );
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-eval-livecopy-'));
    const copyPath = path.join(tempDir, 'banco.sqlite');

    try {
        const backup = await backupSqliteDatabase(sourcePath, copyPath);
        const copyBefore = await verifySqliteDatabase(copyPath);
        if (!copyBefore.ok) throw new Error(`Cópia inicial inválida: ${copyBefore.integrity}`);

        const db = await openCloverDatabase({ filename: copyPath });
        let plan;
        let migrationResult;
        let rows;
        try {
            plan = await resolveMigrationCompatibilityPlan(db, {
                migrations: CANONICAL_SCHEMA_MIGRATIONS,
                historicalAttestations: LIVE_SCHEMA_HISTORY_ATTESTATIONS,
            });
            migrationResult = await runCloverSchemaMigrations(db, plan);
            rows = await db.all(
                `SELECT version, migration_key, checksum
                 FROM clover_schema_migrations
                 WHERE version BETWEEN 55 AND 58
                 ORDER BY version ASC`
            );
        } finally {
            await db.close().catch(() => {});
        }

        const versions = rows.map((row) => Number(row.version));
        if (JSON.stringify(versions) !== JSON.stringify(EXPECTED_RELEASE)) {
            throw new Error(`Release incompleta na cópia: ${versions.join(', ') || 'nenhuma'}`);
        }
        if (migrationResult.latestVersion !== EXPECTED_FINAL_VERSION) {
            throw new Error(
                `Runner terminou em v${migrationResult.latestVersion}, esperado v${EXPECTED_FINAL_VERSION}.`
            );
        }

        const copyAfter = await readVersionReadOnly(copyPath);
        if (
            copyAfter.userVersion !== EXPECTED_FINAL_VERSION
            || copyAfter.latest !== EXPECTED_FINAL_VERSION
        ) {
            throw new Error(
                `Cópia terminou incoerente: user_version=${copyAfter.userVersion}, ledger=${copyAfter.latest}.`
            );
        }
        const integrity = await verifySqliteDatabase(copyPath);
        if (!integrity.ok) throw new Error(`Cópia pós-migration inválida: ${integrity.integrity}`);

        const sourceAfter = await readVersionReadOnly(sourcePath);
        if (
            sourceAfter.userVersion !== sourceBefore.userVersion
            || sourceAfter.latest !== sourceBefore.latest
        ) {
            throw new Error(
                'SQLite fonte mudou de versão durante o dry-run; interrompa e investigue o runtime antes do apply.'
            );
        }

        return {
            ok: true,
            source: sourcePath,
            sourceVersion: sourceAfter.userVersion,
            backupMethod: backup.method,
            shadowedExecutableVersions: plan.shadowedExecutableVersions,
            appliedVersions: versions,
            finalVersion: copyAfter.userVersion,
            integrity: integrity.integrity,
        };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

async function runCli() {
    try {
        const result = await validateLiveCopy(sourceFromArgs());
        console.log('');
        console.log('CLOVER LIVE-COPY VALIDATION: PASS');
        console.log(JSON.stringify(result, null, 2));
        console.log('SQLite fonte: somente leitura; nenhuma migration foi aplicada nele.');
        console.log('');
    } catch (error) {
        console.error('CLOVER LIVE-COPY VALIDATION: FAIL');
        console.error(error?.stack || error?.message || error);
        process.exitCode = 1;
    }
}

if (require.main === module) void runCli();

module.exports = {
    EXPECTED_FINAL_VERSION,
    EXPECTED_RELEASE,
    EXPECTED_SOURCE_VERSION,
    readVersionReadOnly,
    sourceFromArgs,
    validateLiveCopy,
};
