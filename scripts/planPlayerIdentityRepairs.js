'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATABASE_FILE = path.resolve(process.argv[2] || 'banco.sqlite');
const REPORT_ARG = process.argv[3] ? path.resolve(process.argv[3]) : null;
const OUTPUT_DIR = path.resolve(process.argv[4] || 'backups');

const SUPPORT_TABLES = new Set([
    'jogadores',
    'clover_character_stats',
    'clover_site_sessions',
    'player_onboarding',
]);

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function openReadOnly(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, (error) => {
            if (error) reject(error);
            else resolve(db);
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

function latestAuditReport(directory) {
    if (!fs.existsSync(directory)) return null;
    const candidates = fs.readdirSync(directory)
        .filter((name) => /^identity-alias-audit-.*\.json$/i.test(name))
        .map((name) => {
            const file = path.join(directory, name);
            return { file, modifiedAt: fs.statSync(file).mtimeMs };
        })
        .sort((left, right) => right.modifiedAt - left.modifiedAt);
    return candidates[0]?.file || null;
}

function loadAuditReport() {
    const reportFile = REPORT_ARG || latestAuditReport(OUTPUT_DIR);
    if (!reportFile || !fs.existsSync(reportFile)) {
        throw new Error('Relatório de auditoria não encontrado. Rode npm run audit:identity primeiro.');
    }
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (!Array.isArray(report.groups)) {
        throw new Error('O relatório informado não possui a lista groups.');
    }
    return { reportFile, report };
}

function isScannableColumn(column) {
    const type = String(column?.type || '').trim().toUpperCase();
    if (!type) return true;
    return !/(BLOB|REAL|FLOA|DOUB|INT|NUM|DEC|BOOL|DATE|TIME)/.test(type);
}

function chunks(values, size = 150) {
    const output = [];
    for (let index = 0; index < values.length; index += size) {
        output.push(values.slice(index, index + size));
    }
    return output;
}

async function discoverReferences(db, ids) {
    const references = new Map(ids.map((id) => [id, []]));
    const tables = await all(
        db,
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
    );

    for (const tableRow of tables) {
        const table = tableRow.name;
        const columns = await all(db, `PRAGMA table_info(${quoteIdentifier(table)})`);
        for (const column of columns.filter(isScannableColumn)) {
            for (const idChunk of chunks(ids)) {
                const placeholders = idChunk.map(() => '?').join(', ');
                const sql = `SELECT CAST(${quoteIdentifier(column.name)} AS TEXT) AS matched_id,
                                    COUNT(*) AS total
                             FROM ${quoteIdentifier(table)}
                             WHERE CAST(${quoteIdentifier(column.name)} AS TEXT) IN (${placeholders})
                             GROUP BY CAST(${quoteIdentifier(column.name)} AS TEXT)`;
                const matches = await all(db, sql, idChunk);
                for (const match of matches) {
                    if (!references.has(match.matched_id)) continue;
                    references.get(match.matched_id).push({
                        table,
                        column: column.name,
                        rows: Number(match.total || 0),
                        supportOnly: SUPPORT_TABLES.has(table),
                    });
                }
            }
        }
    }

    return references;
}

function groupCandidates(group) {
    return Array.isArray(group?.candidates) ? group.candidates : [];
}

function referencesOutsideSupport(entries) {
    return entries.filter((entry) => !entry.supportOnly);
}

function buildGroupPlan(group, references) {
    const candidates = groupCandidates(group);
    const canonicalId = group.recommendedCanonicalId || null;
    const dataOwnerId = group.recommendedDataOwnerId || canonicalId;
    const sourceIds = candidates
        .map((candidate) => candidate.id)
        .filter((id) => id && id !== canonicalId);

    const sources = sourceIds.map((sourceId) => {
        const allReferences = references.get(sourceId) || [];
        return {
            sourceId,
            references: allReferences,
            rows: allReferences.reduce((sum, entry) => sum + entry.rows, 0),
            unexpectedReferences: referencesOutsideSupport(allReferences),
        };
    });

    const canonicalReferences = canonicalId ? (references.get(canonicalId) || []) : [];
    const hasUnexpectedSourceReferences = sources.some((source) => source.unexpectedReferences.length > 0);

    let action = 'review_required';
    let automatic = false;
    let reason = 'Classificação não reconhecida.';

    if (group.classification === 'manual_merge_required') {
        action = 'blocked_manual_merge';
        reason = 'Mais de um cadastro contém dados reais. Não existe limpeza automática segura.';
    } else if (group.classification === 'canonical_migration_required') {
        action = 'transactional_migration_required';
        reason = 'Os dados reais estão fora do ID canônico e precisam ser migrados com tratamento de colisões.';
    } else if (group.classification === 'simple_alias') {
        if (hasUnexpectedSourceReferences) {
            action = 'review_unexpected_references';
            reason = 'O alias contém referências fora das tabelas auxiliares conhecidas.';
        } else {
            action = 'safe_alias_cleanup_candidate';
            automatic = true;
            reason = 'O ID canônico já é dono dos dados e os aliases só possuem linhas auxiliares.';
        }
    } else if (group.classification === 'empty_duplicate') {
        if (hasUnexpectedSourceReferences) {
            action = 'review_unexpected_references';
            reason = 'Uma duplicata marcada como vazia possui referências fora das tabelas auxiliares.';
        } else {
            action = 'safe_empty_cleanup_candidate';
            automatic = true;
            reason = 'Nenhum cadastro possui dados reais; o ID não canônico só tem linhas auxiliares.';
        }
    }

    return {
        phone: group.phone,
        classification: group.classification,
        canonicalId,
        dataOwnerId,
        action,
        automatic,
        reason,
        canonicalReferences,
        sources,
    };
}

(async () => {
    if (!fs.existsSync(DATABASE_FILE)) {
        throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    }

    const { reportFile, report } = loadAuditReport();
    const ids = [...new Set(
        report.groups.flatMap((group) => groupCandidates(group).map((candidate) => candidate.id)).filter(Boolean)
    )];

    const db = await openReadOnly(DATABASE_FILE);
    let references;
    try {
        references = await discoverReferences(db, ids);
    } finally {
        await close(db);
    }

    const groups = report.groups.map((group) => buildGroupPlan(group, references));
    const actionCounts = groups.reduce((counts, group) => {
        counts[group.action] = (counts[group.action] || 0) + 1;
        return counts;
    }, {});

    const plan = {
        generatedAt: new Date().toISOString(),
        database: DATABASE_FILE,
        auditReport: reportFile,
        readOnly: true,
        groupsAnalyzed: groups.length,
        actionCounts,
        groups,
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(OUTPUT_DIR, `identity-repair-plan-${stamp}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(plan, null, 2), 'utf8');

    console.log('\n=== PLANO DE REPARO DE IDENTIDADES — SOMENTE LEITURA ===');
    console.log(`Relatório-base: ${reportFile}`);
    console.log(`Grupos analisados: ${groups.length}`);
    for (const [action, total] of Object.entries(actionCounts).sort()) {
        console.log(`${action}: ${total}`);
    }

    const critical = groups.filter((group) => !group.automatic);
    console.log(`Casos que exigem revisão: ${critical.length}`);
    for (const group of critical) {
        console.log('\n----------------------------------------');
        console.log(`Telefone: +${group.phone}`);
        console.log(`Classificação: ${group.classification}`);
        console.log(`Ação: ${group.action}`);
        console.log(`Dono dos dados: ${group.dataOwnerId}`);
        console.log(`ID canônico: ${group.canonicalId}`);
        console.log(group.reason);
        for (const source of group.sources) {
            if (!source.references.length) continue;
            console.log(`  Fonte ${source.sourceId}:`);
            for (const reference of source.references) {
                console.log(`    ${reference.table}.${reference.column}: ${reference.rows}`);
            }
        }
    }

    console.log('\nPlano salvo em:');
    console.log(outputFile);
    console.log('\nNenhum dado foi alterado.');
})().catch((error) => {
    console.error('\nFALHA NO PLANEJAMENTO:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
