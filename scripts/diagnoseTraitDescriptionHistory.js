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

    try {
        await db.exec('PRAGMA query_only = ON');
        const integrityRow = await db.get('PRAGMA integrity_check');
        const columnRows = await db.all('PRAGMA table_info(clover_trait_templates)');
        const columns = new Set(columnRows.map((row) => row.name));
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

        const currentDescribed = rows.filter((row) => cleanText(row.description));
        const effectOnly = rows.filter(
            (row) => !cleanText(row.description) && cleanText(row.effect_text)
        );
        const restrictionsOnly = rows.filter(
            (row) => !cleanText(row.description) && cleanText(row.restrictions_text)
        );
        const mojibakeRows = rows.filter((row) => /(?:Ã.|Â.|â.|ð.)/.test(String(row.name || '')));

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

        const report = {
            generatedAt: new Date().toISOString(),
            readOnly: true,
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
            comparison: {
                historicallyDescribedAccordingToOldAudit,
                duplicateNormalizedNames: groupDuplicates(rows),
                unmatchedCandidateRecovery,
            },
        };

        await db.close();
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
        console.log(`Não correspondidos com alguma fonte candidata: ${report.comparison.unmatchedCandidateRecovery.filter((item) => item.candidates.length).length}`);
        console.log(`Relatório: ${outputPath}`);
    } catch (error) {
        await db.close().catch(() => null);
        throw error;
    }
}

main().catch((error) => {
    console.error('Falha no diagnóstico histórico de descrições:', error);
    process.exitCode = 1;
});
