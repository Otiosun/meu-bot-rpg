'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CONFIRM = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
const DATABASE_FILE = path.resolve(args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite');
const PLAN_ARG = args.find((arg) => arg.startsWith('--plan='))?.slice('--plan='.length) || null;
const OUTPUT_DIR = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');
const REQUIRED_CONFIRMATION = 'APPLY_SEVEN_IDENTITY_REPAIRS';
const OPERATION_CODE = `IM-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const PASSIVE_STRATEGIES = new Set(['source_record', 'preserve_alias_value']);
const TECHNICAL_COLUMN = /^(?:__rowid__|rowid|id)$/i;
const TEMPORAL_COLUMN = /(?:^|_)(?:created|updated|sent|seen|processed|completed|confirmed|released|expired|deleted|welcomed|greeted|last)_at$/i;
const GENERIC_NAMES = new Set(['', '-', 'cacador', 'caçador', 'jogador', 'player', 'hunter']);

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function latestPlan(directory) {
    if (!fs.existsSync(directory)) return null;
    return fs.readdirSync(directory)
        .filter((name) => /^identity-seven-repair-plan-.*\.json$/i.test(name))
        .map((name) => ({
            file: path.join(directory, name),
            modifiedAt: fs.statSync(path.join(directory, name)).mtimeMs,
        }))
        .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.file || null;
}

function loadPlan() {
    const filename = PLAN_ARG ? path.resolve(PLAN_ARG) : latestPlan(OUTPUT_DIR);
    if (!filename || !fs.existsSync(filename)) {
        throw new Error('Plano dos sete casos não encontrado. Rode npm run plan:identity:seven primeiro.');
    }
    const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (plan.readOnly !== true || plan.targetedRepair !== 'seven_special_identity_cases') {
        throw new Error('Plano inválido: este executor aceita apenas o plano dirigido dos sete casos.');
    }
    if (!Array.isArray(plan.groups) || plan.groups.length !== 7) {
        throw new Error(`Plano inválido: esperados 7 grupos, encontrados ${plan.groups?.length || 0}.`);
    }
    if (plan.groups.some((group) => group.readyForExecutor !== true || group.targetedIdentityRepair !== true)) {
        throw new Error('Plano contém grupo não autorizado para a execução dirigida.');
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

function hasValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function profileValueIsBlank(column, value) {
    if (!hasValue(value) || String(value).trim() === '-') return true;
    if (['nome', 'display_name', 'nome_real', 'personagem_nome'].includes(column)) {
        return GENERIC_NAMES.has(String(value).trim().toLowerCase());
    }
    return false;
}

function valuesEqual(left, right) {
    if (left === right) return true;
    if (!hasValue(left) && !hasValue(right)) return true;
    if (typeof left === 'number' && typeof right === 'number') return Number(left) === Number(right);
    return false;
}

async function uniqueIndexesContaining(db, table, targetColumn) {
    const indexes = await all(db, `PRAGMA index_list(${quoteIdentifier(table)})`);
    const result = [];

    for (const index of indexes) {
        if (Number(index.unique) !== 1) continue;
        const columns = (await all(db, `PRAGMA index_info(${quoteIdentifier(index.name)})`))
            .sort((left, right) => Number(left.seqno) - Number(right.seqno))
            .map((entry) => entry.name)
            .filter(Boolean);
        if (!columns.includes(targetColumn)) continue;

        const partial = Number(index.partial || 0) === 1;
        let whereSql = null;
        if (partial) {
            const schema = await get(db, `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, [index.name]);
            const match = /\bWHERE\b([\s\S]+)$/i.exec(String(schema?.sql || ''));
            whereSql = match?.[1]?.trim() || null;
            if (!whereSql) throw new Error(`Não foi possível ler a condição do índice parcial ${index.name}.`);
        }
        result.push({ name: index.name, columns, partial, whereSql });
    }

    return result;
}

function buildCollisionPredicate(indexColumns, sourceRow, targetColumn, canonicalId) {
    const clauses = [];
    const params = [];
    for (const column of indexColumns) {
        const value = column === targetColumn ? canonicalId : sourceRow[column];
        if (value === null || value === undefined) return null;
        clauses.push(`${quoteIdentifier(column)} = ?`);
        params.push(value);
    }
    return { clauses, params };
}

async function sourceQualifiesForIndex(db, table, sourceRow, index) {
    if (!index.partial) return true;
    const row = await get(
        db,
        `SELECT CASE WHEN (${index.whereSql}) THEN 1 ELSE 0 END AS qualifies
         FROM ${quoteIdentifier(table)} WHERE rowid = ?`,
        [sourceRow.__rowid__]
    );
    return Number(row?.qualifies || 0) === 1;
}

async function findCollision(db, table, targetColumn, sourceRow, canonicalId, indexes) {
    const matches = new Map();
    for (const index of indexes) {
        if (!(await sourceQualifiesForIndex(db, table, sourceRow, index))) continue;
        const predicate = buildCollisionPredicate(index.columns, sourceRow, targetColumn, canonicalId);
        if (!predicate) continue;
        const partialClause = index.partial ? ` AND (${index.whereSql})` : '';
        const row = await get(
            db,
            `SELECT rowid AS __rowid__, * FROM ${quoteIdentifier(table)}
             WHERE ${predicate.clauses.join(' AND ')}${partialClause} LIMIT 1`,
            predicate.params
        );
        if (row) matches.set(String(row.__rowid__), { row, index });
    }
    if (matches.size > 1) {
        throw new Error(`Colisão ambígua em ${table}.${targetColumn}: mais de um destino canônico.`);
    }
    return matches.size ? [...matches.values()][0] : null;
}

function ignoredSemanticColumn(column, primaryKeys, targetColumn) {
    return column === targetColumn
        || primaryKeys.has(column)
        || TECHNICAL_COLUMN.test(column)
        || TEMPORAL_COLUMN.test(column);
}

async function mergeCollisionByOwner(db, table, targetColumn, sourceRow, canonicalRow, canonicalId, preferSource, indexColumns) {
    const columns = await tableColumns(db, table);
    const primaryKeys = new Set(columns.filter((column) => Number(column.pk) > 0).map((column) => column.name));
    const winner = preferSource ? sourceRow : canonicalRow;
    const loser = preferSource ? canonicalRow : sourceRow;
    const updates = {};
    const conflicts = [];

    for (const column of columns.map((entry) => entry.name)) {
        if (ignoredSemanticColumn(column, primaryKeys, targetColumn)) continue;
        const winnerValue = winner[column];
        const loserValue = loser[column];
        if (!hasValue(winnerValue) && hasValue(loserValue)) {
            updates[column] = loserValue;
        } else if (hasValue(winnerValue) && hasValue(loserValue) && !valuesEqual(winnerValue, loserValue)) {
            conflicts.push({ column, kept: winnerValue, archived: loserValue });
        }
    }

    if (preferSource) {
        await run(db, `DELETE FROM ${quoteIdentifier(table)} WHERE rowid = ?`, [canonicalRow.__rowid__]);
        const entries = Object.entries(updates);
        const assignments = [`${quoteIdentifier(targetColumn)} = ?`, ...entries.map(([column]) => `${quoteIdentifier(column)} = ?`)];
        await run(
            db,
            `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE rowid = ?`,
            [canonicalId, ...entries.map(([, value]) => value), sourceRow.__rowid__]
        );
    } else {
        const entries = Object.entries(updates);
        if (entries.length) {
            await run(
                db,
                `UPDATE ${quoteIdentifier(table)} SET ${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE rowid = ?`,
                [...entries.map(([, value]) => value), canonicalRow.__rowid__]
            );
        }
        await run(db, `DELETE FROM ${quoteIdentifier(table)} WHERE rowid = ?`, [sourceRow.__rowid__]);
    }

    return {
        mode: preferSource ? 'source_won_unique_collision' : 'canonical_won_unique_collision',
        moved: preferSource ? 1 : 0,
        deduplicated: 1,
        mergedFields: Object.keys(updates).length,
        conflicts,
        indexColumns,
    };
}

async function repointCollisionAware(db, table, column, sourceId, canonicalId, preferSource) {
    const indexes = await uniqueIndexesContaining(db, table, column);
    if (!indexes.length) {
        const result = await run(
            db,
            `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(column)} = ?`,
            [canonicalId, sourceId]
        );
        return { mode: 'direct_repoint', moved: result.changes, deduplicated: 0, mergedFields: 0, conflicts: [] };
    }

    const sourceRows = await all(
        db,
        `SELECT rowid AS __rowid__, * FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(column)} = ? ORDER BY rowid ASC`,
        [sourceId]
    );

    const summary = { mode: 'collision_aware_repoint', moved: 0, deduplicated: 0, mergedFields: 0, conflicts: [] };
    for (const sourceRow of sourceRows) {
        const collision = await findCollision(db, table, column, sourceRow, canonicalId, indexes);
        if (!collision) {
            const result = await run(
                db,
                `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`,
                [canonicalId, sourceRow.__rowid__]
            );
            summary.moved += result.changes;
            continue;
        }
        const result = await mergeCollisionByOwner(
            db,
            table,
            column,
            sourceRow,
            collision.row,
            canonicalId,
            preferSource,
            collision.index.columns
        );
        summary.moved += result.moved;
        summary.deduplicated += result.deduplicated;
        summary.mergedFields += result.mergedFields;
        summary.conflicts.push(...result.conflicts.map((conflict) => ({ ...conflict, index: collision.index.name })));
    }
    return summary;
}

async function mergeSingleton(db, table, column, sourceId, canonicalId, preferSource) {
    const sourceRows = await all(
        db,
        `SELECT rowid AS __rowid__, * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        [sourceId]
    );
    const canonicalRows = await all(
        db,
        `SELECT rowid AS __rowid__, * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        [canonicalId]
    );
    if (sourceRows.length > 1 || canonicalRows.length > 1) {
        throw new Error(`${table}.${column} deixou de ser singleton.`);
    }
    if (!sourceRows.length) return { mode: 'absent', moved: 0, deduplicated: 0, mergedFields: 0, conflicts: [] };
    if (!canonicalRows.length) return repointCollisionAware(db, table, column, sourceId, canonicalId, preferSource);
    return mergeCollisionByOwner(db, table, column, sourceRows[0], canonicalRows[0], canonicalId, preferSource, [column]);
}

async function mergeAuxiliary(db, table, column, sourceId, canonicalId, preferSource) {
    const sourceRows = await all(
        db,
        `SELECT rowid AS __rowid__, * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        [sourceId]
    );
    if (!sourceRows.length) return { mode: 'absent', moved: 0, deduplicated: 0, mergedFields: 0, conflicts: [] };
    const canonicalRows = await all(
        db,
        `SELECT rowid AS __rowid__, * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        [canonicalId]
    );
    if (!canonicalRows.length) return repointCollisionAware(db, table, column, sourceId, canonicalId, preferSource);
    if (sourceRows.length !== 1 || canonicalRows.length !== 1) {
        throw new Error(`${table}.${column} possui duplicidade auxiliar ambígua.`);
    }
    return mergeCollisionByOwner(db, table, column, sourceRows[0], canonicalRows[0], canonicalId, preferSource, [column]);
}

async function applyReference(db, reference, sourceId, canonicalId, preferSource) {
    if (PASSIVE_STRATEGIES.has(reference.strategy)) return { mode: 'passive', moved: 0, deduplicated: 0, mergedFields: 0, conflicts: [] };
    if (reference.strategy === 'unknown') throw new Error(`Referência desconhecida: ${reference.table}.${reference.column}`);
    if (reference.strategy === 'merge_singleton') {
        return mergeSingleton(db, reference.table, reference.column, sourceId, canonicalId, preferSource);
    }
    if (reference.strategy === 'merge_or_delete_auxiliary') {
        return mergeAuxiliary(db, reference.table, reference.column, sourceId, canonicalId, preferSource);
    }
    return repointCollisionAware(db, reference.table, reference.column, sourceId, canonicalId, preferSource);
}

async function mergePlayerProfiles(db, ownerId, secondaryId) {
    const owner = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [ownerId]);
    const secondary = await get(db, 'SELECT * FROM jogadores WHERE id = ?', [secondaryId]);
    if (!owner || !secondary) throw new Error(`Não foi possível comparar os perfis ${ownerId} e ${secondaryId}.`);

    const columns = await tableColumns(db, 'jogadores');
    const updates = {};
    const conflicts = [];
    for (const column of columns.map((entry) => entry.name)) {
        if (['id', 'canonical_player_id', 'merged_into'].includes(column) || TEMPORAL_COLUMN.test(column)) continue;
        const ownerValue = owner[column];
        const secondaryValue = secondary[column];
        if (profileValueIsBlank(column, ownerValue) && !profileValueIsBlank(column, secondaryValue)) {
            updates[column] = secondaryValue;
        } else if (!profileValueIsBlank(column, ownerValue)
            && !profileValueIsBlank(column, secondaryValue)
            && !valuesEqual(ownerValue, secondaryValue)) {
            conflicts.push({ column, kept: ownerValue, archived: secondaryValue });
        }
    }

    const entries = Object.entries(updates);
    if (entries.length) {
        await run(
            db,
            `UPDATE jogadores SET ${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE id = ?`,
            [...entries.map(([, value]) => value), ownerId]
        );
    }
    return { ownerId, secondaryId, filledFields: Object.keys(updates), conflicts };
}

async function validateGroup(db, group) {
    if (!['transactional_manual_merge', 'transactional_canonical_migration'].includes(group.action)) {
        throw new Error(`Ação não autorizada para ${group.phone}: ${group.action}`);
    }
    if (!group.canonicalId || !group.dataOwnerId || group.sources?.length !== 1) {
        throw new Error(`Grupo ${group.phone} não possui a estrutura esperada de dois cadastros.`);
    }
    const sourceId = group.sources[0].sourceId;
    if (![sourceId, group.canonicalId].includes(group.dataOwnerId)) {
        throw new Error(`Dono dos dados fora do par de identidades em ${group.phone}.`);
    }
    if (await countValue(db, 'jogadores', 'id', sourceId) !== 1) {
        throw new Error(`Fonte ${sourceId} não existe exatamente uma vez.`);
    }
    if (await countValue(db, 'jogadores', 'id', group.canonicalId) !== 1) {
        throw new Error(`Canônico ${group.canonicalId} não existe exatamente uma vez.`);
    }
    if ((group.sources[0].unknownReferences || []).length) {
        throw new Error(`Grupo ${group.phone} ainda possui referência desconhecida.`);
    }
}

async function finalizeCanonicalPlayer(db, canonicalId) {
    const columns = new Set((await tableColumns(db, 'jogadores')).map((column) => column.name));
    const assignments = [];
    const params = [];
    if (columns.has('canonical_player_id')) {
        assignments.push('canonical_player_id = ?');
        params.push(canonicalId);
    }
    if (columns.has('merged_into')) assignments.push('merged_into = NULL');
    if (assignments.length) {
        await run(db, `UPDATE jogadores SET ${assignments.join(', ')} WHERE id = ?`, [...params, canonicalId]);
    }
}

async function applyGroup(db, group) {
    await validateGroup(db, group);
    const source = group.sources[0];
    const sourceId = source.sourceId;
    const canonicalId = group.canonicalId;
    const preferSource = sourceId === group.dataOwnerId;
    const secondaryId = preferSource ? canonicalId : sourceId;
    const profileMerge = await mergePlayerProfiles(db, group.dataOwnerId, secondaryId);
    const operations = [];

    for (const reference of source.references || []) {
        if (PASSIVE_STRATEGIES.has(reference.strategy)) continue;
        const result = await applyReference(db, reference, sourceId, canonicalId, preferSource);
        operations.push({ ...reference, ...result });
    }

    if (preferSource) {
        await run(db, 'DELETE FROM jogadores WHERE id = ?', [canonicalId]);
        const moved = await run(
            db,
            'UPDATE jogadores SET id = ?, canonical_player_id = ? WHERE id = ?',
            [canonicalId, canonicalId, sourceId]
        );
        if (moved.changes !== 1) throw new Error(`Falha ao promover ${sourceId} para ${canonicalId}.`);
    } else {
        const deleted = await run(db, 'DELETE FROM jogadores WHERE id = ?', [sourceId]);
        if (deleted.changes !== 1) throw new Error(`Falha ao remover o cadastro secundário ${sourceId}.`);
    }

    await finalizeCanonicalPlayer(db, canonicalId);
    return {
        phone: group.phone,
        label: group.label || null,
        action: group.action,
        sourceId,
        canonicalId,
        dataOwnerId: group.dataOwnerId,
        preferSource,
        profileMerge,
        operations,
    };
}

async function assertNoRemnants(db, groups) {
    for (const group of groups) {
        const source = group.sources[0];
        if (await countValue(db, 'jogadores', 'id', source.sourceId) !== 0) {
            throw new Error(`Cadastro fonte permaneceu: ${source.sourceId}.`);
        }
        if (await countValue(db, 'jogadores', 'id', group.canonicalId) !== 1) {
            throw new Error(`Cadastro canônico inválido: ${group.canonicalId}.`);
        }
        for (const reference of source.references || []) {
            if (reference.strategy === 'preserve_alias_value') continue;
            const remaining = await countValue(db, reference.table, reference.column, source.sourceId);
            if (remaining !== 0) {
                throw new Error(`Referência remanescente em ${reference.table}.${reference.column}: ${source.sourceId}.`);
            }
        }
        const selfMerge = await get(db, 'SELECT merged_into FROM jogadores WHERE id = ?', [group.canonicalId]);
        if (selfMerge?.merged_into === group.canonicalId) {
            throw new Error(`Autorreferência merged_into em ${group.canonicalId}.`);
        }
    }
}

async function assertIntegrity(db) {
    const foreignKeys = await all(db, 'PRAGMA foreign_key_check');
    if (foreignKeys.length) throw new Error(`PRAGMA foreign_key_check encontrou ${foreignKeys.length} falhas.`);
    const integrity = await all(db, 'PRAGMA integrity_check');
    const failures = integrity.flatMap((row) => Object.values(row)).filter((value) => String(value).toLowerCase() !== 'ok');
    if (failures.length) throw new Error(`PRAGMA integrity_check falhou: ${failures.join('; ')}`);
}

async function writeAuditEvent(db, planFile, journal) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS clover_identity_merge_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_code TEXT NOT NULL UNIQUE,
            plan_file TEXT NOT NULL,
            group_count INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await run(
        db,
        `INSERT INTO clover_identity_merge_events
         (operation_code, plan_file, group_count, payload_json)
         VALUES (?, ?, ?, ?)`,
        [OPERATION_CODE, planFile, journal.length, JSON.stringify(journal)]
    );
}

(async () => {
    if (!fs.existsSync(DATABASE_FILE)) throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    if (APPLY && CONFIRM !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }

    const { filename: planFile, plan } = loadPlan();
    const db = await openDatabase(DATABASE_FILE);
    const journal = [];
    let committed = false;

    try {
        await run(db, 'PRAGMA foreign_keys = ON');
        await run(db, 'PRAGMA busy_timeout = 15000');
        await run(db, 'BEGIN IMMEDIATE');

        for (const group of plan.groups) journal.push(await applyGroup(db, group));
        await assertNoRemnants(db, plan.groups);
        await assertIntegrity(db);
        if (APPLY) await writeAuditEvent(db, planFile, journal);

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
    const outputFile = path.join(OUTPUT_DIR, `identity-seven-execution-${stamp}.json`);
    fs.writeFileSync(outputFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        operationCode: OPERATION_CODE,
        mode: APPLY ? 'apply' : 'dry_run',
        committed,
        database: DATABASE_FILE,
        planFile,
        groupsProcessed: journal.length,
        journal,
    }, null, 2), 'utf8');

    console.log('\n=== REPARO DOS SETE CASOS ESPECIAIS ===');
    console.log(`Modo: ${APPLY ? 'APLICAÇÃO' : 'SIMULAÇÃO COM ROLLBACK'}`);
    console.log(`Casos processados: ${journal.length}`);
    console.log(`Commit no banco: ${committed ? 'SIM' : 'NÃO'}`);
    if (APPLY) console.log(`Código da operação: ${OPERATION_CODE}`);
    console.log(`Relatório: ${outputFile}`);
    console.log(APPLY
        ? '\nSete identidades consolidadas no ID canônico.'
        : '\nSimulação concluída. Nenhum dado foi alterado.');
})().catch((error) => {
    console.error('\nFALHA NO REPARO DOS SETE CASOS:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
