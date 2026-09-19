'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class BlankIdentityAuditError extends Error {
    constructor(message, code = 'blank_identity_audit_failed', details = null) {
        super(message || code);
        this.name = 'BlankIdentityAuditError';
        this.code = code;
        this.details = details;
    }
}

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
        failOnUnsafe: false,
        jsonOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) options.expectedAuditorSha = arg.slice(23);
        else if (arg === '--fail-on-unsafe') options.failOnUnsafe = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else throw new BlankIdentityAuditError(`Argumento desconhecido: ${arg}`, 'unknown_argument');
    }
    return options;
}

function currentGitSha(cwd = path.resolve(__dirname, '..')) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
        return null;
    }
}

function sameSha(left, right) {
    if (!left || !right) return null;
    const a = String(left).trim();
    const b = String(right).trim();
    return a.startsWith(b) || b.startsWith(a);
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function fileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function openReadOnlyDatabase(filename) {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    const db = await open({
        filename,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    await db.exec('PRAGMA query_only = ON');
    const row = await db.get('PRAGMA query_only');
    const enabled = Number(row?.query_only ?? Object.values(row || {})[0]) === 1;
    if (!enabled) {
        await db.close().catch(() => null);
        throw new BlankIdentityAuditError(
            'Não foi possível confirmar PRAGMA query_only=ON.',
            'query_only_not_enabled'
        );
    }
    return db;
}

function unwrapDefault(value) {
    if (value === null || value === undefined) return { known: true, value: null };
    let text = String(value).trim();
    while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
    if (/^null$/i.test(text)) return { known: true, value: null };
    if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) return { known: true, value: Number(text) };
    if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
        const quote = text[0];
        const inner = text.slice(1, -1);
        return {
            known: true,
            value: quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/""/g, '"'),
        };
    }
    return { known: false, value: text };
}

function sameScalar(left, right) {
    if (left === null || left === undefined) return right === null || right === undefined;
    if (typeof right === 'number') return Number(left) === right;
    return String(left) === String(right);
}

function isEmptyPlaceholder(value) {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string') return false;
    const text = value.trim();
    return text === '' || text === '-' || text === '[]' || text === '{}';
}

function normalizeToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function isBlankId(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

function isPlaceholderSignature(row) {
    return isBlankId(row.id)
        && normalizeToken(row.nome) === 'cacador'
        && normalizeToken(row.display_name) === 'cacador'
        && isEmptyPlaceholder(row.personagem_nome)
        && isBlankId(row.canonical_player_id)
        && normalizeToken(row.ficha_status) === 'incompleta'
        && normalizeToken(row.jogo_status) === 'bloqueado'
        && isEmptyPlaceholder(row.esquadrao)
        && Number(row.is_shadow || 0) === 0
        && isBlankId(row.merged_into)
        && isBlankId(row.archived_at)
        && isBlankId(row.archive_reason);
}

function analyzeBlankRows(columns, rows) {
    const byName = new Map(columns.map((column) => [column.name, column]));
    const allowedNonDefault = new Set(['id', 'nome', 'display_name']);
    return rows.map((row) => {
        const deviations = [];
        for (const column of columns) {
            if (allowedNonDefault.has(column.name)) continue;
            const value = row[column.name];
            const parsed = unwrapDefault(column.dflt_value);
            if (parsed.known && sameScalar(value, parsed.value)) continue;
            if (isEmptyPlaceholder(value)) continue;
            deviations.push({
                column: column.name,
                valueType: value === null ? 'null' : typeof value,
                preview: typeof value === 'string' && value.length > 120
                    ? `${value.slice(0, 117)}...`
                    : value,
                declaredDefault: byName.get(column.name)?.dflt_value ?? null,
            });
        }
        return {
            rowid: row.__rowid__,
            idKind: row.id === null ? 'null' : String(row.id).trim() === '' ? 'blank' : 'other',
            name: row.nome ?? null,
            displayName: row.display_name ?? null,
            characterName: row.personagem_nome ?? null,
            sheetStatus: row.ficha_status ?? null,
            gameStatus: row.jogo_status ?? null,
            squad: row.esquadrao ?? null,
            placeholderSignature: isPlaceholderSignature(row),
            substantiveDeviationCount: deviations.length,
            substantiveDeviations: deviations,
        };
    });
}

async function tableExists(db, tableName) {
    return Boolean((await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    ))?.found);
}

async function listTables(db) {
    return db.all(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
}

async function tableInfo(db, tableName) {
    return db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
}

async function foreignKeyList(db, tableName) {
    return db.all(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
}

async function findForeignKeysToPlayers(db, tables) {
    const findings = [];
    for (const table of tables) {
        if (table.name === 'jogadores') continue;
        const foreignKeys = await foreignKeyList(db, table.name);
        for (const key of foreignKeys || []) {
            if (String(key.table || '').toLowerCase() !== 'jogadores') continue;
            const column = key.from;
            const stats = await db.get(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN ${quoteIdentifier(column)} IS NULL OR TRIM(CAST(${quoteIdentifier(column)} AS TEXT)) = '' THEN 1 ELSE 0 END) AS blank_count
                 FROM ${quoteIdentifier(table.name)}`
            );
            findings.push({
                table: table.name,
                column,
                targetColumn: key.to || 'id',
                onUpdate: key.on_update || null,
                onDelete: key.on_delete || null,
                rowCount: Number(stats?.total || 0),
                blankChildCount: Number(stats?.blank_count || 0),
            });
        }
    }
    return findings;
}

function isExplicitRowidReferenceColumn(name) {
    return /^(?:player|jogador)_?rowid$/i.test(String(name || ''))
        || /(?:^|_)(?:player|jogador)_rowid$/i.test(String(name || ''));
}

async function findExplicitRowidReferences(db, tables, rowids) {
    if (!rowids.length) return [];
    const findings = [];
    const placeholders = rowids.map(() => '?').join(', ');
    for (const table of tables) {
        if (table.name === 'jogadores') continue;
        const columns = await tableInfo(db, table.name);
        for (const column of columns) {
            if (!isExplicitRowidReferenceColumn(column.name)) continue;
            const count = await db.get(
                `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table.name)}
                 WHERE ${quoteIdentifier(column.name)} IN (${placeholders})`,
                rowids
            );
            if (Number(count?.total || 0) > 0) {
                findings.push({
                    table: table.name,
                    column: column.name,
                    matchCount: Number(count.total),
                });
            }
        }
    }
    return findings;
}

function isNameReferenceColumn(column) {
    const name = String(column.name || '').toLowerCase();
    const type = String(column.type || '').toUpperCase();
    return (!type || type.includes('TEXT'))
        && /(nome|name|display|personagem|character)/.test(name);
}

async function findCacadorNameReferences(db, tables) {
    const findings = [];
    for (const table of tables) {
        if (table.name === 'jogadores') continue;
        const columns = await tableInfo(db, table.name);
        for (const column of columns) {
            if (!isNameReferenceColumn(column)) continue;
            const count = await db.get(
                `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table.name)}
                 WHERE LOWER(TRIM(CAST(${quoteIdentifier(column.name)} AS TEXT))) = 'cacador'`
            );
            if (Number(count?.total || 0) > 0) {
                findings.push({
                    table: table.name,
                    column: column.name,
                    matchCount: Number(count.total),
                });
            }
        }
    }
    return findings;
}

async function inspectBlankPlayerIdentities(db) {
    if (!await tableExists(db, 'jogadores')) {
        throw new BlankIdentityAuditError('Tabela jogadores ausente.', 'players_table_missing');
    }
    const tables = await listTables(db);
    const playersTable = tables.find((table) => table.name === 'jogadores');
    const columns = await tableInfo(db, 'jogadores');
    const idColumn = columns.find((column) => column.name === 'id') || null;
    const rows = await db.all(
        `SELECT rowid AS __rowid__, * FROM jogadores
         WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''
         ORDER BY rowid`
    );
    const analyzedRows = analyzeBlankRows(columns, rows || []);
    const rowids = analyzedRows.map((row) => row.rowid).filter(Number.isInteger);
    const [foreignKeys, explicitRowidReferences, nameReferences] = await Promise.all([
        findForeignKeysToPlayers(db, tables),
        findExplicitRowidReferences(db, tables, rowids),
        findCacadorNameReferences(db, tables),
    ]);
    const dataBearingRows = analyzedRows.filter((row) => row.substantiveDeviationCount > 0);
    const nonPlaceholderRows = analyzedRows.filter((row) => !row.placeholderSignature);
    const criticalReasons = [];
    const reviewReasons = [];
    if (dataBearingRows.length) criticalReasons.push('blank_identity_contains_substantive_data');
    if (nonPlaceholderRows.length) criticalReasons.push('blank_identity_signature_mismatch');
    if (explicitRowidReferences.length) criticalReasons.push('explicit_rowid_reference_found');
    if (nameReferences.length) reviewReasons.push('external_cacador_name_reference_found');
    if (!idColumn || Number(idColumn.pk || 0) !== 1) criticalReasons.push('players_id_not_primary_key');
    if (!idColumn || Number(idColumn.notnull || 0) !== 1) reviewReasons.push('players_id_allows_null');

    return {
        write: false,
        queryOnlySafe: true,
        schema: {
            tableSql: playersTable?.sql || null,
            idColumn,
            idPrimaryKey: Number(idColumn?.pk || 0) === 1,
            idNotNull: Number(idColumn?.notnull || 0) === 1,
            columnCount: columns.length,
        },
        summary: {
            blankIdentityCount: analyzedRows.length,
            exactPlaceholderCount: analyzedRows.filter((row) => row.placeholderSignature).length,
            dataBearingCount: dataBearingRows.length,
            signatureMismatchCount: nonPlaceholderRows.length,
            foreignKeyDefinitionCount: foreignKeys.length,
            explicitRowidReferenceCount: explicitRowidReferences.reduce((sum, item) => sum + item.matchCount, 0),
            externalNameReferenceCount: nameReferences.reduce((sum, item) => sum + item.matchCount, 0),
            critical: criticalReasons.length > 0,
            reviewRequired: criticalReasons.length > 0 || reviewReasons.length > 0,
        },
        criticalReasons,
        reviewReasons,
        rows: analyzedRows,
        foreignKeysToPlayers: foreignKeys,
        explicitRowidReferences,
        externalCacadorNameReferences: nameReferences,
        recommendation: criticalReasons.length || reviewReasons.length
            ? 'Não remover automaticamente. Classificar referências e corrigir schema antes da limpeza.'
            : 'Candidatos homogêneos para limpeza reversível após backup e reconstrução de schema.',
    };
}

async function runAudit(options, dependencies = {}) {
    const absoluteDb = path.resolve(options.db);
    if (!fs.existsSync(absoluteDb)) {
        throw new BlankIdentityAuditError(`Banco não encontrado: ${absoluteDb}`, 'database_not_found');
    }
    const resolveGitSha = dependencies.currentGitSha || currentGitSha;
    const digestFile = dependencies.fileSha256 || fileSha256;
    const openDatabase = dependencies.openDatabase || openReadOnlyDatabase;
    const inspect = dependencies.inspect || inspectBlankPlayerIdentities;
    const auditorSha = resolveGitSha();
    const expectedMatch = sameSha(auditorSha, options.expectedAuditorSha);
    if (options.expectedAuditorSha && expectedMatch !== true) {
        throw new BlankIdentityAuditError(
            'O SHA do auditor não corresponde ao SHA esperado.',
            'auditor_sha_mismatch',
            { auditorSha, expectedAuditorSha: options.expectedAuditorSha }
        );
    }

    const statBefore = fs.statSync(absoluteDb);
    const hashBefore = await digestFile(absoluteDb);
    const db = await openDatabase(absoluteDb);
    let result;
    try {
        result = await inspect(db);
    } finally {
        await db.close().catch(() => null);
    }
    const statAfter = fs.statSync(absoluteDb);
    const hashAfter = await digestFile(absoluteDb);
    const unchanged = hashBefore === hashAfter
        && statBefore.size === statAfter.size
        && statBefore.mtimeMs === statAfter.mtimeMs;
    if (!unchanged) {
        throw new BlankIdentityAuditError(
            'O arquivo auditado mudou durante a leitura.',
            'blank_identity_audit_database_changed',
            {
                hashBefore,
                hashAfter,
                sizeBefore: statBefore.size,
                sizeAfter: statAfter.size,
                mtimeBefore: statBefore.mtimeMs,
                mtimeAfter: statAfter.mtimeMs,
            }
        );
    }

    const report = {
        version: 'clover.blank-player-identity-audit.v1',
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: result.queryOnlySafe === true,
        database: {
            path: absoluteDb,
            sha256: hashAfter,
            sizeBytes: statAfter.size,
            unchanged: true,
        },
        auditor: {
            sha: auditorSha,
            expectedSha: options.expectedAuditorSha || null,
            expectedMatch,
        },
        result,
    };

    if (options.output) {
        const outputPath = path.resolve(options.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        report.outputPath = outputPath;
    }
    return report;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = await runAudit(options);
    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
        console.log('[blank-identities] banco preservado:', report.database.sha256);
        console.log('[blank-identities] identidades vazias:', report.result.summary.blankIdentityCount);
        console.log('[blank-identities] placeholders exatos:', report.result.summary.exactPlaceholderCount);
        console.log('[blank-identities] referências por rowid:', report.result.summary.explicitRowidReferenceCount);
        console.log('[blank-identities] referências por nome:', report.result.summary.externalNameReferenceCount);
        console.log('[blank-identities] revisão necessária:', report.result.summary.reviewRequired);
        if (report.outputPath) console.log('[blank-identities] relatório:', report.outputPath);
    }
    if (options.failOnUnsafe && report.result.summary.reviewRequired) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'blank_identity_audit_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    BlankIdentityAuditError,
    analyzeBlankRows,
    currentGitSha,
    fileSha256,
    inspectBlankPlayerIdentities,
    isPlaceholderSignature,
    openReadOnlyDatabase,
    parseArgs,
    runAudit,
    sameSha,
    unwrapDefault,
};
