'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const SOURCE_ID = '559391047134@s.whatsapp.net';
const TARGET_ID = '225769720701008@lid';
const EXPECTED_NAME = 'Aylin Seraphin Veil.';
const REQUIRED_CONFIRMATION = 'MIGRATE_AYLIN_CANONICAL_IDENTITY';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CONFIRM = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
const DATABASE_FILE = path.resolve(args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite');
const OUTPUT_DIR = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');

const PRESERVE_SOURCE_VALUES = new Set([
    'clover_player_aliases.alias_value',
    'clover_player_target_aliases.alias_label',
]);

const ALLOWED_TARGET_CONTEXT = new Set([
    'jogadores.canonical_player_id',
    'clover_antighost_events.group_id',
    'clover_antighost_messages.participant_id',
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

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, (error) => {
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

async function discoverReferences(db) {
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
            const sourceRows = await countExact(db, table, column.name, SOURCE_ID);
            const targetRows = await countExact(db, table, column.name, TARGET_ID);
            if (!sourceRows && !targetRows) continue;
            const key = `${table}.${column.name}`;
            references.push({
                table,
                column: column.name,
                key,
                sourceRows,
                targetRows,
                preserveSource: PRESERVE_SOURCE_VALUES.has(key),
                allowedTargetContext: ALLOWED_TARGET_CONTEXT.has(key),
            });
        }
    }
    return references;
}

function validateInputs() {
    if (!fs.existsSync(DATABASE_FILE)) throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    if (APPLY && CONFIRM !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }
}

async function validatePlayer(db) {
    const source = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [SOURCE_ID]);
    const target = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [TARGET_ID]);
    if (!source) throw new Error(`Cadastro de origem não existe: ${SOURCE_ID}`);
    if (target) throw new Error(`O destino já possui cadastro em jogadores: ${TARGET_ID}`);

    const foundName = playerName(source);
    if (normalizeText(foundName) !== normalizeText(EXPECTED_NAME)) {
        throw new Error(`Personagem inesperado. Encontrado: ${foundName || 'sem nome'}`);
    }
    return { foundName };
}

function validateTargetReferences(references) {
    const conflicts = references.filter((reference) => (
        reference.targetRows > 0 && !reference.allowedTargetContext
    ));
    if (!conflicts.length) return;

    const detail = conflicts
        .map((item) => `${item.key}=${item.targetRows}`)
        .join(', ');
    throw new Error(`O LID de destino possui dados reais e exige fusão manual: ${detail}`);
}

async function createBackup(db) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await run(db, 'PRAGMA wal_checkpoint(FULL)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(OUTPUT_DIR, `before-aylin-identity-${stamp}.sqlite`);
    fs.copyFileSync(DATABASE_FILE, backupFile);
    return backupFile;
}

async function assertIntegrity(db) {
    const foreignKeyFailures = await all(db, 'PRAGMA foreign_key_check');
    if (foreignKeyFailures.length) {
        throw new Error(`foreign_key_check encontrou ${foreignKeyFailures.length} falha(s).`);
    }

    const integrityRows = await all(db, 'PRAGMA integrity_check');
    const failures = integrityRows
        .flatMap((row) => Object.values(row))
        .filter((value) => String(value).toLowerCase() !== 'ok');
    if (failures.length) throw new Error(`integrity_check falhou: ${failures.join('; ')}`);
}

async function migrate(db, references) {
    const operations = [];
    await run(db, 'PRAGMA foreign_keys = OFF');
    await run(db, 'PRAGMA busy_timeout = 15000');
    await run(db, 'BEGIN IMMEDIATE');

    try {
        for (const reference of references) {
            if (!reference.sourceRows || reference.preserveSource) continue;
            if (reference.key === 'jogadores.id') continue;

            const result = await run(
                db,
                `UPDATE ${quoteIdentifier(reference.table)}
                 SET ${quoteIdentifier(reference.column)} = ?
                 WHERE CAST(${quoteIdentifier(reference.column)} AS TEXT) = ?`,
                [TARGET_ID, SOURCE_ID]
            );
            if (result.changes !== reference.sourceRows) {
                throw new Error(`Contagem inesperada em ${reference.key}: ${result.changes}/${reference.sourceRows}`);
            }
            operations.push({ key: reference.key, expected: reference.sourceRows, changed: result.changes });
        }

        const moved = await run(
            db,
            `UPDATE jogadores
             SET id = ?, canonical_player_id = ?
             WHERE id = ?`,
            [TARGET_ID, TARGET_ID, SOURCE_ID]
        );
        if (moved.changes !== 1) throw new Error('Falha ao promover Aylin para o LID canônico.');
        operations.push({ key: 'jogadores.id', expected: 1, changed: 1 });

        const after = await discoverReferences(db);
        const remnants = after.filter((reference) => reference.sourceRows > 0 && !reference.preserveSource);
        if (remnants.length) {
            throw new Error(`Referências antigas permaneceram: ${remnants.map((item) => item.key).join(', ')}`);
        }

        const canonical = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [TARGET_ID]);
        if (!canonical || normalizeText(playerName(canonical)) !== normalizeText(EXPECTED_NAME)) {
            throw new Error('Pós-validação não encontrou Aylin no LID canônico.');
        }

        await assertIntegrity(db);
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
    const db = await openDatabase(DATABASE_FILE);
    let backupFile = null;

    try {
        const { foundName } = await validatePlayer(db);
        const references = await discoverReferences(db);
        validateTargetReferences(references);

        const mutable = references.filter((item) => item.sourceRows > 0 && !item.preserveSource);
        const preserved = references.filter((item) => item.sourceRows > 0 && item.preserveSource);
        const context = references.filter((item) => item.targetRows > 0 && item.allowedTargetContext);

        console.log('\n=== MIGRAÇÃO CANÔNICA DA AYLIN ===');
        console.log(`Modo: ${APPLY ? 'APLICAÇÃO' : 'SIMULAÇÃO COM ROLLBACK'}`);
        console.log(`Personagem: ${foundName}`);
        console.log(`Origem: ${SOURCE_ID}`);
        console.log(`Destino: ${TARGET_ID}`);
        console.log(`Referências a mover: ${mutable.reduce((sum, item) => sum + item.sourceRows, 0)}`);
        console.log(`Campos envolvidos: ${mutable.length}`);
        console.log(`Aliases preservados: ${preserved.reduce((sum, item) => sum + item.sourceRows, 0)}`);
        console.log(`Contextos preexistentes aceitos: ${context.map((item) => `${item.key}=${item.targetRows}`).join(', ') || 'nenhum'}`);

        if (APPLY) backupFile = await createBackup(db);
        const result = await migrate(db, references);

        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportFile = path.join(OUTPUT_DIR, `aylin-identity-migration-${stamp}.json`);
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
            ? '\nMigração da Aylin concluída e validada.'
            : '\nSimulação concluída. Nenhum dado foi alterado.');
    } finally {
        await close(db);
    }
})().catch((error) => {
    console.error('\nFALHA NA MIGRAÇÃO DA AYLIN:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
