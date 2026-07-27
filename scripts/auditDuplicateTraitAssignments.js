'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    normalizedKey,
} = require('../helpers/clover/traitDescriptionAuditService');
const {
    pseudonymizePlayerId,
} = require('../helpers/clover/traitDescriptionAuditPrivacy');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function requiredArgument(name) {
    const value = argumentValue(name);
    if (!value) throw new Error(`Argumento obrigatório ausente: --${name}=...`);
    return value;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

function selected(columns, name, fallback = 'NULL') {
    return columns.has(name) ? name : `${fallback} AS ${name}`;
}

function assignmentSnapshot(row) {
    const metadata = parseJson(row.metadata_json, {});
    const override = metadata.traitOverride && typeof metadata.traitOverride === 'object'
        ? metadata.traitOverride
        : {};
    return {
        assignmentId: row.id,
        playerKey: pseudonymizePlayerId(row.player_id),
        traitId: row.trait_id,
        slotKey: row.slot_key,
        valueText: row.value_text,
        position: row.position === null || row.position === undefined ? null : Number(row.position),
        operationCode: row.operation_code || null,
        assignedBy: row.assigned_by ? pseudonymizePlayerId(row.assigned_by) : null,
        assignedAt: row.assigned_at || null,
        source: row.source || null,
        legacyRef: row.legacy_ref || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        metadataKeys: Object.keys(metadata).sort(),
        override: {
            name: override.name || null,
            description: override.description || null,
            effectText: override.effectText || null,
            restrictionsText: override.restrictionsText || null,
        },
    };
}

async function main() {
    const databasePath = path.resolve(requiredArgument('db'));
    const planPath = path.resolve(requiredArgument('plan'));
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'trait-description-canonical', 'duplicate-trait-assignment-audit.json')
    );

    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);
    if (!fs.existsSync(planPath)) throw new Error(`Plano não encontrado: ${planPath}`);

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const unmatchedSystemIds = new Set(
        (Array.isArray(plan.unmatched) ? plan.unmatched : [])
            .map((entry) => entry?.template)
            .filter((template) => template?.traitKind === 'system')
            .map((template) => String(template.id))
    );

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        const integrity = await db.get('PRAGMA integrity_check');
        const templateRows = await db.all(`
            SELECT id, name, slot_key, description, effect_text, restrictions_text,
                   trait_kind, status, canonical_key, source
            FROM clover_trait_templates
            ORDER BY id ASC
        `);
        const assignmentColumns = await tableColumns(db, 'clover_player_traits');
        const assignmentRows = await db.all(`
            SELECT id, player_id, trait_id,
                   ${selected(assignmentColumns, 'slot_key')},
                   ${selected(assignmentColumns, 'value_text')},
                   ${selected(assignmentColumns, 'position')},
                   ${selected(assignmentColumns, 'operation_code')},
                   ${selected(assignmentColumns, 'assigned_by')},
                   ${selected(assignmentColumns, 'assigned_at')},
                   ${selected(assignmentColumns, 'source')},
                   ${selected(assignmentColumns, 'legacy_ref')},
                   ${selected(assignmentColumns, 'metadata_json', "'{}'")},
                   ${selected(assignmentColumns, 'created_at')},
                   ${selected(assignmentColumns, 'updated_at')},
                   ${selected(assignmentColumns, 'active', '1')}
            FROM clover_player_traits
            ${assignmentColumns.has('active') ? 'WHERE active = 1' : ''}
            ORDER BY id ASC
        `);

        const byTrait = new Map();
        for (const row of assignmentRows) {
            const key = String(row.trait_id);
            const current = byTrait.get(key) || [];
            current.push(row);
            byTrait.set(key, current);
        }

        const targets = templateRows
            .filter((template) => unmatchedSystemIds.has(String(template.id)))
            .map((template) => {
                const siblings = templateRows.filter(
                    (candidate) => String(candidate.id) !== String(template.id)
                        && normalizedKey(candidate.name) === normalizedKey(template.name)
                );
                const targetAssignments = byTrait.get(String(template.id)) || [];
                const siblingEntries = siblings.map((sibling) => ({
                    template: {
                        id: sibling.id,
                        name: sibling.name,
                        slotKey: sibling.slot_key,
                        traitKind: sibling.trait_kind,
                        description: sibling.description || null,
                        effectText: sibling.effect_text || null,
                        restrictionsText: sibling.restrictions_text || null,
                        source: sibling.source || null,
                    },
                    assignments: (byTrait.get(String(sibling.id)) || []).map(assignmentSnapshot),
                }));
                const targetPlayerKeys = new Set(targetAssignments.map((row) => pseudonymizePlayerId(row.player_id)));
                const siblingPlayerKeys = new Set(
                    siblingEntries.flatMap((entry) => entry.assignments.map((assignment) => assignment.playerKey))
                );
                const sharedPlayerKeys = [...targetPlayerKeys]
                    .filter((key) => siblingPlayerKeys.has(key))
                    .sort();
                const migrationCandidate = targetAssignments.length === 1
                    && siblingEntries.length === 1
                    && siblingEntries[0].assignments.length === 1
                    && sharedPlayerKeys.length === 1
                    && template.slot_key === 'anomalia'
                    && siblingEntries[0].template.slotKey === 'extra_anomaly'
                    && siblingEntries[0].template.traitKind === 'custom'
                    && Boolean(siblingEntries[0].template.description);

                return {
                    template: {
                        id: template.id,
                        name: template.name,
                        slotKey: template.slot_key,
                        traitKind: template.trait_kind,
                        description: template.description || null,
                        source: template.source || null,
                    },
                    assignments: targetAssignments.map(assignmentSnapshot),
                    siblings: siblingEntries,
                    sharedPlayerKeys,
                    migrationAssessment: {
                        safeCandidate: migrationCandidate,
                        proposedAction: migrationCandidate
                            ? 'copy_custom_content_to_fixed_assignment_override_and_deactivate_extra_assignment'
                            : 'manual_review',
                    },
                };
            });

        const report = {
            generatedAt: new Date().toISOString(),
            readOnly: true,
            privacy: {
                rawPlayerIdsIncluded: false,
                playerIds: 'sha256-prefix',
            },
            database: {
                file: path.basename(databasePath),
                integrity: integrity?.integrity_check || null,
            },
            summary: {
                unmatchedSystemTemplates: targets.length,
                safeMigrationCandidates: targets.filter((item) => item.migrationAssessment.safeCandidate).length,
            },
            targets,
        };

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log('Auditoria detalhada de atribuições duplicadas concluída.');
        console.log(`Integridade: ${report.database.integrity}`);
        console.log(`Modelos globais: ${report.summary.unmatchedSystemTemplates}`);
        console.log(`Candidatos seguros de migração: ${report.summary.safeMigrationCandidates}`);
        console.log(`Relatório: ${outputPath}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
