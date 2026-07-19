'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATABASE_FILE = path.resolve(process.argv[2] || 'banco.sqlite');
const REPORT_ARG = process.argv[3] ? path.resolve(process.argv[3]) : null;
const OUTPUT_DIR = path.resolve(process.argv[4] || 'backups');

const REFERENCE_RULES = new Map(Object.entries({
    'jogadores.id': 'source_record',
    'jogadores.canonical_player_id': 'repoint_to_canonical',
    'player_onboarding.player_id': 'merge_or_delete_auxiliary',
    'clover_character_stats.player_id': 'merge_singleton',
    'clover_mana_hexagon.player_id': 'merge_singleton',
    'clover_site_sessions.player_id': 'repoint_session',
    'clover_ph_ledger.player_id': 'repoint_history',
    'group_member_welcomes.player_id': 'repoint_history',
    'clover_quick_evaluations.player_id': 'repoint_history',
    'clover_script_actions.player_id': 'repoint_history',
    'clover_antighost_activity.player_id': 'repoint_history',
    'clover_antighost_events.player_id': 'repoint_history',
    'clover_delivery_jobs.target_jid': 'repoint_target',
    'clover_player_aliases.alias_value': 'preserve_alias_value',
    'clover_player_aliases.player_id_destino': 'repoint_alias_target',
    'clover_player_target_aliases.alias_label': 'preserve_alias_value',
    'clover_player_target_aliases.player_id': 'repoint_alias_target',
    'player_rolls.player_id': 'repoint_owned_data',
    'clover_trait_attempts.player_id': 'repoint_owned_data',
    'clover_inventory_items.player_id': 'repoint_owned_data',
    'clover_market_listings.seller_id': 'repoint_owned_data',
    'clover_raid_participants.player_id': 'repoint_owned_data',
}));

const PASSIVE_STRATEGIES = new Set([
    'source_record',
    'preserve_alias_value',
    'merge_or_delete_auxiliary',
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

function strategyFor(table, column) {
    return REFERENCE_RULES.get(`${table}.${column}`) || 'unknown';
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
                        strategy: strategyFor(table, column.name),
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

function buildSource(sourceId, references) {
    const entries = references.get(sourceId) || [];
    return {
        sourceId,
        references: entries,
        rows: entries.reduce((sum, entry) => sum + entry.rows, 0),
        unknownReferences: entries.filter((entry) => entry.strategy === 'unknown'),
        activeMigrationReferences: entries.filter((entry) => !PASSIVE_STRATEGIES.has(entry.strategy)),
        preservedReferences: entries.filter((entry) => entry.strategy === 'preserve_alias_value'),
    };
}

function buildGroupPlan(group, references) {
    const candidates = groupCandidates(group);
    const canonicalId = group.recommendedCanonicalId || null;
    const dataOwnerId = group.recommendedDataOwnerId || canonicalId;
    const sourceIds = candidates
        .map((candidate) => candidate.id)
        .filter((id) => id && id !== canonicalId);
    const sources = sourceIds.map((sourceId) => buildSource(sourceId, references));
    const canonicalReferences = canonicalId ? (references.get(canonicalId) || []) : [];
    const hasUnknown = sources.some((source) => source.unknownReferences.length > 0);
    const hasActiveMigration = sources.some((source) => source.activeMigrationReferences.length > 0);

    let action = 'review_required';
    let readyForExecutor = false;
    let reason = 'Classificação não reconhecida.';

    if (group.classification === 'manual_merge_required') {
        action = 'blocked_manual_merge';
        reason = 'Mais de um cadastro contém dados reais. Exige regra individual de fusão.';
    } else if (group.classification === 'canonical_migration_required') {
        action = 'transactional_canonical_migration';
        readyForExecutor = !hasUnknown;
        reason = hasUnknown
            ? 'Os dados estão fora do ID canônico e existem referências sem estratégia.'
            : 'Os dados estão fora do ID canônico; todas as referências conhecidas já têm estratégia.';
    } else if (hasUnknown) {
        action = 'review_unknown_references';
        reason = 'O alias possui ao menos uma referência sem regra de migração.';
    } else if (group.classification === 'simple_alias') {
        action = hasActiveMigration
            ? 'transactional_alias_consolidation_ready'
            : 'transactional_alias_cleanup_ready';
        readyForExecutor = true;
        reason = hasActiveMigration
            ? 'O cadastro canônico já possui os dados; históricos e ponteiros devem ser reatribuídos antes da limpeza.'
            : 'O cadastro canônico já possui os dados e o alias só contém estrutura auxiliar controlada.';
    } else if (group.classification === 'empty_duplicate') {
        action = 'transactional_empty_cleanup_ready';
        readyForExecutor = true;
        reason = hasActiveMigration
            ? 'Ambos os perfis estão vazios, mas referências históricas devem ser preservadas no ID canônico.'
            : 'Ambos os perfis estão vazios e a estrutura auxiliar pode ser consolidada no ID canônico.';
    }

    return {
        phone: group.phone,
        classification: group.classification,
        canonicalId,
        dataOwnerId,
        action,
        readyForExecutor,
        reason,
        canonicalReferences,
        sources,
    };
}

function strategyCounts(groups) {
    const counts = {};
    for (const group of groups) {
        for (const source of group.sources) {
            for (const reference of source.references) {
                counts[reference.strategy] = (counts[reference.strategy] || 0) + reference.rows;
            }
        }
    }
    return counts;
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
    const referenceStrategyCounts = strategyCounts(groups);

    const plan = {
        generatedAt: new Date().toISOString(),
        database: DATABASE_FILE,
        auditReport: reportFile,
        readOnly: true,
        groupsAnalyzed: groups.length,
        readyForExecutor: groups.filter((group) => group.readyForExecutor).length,
        blockedOrUnknown: groups.filter((group) => !group.readyForExecutor).length,
        actionCounts,
        referenceStrategyCounts,
        groups,
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(OUTPUT_DIR, `identity-repair-plan-${stamp}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(plan, null, 2), 'utf8');

    console.log('\n=== PLANO DE REPARO DE IDENTIDADES — SOMENTE LEITURA ===');
    console.log(`Relatório-base: ${reportFile}`);
    console.log(`Grupos analisados: ${groups.length}`);
    console.log(`Prontos para executor transacional: ${plan.readyForExecutor}`);
    console.log(`Bloqueados ou com referência desconhecida: ${plan.blockedOrUnknown}`);
    console.log('\nAções:');
    for (const [action, total] of Object.entries(actionCounts).sort()) {
        console.log(`  ${action}: ${total}`);
    }
    console.log('\nEstratégias de referência:');
    for (const [strategy, total] of Object.entries(referenceStrategyCounts).sort()) {
        console.log(`  ${strategy}: ${total}`);
    }

    const critical = groups.filter((group) => !group.readyForExecutor);
    if (critical.length) console.log('\n=== CASOS BLOQUEADOS ===');
    for (const group of critical) {
        console.log('\n----------------------------------------');
        console.log(`Telefone: +${group.phone}`);
        console.log(`Classificação: ${group.classification}`);
        console.log(`Ação: ${group.action}`);
        console.log(`Dono dos dados: ${group.dataOwnerId}`);
        console.log(`ID canônico: ${group.canonicalId}`);
        console.log(group.reason);
        for (const source of group.sources) {
            for (const reference of source.unknownReferences) {
                console.log(`  DESCONHECIDA ${reference.table}.${reference.column}: ${reference.rows}`);
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
