'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    auditTraitDescriptions,
    cleanText,
    normalizedKey,
} = require('../helpers/clover/traitDescriptionAuditService');
const {
    pseudonymizePlayerId,
    sanitizeTraitDescriptionAuditReport,
} = require('../helpers/clover/traitDescriptionAuditPrivacy');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function readJsonIfExists(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function looksLikeMojibake(value) {
    const text = String(value || '');
    return text.includes('\uFFFD')
        || /Ã[\u0080-\u00ff]/u.test(text)
        || /Â[\u0080-\u00ff]/u.test(text)
        || /â(?:€|™|œ|“|”|–|—|€¦)/u.test(text)
        || /ðŸ/u.test(text);
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

function selectColumn(columns, name, fallback = 'NULL') {
    return columns.has(name) ? name : `${fallback} AS ${name}`;
}

function groupDuplicates(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = normalizedKey(row.name);
        if (!key) continue;
        const current = groups.get(key) || [];
        current.push({
            id: row.id,
            name: row.name,
            slotKey: row.slot_key,
            traitKind: row.trait_kind,
            status: row.status,
        });
        groups.set(key, current);
    }
    return [...groups.entries()]
        .filter(([, entries]) => entries.length > 1)
        .map(([normalizedName, entries]) => ({ normalizedName, entries }))
        .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName, 'pt-BR'));
}

async function readActiveTraitAssignments(db) {
    const columns = await tableColumns(db, 'clover_player_traits');
    const required = ['id', 'player_id', 'trait_id'];
    if (required.some((column) => !columns.has(column))) {
        return { available: false, rows: [] };
    }

    const rows = await db.all(`
        SELECT id, player_id, trait_id,
               ${selectColumn(columns, 'slot_key')},
               ${selectColumn(columns, 'value_text')},
               ${selectColumn(columns, 'active', '1')}
        FROM clover_player_traits
        ${columns.has('active') ? 'WHERE active = 1' : ''}
        ORDER BY id ASC
    `);
    return { available: true, rows };
}

function assignmentSummary(rows) {
    return {
        activeAssignments: rows.length,
        playerKeys: [...new Set(rows.map((row) => pseudonymizePlayerId(row.player_id)).filter(Boolean))].sort(),
        slotKeys: [...new Set(rows.map((row) => cleanText(row.slot_key)).filter(Boolean))].sort(),
        valueTexts: [...new Set(rows.map((row) => cleanText(row.value_text)).filter(Boolean))].sort(),
    };
}

function buildUnmatchedSystemAssignmentAudit(templateRows, canonicalPlan, assignmentRows) {
    const unmatched = Array.isArray(canonicalPlan?.unmatched) ? canonicalPlan.unmatched : [];
    const rowById = new Map(templateRows.map((row) => [String(row.id), row]));
    const assignmentsByTrait = new Map();
    for (const assignment of assignmentRows) {
        const key = String(assignment.trait_id);
        const current = assignmentsByTrait.get(key) || [];
        current.push(assignment);
        assignmentsByTrait.set(key, current);
    }

    return unmatched
        .map((entry) => entry?.template || null)
        .filter((template) => template && template.traitKind === 'system')
        .map((template) => {
            const row = rowById.get(String(template.id));
            if (!row) return null;
            const key = normalizedKey(row.name);
            const siblings = templateRows.filter(
                (candidate) => String(candidate.id) !== String(row.id)
                    && normalizedKey(candidate.name) === key
            );
            const targetAssignments = assignmentsByTrait.get(String(row.id)) || [];
            const siblingAssignments = siblings.flatMap(
                (sibling) => assignmentsByTrait.get(String(sibling.id)) || []
            );
            const siblingPlayers = new Set(siblingAssignments.map((item) => String(item.player_id)));
            const sharedPlayerKeys = [...new Set(
                targetAssignments
                    .filter((item) => siblingPlayers.has(String(item.player_id)))
                    .map((item) => pseudonymizePlayerId(item.player_id))
                    .filter(Boolean)
            )].sort();

            return {
                template: {
                    id: row.id,
                    name: row.name,
                    slotKey: row.slot_key,
                    traitKind: row.trait_kind,
                    descriptionPresent: Boolean(cleanText(row.description)),
                },
                assignments: assignmentSummary(targetAssignments),
                siblings: siblings.map((sibling) => ({
                    id: sibling.id,
                    name: sibling.name,
                    slotKey: sibling.slot_key,
                    traitKind: sibling.trait_kind,
                    descriptionPresent: Boolean(cleanText(sibling.description)),
                    assignments: assignmentSummary(assignmentsByTrait.get(String(sibling.id)) || []),
                })),
                sharedPlayerKeys,
            };
        })
        .filter(Boolean);
}

async function main() {
    const databasePath = path.resolve(
        argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite'
    );
    const oldAuditPath = argumentValue('old-audit')
        ? path.resolve(argumentValue('old-audit'))
        : null;
    const canonicalPlanPath = argumentValue('canonical-plan')
        ? path.resolve(argumentValue('canonical-plan'))
        : null;
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join(
            'artifacts',
            'trait-description-canonical',
            'trait-description-history-diagnostic.json'
        )
    );

    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco não encontrado: ${databasePath}`);
    }

    const hashBefore = sha256File(databasePath);
    const oldAudit = readJsonIfExists(oldAuditPath);
    const canonicalPlan = readJsonIfExists(canonicalPlanPath);
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    let report;
    try {
        await db.exec('PRAGMA query_only = ON');
        const integrityRow = await db.get('PRAGMA integrity_check');
        const columns = await tableColumns(db, 'clover_trait_templates');
        const required = ['id', 'name', 'slot_key', 'description'];
        if (required.some((column) => !columns.has(column))) {
            throw new Error('Tabela clover_trait_templates incompatível com o diagnóstico.');
        }

        const rows = await db.all(`
            SELECT id, name, slot_key, description,
                   ${selectColumn(columns, 'effect_text')},
                   ${selectColumn(columns, 'restrictions_text')},
                   ${selectColumn(columns, 'status', "'active'")},
                   ${selectColumn(columns, 'trait_kind', "'system'")},
                   ${selectColumn(columns, 'canonical_key')},
                   ${selectColumn(columns, 'source')},
                   ${selectColumn(columns, 'created_at')},
                   ${selectColumn(columns, 'updated_at')}
            FROM clover_trait_templates
            ORDER BY slot_key ASC, name ASC, id ASC
        `);

        const assignmentRead = await readActiveTraitAssignments(db);
        const currentDescribed = rows.filter((row) => cleanText(row.description));
        const effectOnly = rows.filter(
            (row) => !cleanText(row.description) && cleanText(row.effect_text)
        );
        const restrictionsOnly = rows.filter(
            (row) => !cleanText(row.description) && cleanText(row.restrictions_text)
        );
        const mojibakeRows = rows.filter((row) => looksLikeMojibake(row.name));

        const oldMissingIds = new Set(
            Array.isArray(oldAudit?.templates)
                ? oldAudit.templates.map((template) => String(template.id))
                : []
        );
        const oldSummaryCompatible = Boolean(
            oldAudit?.summary
            && Number(oldAudit.summary.templatesTotal) === rows.length
            && oldMissingIds.size === Number(oldAudit.summary.templatesMissingDescription)
        );
        const historicallyDescribedAccordingToOldAudit = oldSummaryCompatible
            ? rows
                .filter((row) => !oldMissingIds.has(String(row.id)))
                .map((row) => ({
                    id: row.id,
                    name: row.name,
                    slotKey: row.slot_key,
                    traitKind: row.trait_kind,
                    currentDescription: cleanText(row.description),
                    currentEffect: cleanText(row.effect_text),
                    currentRestrictions: cleanText(row.restrictions_text),
                    source: cleanText(row.source),
                    createdAt: row.created_at || null,
                    updatedAt: row.updated_at || null,
                }))
            : [];

        const currentAudit = sanitizeTraitDescriptionAuditReport(
            await auditTraitDescriptions(db)
        );
        const unmatchedIds = new Set(
            Array.isArray(canonicalPlan?.unmatched)
                ? canonicalPlan.unmatched.map((entry) => String(entry.template?.id))
                : []
        );
        const unmatchedCandidateRecovery = Array.isArray(currentAudit?.templates)
            ? currentAudit.templates
                .filter((template) => unmatchedIds.has(String(template.id)))
                .map((template) => ({
                    id: template.id,
                    name: template.name,
                    slotKey: template.slotKey,
                    traitKind: template.traitKind,
                    candidates: template.candidates || [],
                }))
            : [];

        report = {
            generatedAt: new Date().toISOString(),
            readOnly: true,
            privacy: {
                rawPlayerIdsIncluded: false,
                playerIds: 'sha256-prefix',
            },
            database: {
                file: path.basename(databasePath),
                integrity: integrityRow?.integrity_check || null,
                sha256Before: hashBefore,
                sha256After: null,
                unchanged: null,
            },
            sources: {
                oldAuditPath,
                oldAuditFound: Boolean(oldAudit),
                oldAuditGeneratedAt: oldAudit?.generatedAt || null,
                oldAuditSummary: oldAudit?.summary || null,
                oldSummaryCompatible,
                canonicalPlanPath,
                canonicalPlanFound: Boolean(canonicalPlan),
                canonicalPlanGeneratedAt: canonicalPlan?.generatedAt || null,
                canonicalPlanSummary: canonicalPlan?.summary || null,
            },
            current: {
                templatesTotal: rows.length,
                templatesWithDescription: currentDescribed.length,
                templatesWithEffectButNoDescription: effectOnly.length,
                templatesWithRestrictionsButNoDescription: restrictionsOnly.length,
                storedNamesWithMojibakePattern: mojibakeRows.length,
                described: currentDescribed.map((row) => ({
                    id: row.id,
                    name: row.name,
                    description: cleanText(row.description),
                })),
                effectOnly: effectOnly.map((row) => ({
                    id: row.id,
                    name: row.name,
                    effect: cleanText(row.effect_text),
                })),
                restrictionsOnly: restrictionsOnly.map((row) => ({
                    id: row.id,
                    name: row.name,
                    restrictions: cleanText(row.restrictions_text),
                })),
                mojibakeRows: mojibakeRows.map((row) => ({ id: row.id, name: row.name })),
            },
            assignments: {
                available: assignmentRead.available,
                activeRows: assignmentRead.rows.length,
                unmatchedSystemTemplates: buildUnmatchedSystemAssignmentAudit(
                    rows,
                    canonicalPlan,
                    assignmentRead.rows
                ),
            },
            comparison: {
                historicallyDescribedAccordingToOldAudit,
                duplicateNormalizedNames: groupDuplicates(rows),
                unmatchedCandidateRecovery,
            },
        };
    } finally {
        await db.close();
    }

    const hashAfter = sha256File(databasePath);
    report.database.sha256After = hashAfter;
    report.database.unchanged = hashBefore === hashAfter;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('Diagnóstico histórico de descrições concluído em modo somente leitura.');
    console.log(`Banco íntegro: ${report.database.integrity}`);
    console.log(`Banco permaneceu igual: ${report.database.unchanged}`);
    console.log(`Descritos atualmente: ${report.current.templatesWithDescription}`);
    console.log(`Descritos segundo a auditoria antiga: ${report.comparison.historicallyDescribedAccordingToOldAudit.length}`);
    console.log(`Nomes armazenados com padrão de mojibake: ${report.current.storedNamesWithMojibakePattern}`);
    console.log(`Atribuições ativas lidas: ${report.assignments.activeRows}`);
    console.log(`Não correspondidos com alguma fonte candidata: ${report.comparison.unmatchedCandidateRecovery.filter((item) => item.candidates.length).length}`);
    console.log(`Relatório: ${outputPath}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Falha no diagnóstico histórico de descrições:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    looksLikeMojibake,
};
