'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const args = process.argv.slice(2);
const SOURCE_ID = args.find((arg) => arg.startsWith('--source='))?.slice('--source='.length) || '';
const TARGET_ID = args.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) || '';
const EXPECT_NAME = args.find((arg) => arg.startsWith('--expect-name='))?.slice('--expect-name='.length) || '';
const DATABASE_FILE = path.resolve(args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite');
const OUTPUT_DIR = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');
const APPLY = args.includes('--apply');
const CONFIRM = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
const REQUIRED_CONFIRMATION = 'MIGRATE_SINGLE_PLAYER_IDENTITY';

const PRESERVE_SOURCE_VALUES = new Set([
    'clover_player_aliases.alias_value',
    'clover_player_target_aliases.alias_label',
]);

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '';
}

function openDatabase(filename, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, mode, (error) => {
            if (error) reject(error);
            else resolve(db);
        });
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function callback(error) {
            if (error) reject(error);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function close(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

function isScannableColumn(column) {
    const type = String(column?.type || '').trim().toUpperCase();
    if (!type) return true;
    return !/(BLOB|REAL|FLOA|DOUB|INT|NUM|DEC|BOOL|DATE|TIME)/.test(type);
}

async function countExact(db, table, column, value) {
    const row = await get(
        db,
        `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)} WHERE CAST(${quoteIdentifier(column)} AS TEXT) = ?`,
        [value]
    );
    return Number(row?.total || 0);
}

async function discoverReferences(db, sourceId, targetId) {
    const tables = await all(
        db,
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
    );
    const references = [];

    for (const { name: table } of tables) {
        const columns = await all(db, `PRAGMA table_info(${quoteIdentifier(table)})`);
        for (const column of columns.filter(isScannableColumn)) {
            const sourceRows = await countExact(db, table, column.name, sourceId);
            const targetRows = await countExact(db, table, column.name, targetId);
            if (!sourceRows && !targetRows) continue;
            const key = `${table}.${column.name}`;
            references.push({
                table,
                column: column.name,
                sourceRows,
                targetRows,
                preserveSource: PRESERVE_SOURCE_VALUES.has(key),
                primaryKey: Number(column.pk || 0) > 0,
            });
        }
    }

    return references;
}

function validateInputs() {
    if (!SOURCE_ID || !TARGET_ID) {
        throw new Error('Informe --source=<jid-antigo> e --target=<jid-canonico>.');
    }
    if (SOURCE_ID === TARGET_ID) throw new Error('Origem e destino são iguais.');
    if (!SOURCE_ID.includes('@') || !TARGET_ID.includes('@')) {
        throw new Error('Origem e destino precisam ser JIDs completos.');
    }
    if (!fs.existsSync(DATABASE_FILE)) throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    if (APPLY && CONFIRM !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }
}

async function validatePlayerRows(db) {
    const source = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [SOURCE_ID]);
    const target = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [TARGET_ID]);
    if (!source) throw new Error(`Cadastro de origem não existe: ${SOURCE_ID}`);
    if (target) throw new Error(`O destino já possui cadastro em jogadores: ${TARGET_ID}`);

    const foundName = playerName(source);
    if (EXPECT_NAME && normalizeText(foundName) !== normalizeText(EXPECT_NAME)) {
        throw new Error(`Personagem inesperado. Encontrado: ${foundName || 'sem nome'}`);
    }
    return { source, foundName };
}

function validateNoTargetData(references) {
    const conflicts = references.filter((reference) => (
        reference.targetRows > 0
        && !(reference.table === 'jogadores' && reference.column === 'canonical_player_id')
    ));
    if (conflicts.length) {
        const detail = conflicts
            .map((item) => `${item.table}.${item.column}=${item.targetRows}`)
            .join(', ');
        throw new Error(`O destino já possui referências e exige fusão manual: ${detail}`);
    }
}

async function createBackup(db) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await run(db, 'PRAGMA wal_checkpoint(FULL)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(OUTPUT_DIR, `before-single-identity-${stamp}.sqlite`);
    fs.copyFileSync(DATABASE_FILE, backupFile);
    return backupFile;
}

async function applyMigration(db, references) {
    const operations = [];
    await run(db, 'PRAGMA foreign_keys = OFF');
    await run(db, 'PRAGMA busy_timeout = 15000');
    await run(db, 'BEGIN IMMEDIATE');

    try {
        for (const reference of references) {
            if (!reference.sourceRows || reference.preserveSource) continue;
            if (reference.table === 'jogadores' && reference.column === 'id') continue;

            const result = await run(
                db,
                `UPDATE ${quoteIdentifier(reference.table)}
                 SET ${quoteIdentifier(reference.column)} = ?
                 WHERE CAST(${quoteIdentifier(reference.column)} AS TEXT) = ?`,
                [TARGET_ID, SOURCE_ID]
            );
            operations.push({
                table: reference.table,
                column: reference.column,
                expected: reference.sourceRows,
                changed: result.changes,
            });
            if (result.changes !== reference.sourceRows) {
                throw new Error(
                    `Contagem inesperada em ${reference.table}.${reference.column}: ` +
                    `${result.changes}/${reference.sourceRows}`
                );
            }
        }

        const playerMove = await run(
            db,
            `UPDATE jogadores
             SET id = ?, canonical_player_id = ?
             WHERE id = ?`,
            [TARGET_ID, TARGET_ID, SOURCE_ID]
        );
        if (playerMove.changes !== 1) throw new Error('Falha ao promover o cadastro para o LID canônico.');
        operations.push({ table: 'jogadores', column: 'id', expected: 1, changed: 1 });

        const sourceRemnants = await discoverReferences(db, SOURCE_ID, TARGET_ID);
        const forbidden = sourceRemnants.filter((reference) => (
            reference.sourceRows > 0 && !reference.preserveSource
        ));
        if (forbidden.length) {
            throw new Error(
                `Referências antigas permaneceram: ${forbidden.map((item) => `${item.table}.${item.column}`).join(', ')}`
            );
        }

        const canonical = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [TARGET_ID]);
        if (!canonical) throw new Error('Pós-validação não encontrou o cadastro canônico.');

        const foreignKeyFailures = await all(db, 'PRAGMA foreign_key_check');
        if (foreignKeyFailures.length) {
            throw new Error(`foreign_key_check encontrou ${foreignKeyFailures.length} falha(s).`);
        }

        const integrityRows = await all(db, 'PRAGMA integrity_check');
        const integrityFailures = integrityRows
            .flatMap((row) => Object.values(row))
            .filter((value) => String(value).toLowerCase() !== 'ok');
        if (integrityFailures.length) {
            throw new Error(`integrity_check falhou: ${integrityFailures.join('; ')}`);
        }

        if (APPLY) await run(db, 'COMMIT');
        else await run(db, 'ROLLBACK');

        return { operations, committed: APPLY };
    } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await run(db, 'PRAGMA foreign_keys = ON').catch(() => {});
    }
}

(async () => {
    validateInputs();
    const mode = APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READWRITE;
    const db = await openDatabase(DATABASE_FILE, mode);
    let backupFile = null;

    try {
        const { source, foundName } = await validatePlayerRows(db);
        const references = await discoverReferences(db, SOURCE_ID, TARGET_ID);
        validateNoTargetData(references);

        const mutableReferences = references.filter((item) => item.sourceRows > 0 && !item.preserveSource);
        const preservedReferences = references.filter((item) => item.sourceRows > 0 && item.preserveSource);

        console.log('\n=== MIGRAÇÃO CANÔNICA UNITÁRIA ===');
        console.log(`Modo: ${APPLY ? 'APLICAÇÃO' : 'SIMULAÇÃO COM ROLLBACK'}`);
        console.log(`Personagem: ${foundName || source.personagem_nome || SOURCE_ID}`);
        console.log(`Origem: ${SOURCE_ID}`);
        console.log(`Destino: ${TARGET_ID}`);
        console.log(`Referências a mover: ${mutableReferences.reduce((sum, item) => sum + item.sourceRows, 0)}`);
        console.log(`Campos envolvidos: ${mutableReferences.length}`);
        console.log(`Aliases preservados: ${preservedReferences.reduce((sum, item) => sum + item.sourceRows, 0)}`);

        if (APPLY) backupFile = await createBackup(db);
        const result = await applyMigration(db, references);

        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportFile = path.join(OUTPUT_DIR, `single-identity-migration-${stamp}.json`);
        fs.writeFileSync(reportFile, JSON.stringify({
            generatedAt: new Date().toISOString(),
            mode: APPLY ? 'apply' : 'dry_run',
            committed: result.committed,
            database: DATABASE_FILE,
            backupFile,
            sourceId: SOURCE_ID,
            targetId: TARGET_ID,
            characterName: foundName,
            references,
            operations: result.operations,
        }, null, 2), 'utf8');

        console.log(`Backup: ${backupFile || 'não criado na simulação'}`);
        console.log(`Relatório: ${reportFile}`);
        console.log(result.committed
            ? '\nMigração concluída e validada.'
            : '\nSimulação concluída. Nenhum dado foi alterado.');
    } finally {
        await close(db);
    }
})().catch((error) => {
    console.error('\nFALHA NA MIGRAÇÃO CANÔNICA:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
