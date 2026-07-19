'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CONFIRM = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
const DATABASE_FILE = path.resolve(args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite');
const PLAN_ARG = args.find((arg) => arg.startsWith('--plan='))?.slice('--plan='.length) || null;
const OUTPUT_DIR = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');
const REQUIRED_CONFIRMATION = 'APPLY_READY_IDENTITY_REPAIRS';

const READY_ACTIONS = new Set([
    'transactional_alias_cleanup_ready',
    'transactional_alias_consolidation_ready',
    'transactional_canonical_migration',
    'transactional_empty_cleanup_ready',
]);

const PASSIVE_STRATEGIES = new Set(['source_record', 'preserve_alias_value']);

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function latestPlan(directory) {
    if (!fs.existsSync(directory)) return null;
    return fs.readdirSync(directory)
        .filter((name) => /^identity-repair-plan-.*\.json$/i.test(name))
        .map((name) => {
            const file = path.join(directory, name);
            return { file, modifiedAt: fs.statSync(file).mtimeMs };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.file || null;
}

function loadPlan() {
    const filename = PLAN_ARG ? path.resolve(PLAN_ARG) : latestPlan(OUTPUT_DIR);
    if (!filename || !fs.existsSync(filename)) {
        throw new Error('Plano não encontrado. Rode npm run plan:identity primeiro.');
    }
    const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(plan.groups) || plan.readOnly !== true) {
        throw new Error('Plano inválido ou sem marcação readOnly.');
    }
    return { filename, plan };
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

async function tableColumns(db, table) {
    return all(db, `PRAGMA table_info(${quoteIdentifier(table)})`);
}

async function countValue(db, table, column, value) {
    const row = await get(
        db,
        `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        [value]
    );
    return Number(row?.total || 0);
}

async function repoint(db, table, column, sourceId, canonicalId) {
    return run(
        db,
        `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(column)} = ?`,
        [canonicalId, sourceId]
    );
}

async function mergeSingleton(db, table, column, sourceId, canonicalId, preferSource) {
    const sourceCount = await countValue(db, table, column, sourceId);
    if (!sourceCount) return { changes: 0, mode: 'absent' };
    if (sourceCount > 1) throw new Error(`${table}.${column} não é singleton para ${sourceId}.`);

    const canonicalCount = await countValue(db, table, column, canonicalId);
    if (canonicalCount > 1) throw new Error(`${table}.${column} não é singleton para ${canonicalId}.`);

    if (!canonicalCount) {
        const result = await repoint(db, table, column, sourceId, canonicalId);
        return { changes: result.changes, mode: 'moved' };
    }

    if (preferSource) {
        await run(db, `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`, [canonicalId]);
        const result = await repoint(db, table, column, sourceId, canonicalId);
        return { changes: result.changes + 1, mode: 'source_replaced_target' };
    }

    const result = await run(db, `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`, [sourceId]);
    return { changes: result.changes, mode: 'source_discarded' };
}

async function mergeAuxiliary(db, table, column, sourceId, canonicalId) {
    const sourceCount = await countValue(db, table, column, sourceId);
    if (!sourceCount) return { changes: 0, mode: 'absent' };
    const canonicalCount = await countValue(db, table, column, canonicalId);
    if (!canonicalCount) {
        const result = await repoint(db, table, column, sourceId, canonicalId);
        return { changes: result.changes, mode: 'moved' };
    }
    const result = await run(db, `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`, [sourceId]);
    return { changes: result.changes, mode: 'duplicate_deleted' };
}

async function applyReference(db, reference, sourceId, canonicalId, preferSource) {
    const { table, column, strategy } = reference;
    if (PASSIVE_STRATEGIES.has(strategy)) return { changes: 0, mode: 'passive' };
    if (strategy === 'unknown') throw new Error(`Referência desconhecida: ${table}.${column}`);
    if (strategy === 'merge_singleton') {
        return mergeSingleton(db, table, column, sourceId, canonicalId, preferSource);
    }
    if (strategy === 'merge_or_delete_auxiliary') {
        return mergeAuxiliary(db, table, column, sourceId, canonicalId);
    }
    return repoint(db, table, column, sourceId, canonicalId);
}

async function validatePlanAgainstDatabase(db, group) {
    if (!READY_ACTIONS.has(group.action) || group.readyForExecutor !== true) {
        throw new Error(`Grupo ${group.phone} não está autorizado para execução.`);
    }
    if (!group.canonicalId || !group.dataOwnerId) {
        throw new Error(`Grupo ${group.phone} não possui IDs completos.`);
    }
    const canonicalCount = await countValue(db, 'jogadores', 'id', group.canonicalId);
    if (canonicalCount !== 1) {
        throw new Error(`ID canônico ${group.canonicalId} não existe exatamente uma vez.`);
    }
    for (const source of group.sources || []) {
        if (!source.sourceId || source.sourceId === group.canonicalId) {
            throw new Error(`Fonte inválida no grupo ${group.phone}.`);
        }
        const sourceCount = await countValue(db, 'jogadores', 'id', source.sourceId);
        if (sourceCount !== 1) {
            throw new Error(`Fonte ${source.sourceId} não existe exatamente uma vez.`);
        }
        if ((source.unknownReferences || []).length) {
            throw new Error(`Fonte ${source.sourceId} ainda possui referências desconhecidas.`);
        }
    }
}

async function applyGroup(db, group, journal) {
    await validatePlanAgainstDatabase(db, group);
    const isCanonicalMigration = group.action === 'transactional_canonical_migration';

    for (const source of group.sources || []) {
        const preferSource = isCanonicalMigration && source.sourceId === group.dataOwnerId;
        const operations = [];
        for (const reference of source.references || []) {
            if (reference.strategy === 'source_record' || reference.strategy === 'preserve_alias_value') continue;
            const result = await applyReference(
                db,
                reference,
                source.sourceId,
                group.canonicalId,
                preferSource
            );
            operations.push({ ...reference, ...result });
        }

        if (preferSource) {
            await run(db, 'DELETE FROM jogadores WHERE id = ?', [group.canonicalId]);
            await run(
                db,
                `UPDATE jogadores
                 SET id = ?, canonical_player_id = ?
                 WHERE id = ?`,
                [group.canonicalId, group.canonicalId, source.sourceId]
            );
        } else {
            await run(db, 'DELETE FROM jogadores WHERE id = ?', [source.sourceId]);
        }

        journal.push({
            phone: group.phone,
            action: group.action,
            sourceId: source.sourceId,
            canonicalId: group.canonicalId,
            preferSource,
            operations,
        });
    }
}

async function assertNoForbiddenRemnants(db, groups) {
    for (const group of groups) {
        const canonicalCount = await countValue(db, 'jogadores', 'id', group.canonicalId);
        if (canonicalCount !== 1) {
            throw new Error(`Pós-validação falhou para ${group.canonicalId}.`);
        }
        for (const source of group.sources || []) {
            const playerCount = await countValue(db, 'jogadores', 'id', source.sourceId);
            if (playerCount !== 0) throw new Error(`Cadastro fonte permaneceu: ${source.sourceId}.`);
            for (const reference of source.references || []) {
                if (reference.strategy === 'preserve_alias_value') continue;
                const remaining = await countValue(db, reference.table, reference.column, source.sourceId);
                if (remaining !== 0) {
                    throw new Error(`Referência remanescente em ${reference.table}.${reference.column}: ${source.sourceId}.`);
                }
            }
        }
    }
}

(async () => {
    if (!fs.existsSync(DATABASE_FILE)) throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    if (APPLY && CONFIRM !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }

    const { filename: planFile, plan } = loadPlan();
    const readyGroups = plan.groups.filter((group) => group.readyForExecutor === true && READY_ACTIONS.has(group.action));
    const blockedGroups = plan.groups.filter((group) => !readyGroups.includes(group));
    if (!readyGroups.length) throw new Error('O plano não possui grupos prontos para execução.');

    const db = await openDatabase(DATABASE_FILE);
    const journal = [];
    let committed = false;
    try {
        await run(db, 'PRAGMA foreign_keys = ON');
        await run(db, 'PRAGMA busy_timeout = 15000');
        await run(db, 'BEGIN IMMEDIATE');

        for (const group of readyGroups) await applyGroup(db, group, journal);
        await assertNoForbiddenRemnants(db, readyGroups);

        if (APPLY) {
            await run(db, 'COMMIT');
            committed = true;
        } else {
            await run(db, 'ROLLBACK');
        }
    } catch (error) {
        try { await run(db, 'ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        await close(db);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(OUTPUT_DIR, `identity-repair-execution-${stamp}.json`);
    fs.writeFileSync(outputFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        mode: APPLY ? 'apply' : 'dry_run',
        committed,
        database: DATABASE_FILE,
        planFile,
        readyGroups: readyGroups.length,
        blockedGroups: blockedGroups.length,
        journal,
    }, null, 2), 'utf8');

    console.log('\n=== EXECUTOR DE IDENTIDADES ===');
    console.log(`Modo: ${APPLY ? 'APLICAÇÃO' : 'SIMULAÇÃO COM ROLLBACK'}`);
    console.log(`Grupos processados: ${readyGroups.length}`);
    console.log(`Grupos bloqueados e intocados: ${blockedGroups.length}`);
    console.log(`Commit no banco: ${committed ? 'SIM' : 'NÃO'}`);
    console.log(`Relatório: ${outputFile}`);
    console.log(APPLY ? '\nReparo concluído.' : '\nSimulação concluída. Nenhum dado foi alterado.');
})().catch((error) => {
    console.error('\nFALHA NO EXECUTOR:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
