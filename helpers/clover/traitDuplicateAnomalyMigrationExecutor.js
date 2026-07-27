'use strict';

const crypto = require('node:crypto');

const APPLY_CONFIRMATION = 'APPLY-DUPLICATE-ANOMALY-MIGRATION';
const UNDO_CONFIRMATION = 'UNDO-DUPLICATE-ANOMALY-MIGRATION';

class DuplicateAnomalyMigrationError extends Error {
    constructor(code, message, details = null) {
        super(message || code);
        this.name = 'DuplicateAnomalyMigrationError';
        this.code = code;
        this.details = details;
    }
}

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
}

function normalizedKey(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function semanticAudit(auditInput) {
    const audit = auditInput && typeof auditInput === 'object' ? auditInput : {};
    const targets = Array.isArray(audit.targets) ? audit.targets : [];
    return {
        readOnly: audit.readOnly === true,
        targets: targets.map((target) => ({
            templateId: target?.template?.id ?? null,
            templateName: target?.template?.name ?? null,
            proposedAction: target?.migrationAssessment?.proposedAction ?? null,
            safeCandidate: target?.migrationAssessment?.safeCandidate === true,
            fixedAssignment: target?.assignments?.[0] ? {
                assignmentId: target.assignments[0].assignmentId,
                traitId: target.assignments[0].traitId,
                slotKey: target.assignments[0].slotKey,
                valueText: target.assignments[0].valueText,
                source: target.assignments[0].source,
                legacyRef: target.assignments[0].legacyRef,
            } : null,
            sibling: target?.siblings?.[0] ? {
                template: {
                    id: target.siblings[0].template?.id,
                    name: target.siblings[0].template?.name,
                    slotKey: target.siblings[0].template?.slotKey,
                    traitKind: target.siblings[0].template?.traitKind,
                    description: target.siblings[0].template?.description,
                    effectText: target.siblings[0].template?.effectText,
                    restrictionsText: target.siblings[0].template?.restrictionsText,
                },
                assignment: target.siblings[0].assignments?.[0] ? {
                    assignmentId: target.siblings[0].assignments[0].assignmentId,
                    traitId: target.siblings[0].assignments[0].traitId,
                    slotKey: target.siblings[0].assignments[0].slotKey,
                    valueText: target.siblings[0].assignments[0].valueText,
                    source: target.siblings[0].assignments[0].source,
                    legacyRef: target.siblings[0].assignments[0].legacyRef,
                } : null,
            } : null,
        })),
    };
}

function auditHash(audit) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(stableValue(semanticAudit(audit))))
        .digest('hex');
}

function normalizeMigrationCode(value, hash) {
    const code = cleanText(value) || `TAM-${hash.slice(0, 12).toUpperCase()}`;
    if (!/^[A-Z0-9_-]{6,80}$/i.test(code)) {
        throw new DuplicateAnomalyMigrationError(
            'invalid_migration_code',
            'Código de migração inválido.',
            { code }
        );
    }
    return code.toUpperCase();
}

function ensureSupportedAudit(auditInput) {
    const audit = auditInput && typeof auditInput === 'object' ? auditInput : {};
    const targets = Array.isArray(audit.targets) ? audit.targets : [];
    if (audit.readOnly !== true || !targets.length) {
        throw new DuplicateAnomalyMigrationError(
            'unsafe_or_empty_audit',
            'A auditoria não é somente leitura ou não possui candidatos.'
        );
    }

    const fixedIds = new Set();
    const extraIds = new Set();
    targets.forEach((target, index) => {
        if (target?.migrationAssessment?.safeCandidate !== true
            || target?.migrationAssessment?.proposedAction
                !== 'copy_custom_content_to_fixed_assignment_override_and_deactivate_extra_assignment') {
            throw new DuplicateAnomalyMigrationError(
                'unsafe_migration_candidate',
                'A auditoria contém candidato não aprovado para migração automática.',
                { index }
            );
        }
        if (target?.template?.slotKey !== 'anomalia'
            || target?.template?.traitKind !== 'system'
            || cleanText(target?.template?.description)) {
            throw new DuplicateAnomalyMigrationError(
                'invalid_fixed_template',
                'O modelo fixo não corresponde a uma Anomalia global vazia.',
                { index, template: target?.template }
            );
        }
        if (!Array.isArray(target.assignments) || target.assignments.length !== 1
            || !Array.isArray(target.siblings) || target.siblings.length !== 1
            || !Array.isArray(target.siblings[0]?.assignments)
            || target.siblings[0].assignments.length !== 1) {
            throw new DuplicateAnomalyMigrationError(
                'invalid_assignment_cardinality',
                'A migração exige exatamente um vínculo fixo e um vínculo extra.',
                { index }
            );
        }
        const fixed = target.assignments[0];
        const sibling = target.siblings[0];
        const extra = sibling.assignments[0];
        if (fixed.slotKey !== 'anomalia'
            || extra.slotKey !== 'extra_anomaly'
            || sibling.template?.slotKey !== 'extra_anomaly'
            || sibling.template?.traitKind !== 'custom'
            || !cleanText(sibling.template?.description)
            || normalizedKey(target.template.name) !== normalizedKey(sibling.template.name)) {
            throw new DuplicateAnomalyMigrationError(
                'invalid_duplicate_pair',
                'Os modelos não formam uma duplicação fixa/personalizada segura.',
                { index }
            );
        }
        const fixedId = Number(fixed.assignmentId);
        const extraId = Number(extra.assignmentId);
        if (!Number.isInteger(fixedId) || !Number.isInteger(extraId)
            || fixedId <= 0 || extraId <= 0 || fixedId === extraId
            || fixedIds.has(fixedId) || extraIds.has(extraId)) {
            throw new DuplicateAnomalyMigrationError(
                'invalid_or_duplicate_assignment_id',
                'IDs de vínculo ausentes, repetidos ou inválidos.',
                { index, fixedId, extraId }
            );
        }
        fixedIds.add(fixedId);
        extraIds.add(extraId);
    });
    return { ...audit, targets };
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

async function ensureCompatibleSchema(db) {
    const templateColumns = await tableColumns(db, 'clover_trait_templates');
    for (const required of ['id', 'name', 'slot_key', 'description', 'effect_text', 'restrictions_text', 'trait_kind']) {
        if (!templateColumns.has(required)) {
            throw new DuplicateAnomalyMigrationError(
                'incompatible_trait_template_schema',
                `Coluna obrigatória ausente em clover_trait_templates: ${required}`
            );
        }
    }
    const assignmentColumns = await tableColumns(db, 'clover_player_traits');
    for (const required of [
        'id', 'player_id', 'trait_id', 'slot_key', 'value_text', 'active',
        'operation_code', 'removed_by', 'removed_at', 'metadata_json',
    ]) {
        if (!assignmentColumns.has(required)) {
            throw new DuplicateAnomalyMigrationError(
                'incompatible_trait_assignment_schema',
                `Coluna obrigatória ausente em clover_player_traits: ${required}`
            );
        }
    }
}

async function readAssignment(db, assignmentId) {
    const row = await db.get(
        `SELECT a.*, t.name AS template_name, t.slot_key AS template_slot_key,
                t.description AS template_description, t.effect_text AS template_effect_text,
                t.restrictions_text AS template_restrictions_text,
                t.trait_kind AS template_trait_kind
         FROM clover_player_traits a
         JOIN clover_trait_templates t ON t.id = a.trait_id
         WHERE a.id = ?`,
        [assignmentId]
    );
    if (!row) {
        throw new DuplicateAnomalyMigrationError(
            'assignment_not_found',
            'Vínculo de Traço não encontrado.',
            { assignmentId }
        );
    }
    return row;
}

function assignmentSnapshot(row) {
    return {
        id: Number(row.id),
        playerId: String(row.player_id),
        traitId: String(row.trait_id),
        slotKey: row.slot_key,
        valueText: row.value_text,
        active: Number(row.active),
        operationCode: row.operation_code ?? null,
        removedBy: row.removed_by ?? null,
        removedAt: row.removed_at ?? null,
        metadataJson: row.metadata_json || '{}',
    };
}

function mergedCustomContent(extraRow) {
    const metadata = parseJson(extraRow.metadata_json, {});
    const override = parseJson(metadata.traitOverride, {});
    return {
        description: cleanText(override.description) || cleanText(extraRow.template_description),
        effectText: cleanText(override.effectText) || cleanText(extraRow.template_effect_text),
        restrictionsText: cleanText(override.restrictionsText) || cleanText(extraRow.template_restrictions_text),
    };
}

function expectedAuditValue(value) {
    return cleanText(value);
}

function assertAuditAssignment(actual, expected, label) {
    if (Number(actual.id) !== Number(expected.assignmentId)
        || String(actual.trait_id) !== String(expected.traitId)
        || actual.slot_key !== expected.slotKey
        || expectedAuditValue(actual.value_text) !== expectedAuditValue(expected.valueText)
        || expectedAuditValue(actual.source) !== expectedAuditValue(expected.source)
        || expectedAuditValue(actual.legacy_ref) !== expectedAuditValue(expected.legacyRef)) {
        throw new DuplicateAnomalyMigrationError(
            'stale_duplicate_audit',
            `${label} divergiu da auditoria usada para montar a migração.`,
            { assignmentId: actual.id }
        );
    }
}

async function preflightAudit(db, auditInput) {
    const audit = ensureSupportedAudit(auditInput);
    await ensureCompatibleSchema(db);
    const units = [];
    for (const target of audit.targets) {
        const fixedAudit = target.assignments[0];
        const sibling = target.siblings[0];
        const extraAudit = sibling.assignments[0];
        const fixed = await readAssignment(db, Number(fixedAudit.assignmentId));
        const extra = await readAssignment(db, Number(extraAudit.assignmentId));
        assertAuditAssignment(fixed, fixedAudit, 'O vínculo fixo');
        assertAuditAssignment(extra, extraAudit, 'O vínculo extra');

        if (Number(fixed.active) !== 1 || Number(extra.active) !== 1
            || fixed.slot_key !== 'anomalia' || extra.slot_key !== 'extra_anomaly'
            || fixed.template_slot_key !== 'anomalia'
            || extra.template_slot_key !== 'extra_anomaly'
            || fixed.template_trait_kind !== 'system'
            || extra.template_trait_kind !== 'custom'
            || String(fixed.player_id) !== String(extra.player_id)
            || normalizedKey(fixed.template_name) !== normalizedKey(extra.template_name)
            || String(fixed.trait_id) !== String(target.template.id)
            || String(extra.trait_id) !== String(sibling.template.id)) {
            throw new DuplicateAnomalyMigrationError(
                'stale_or_unsafe_duplicate_pair',
                'A duplicação não corresponde mais ao par seguro auditado.',
                { fixedAssignmentId: fixed.id, extraAssignmentId: extra.id }
            );
        }

        const fixedMetadata = parseJson(fixed.metadata_json, {});
        const existingOverride = parseJson(fixedMetadata.traitOverride, {});
        if (Object.values(existingOverride).some((value) => cleanText(value))) {
            throw new DuplicateAnomalyMigrationError(
                'fixed_assignment_already_personalized',
                'O slot fixo recebeu uma personalização depois da auditoria.',
                { assignmentId: fixed.id }
            );
        }
        const content = mergedCustomContent(extra);
        if (!content.description) {
            throw new DuplicateAnomalyMigrationError(
                'missing_custom_description',
                'A Anomalia personalizada não possui descrição utilizável.',
                { assignmentId: extra.id }
            );
        }
        if (expectedAuditValue(content.description) !== expectedAuditValue(sibling.template.description)
            || expectedAuditValue(content.effectText) !== expectedAuditValue(sibling.template.effectText)
            || expectedAuditValue(content.restrictionsText) !== expectedAuditValue(sibling.template.restrictionsText)) {
            throw new DuplicateAnomalyMigrationError(
                'custom_content_changed_since_audit',
                'O conteúdo personalizado mudou depois da auditoria.',
                { assignmentId: extra.id }
            );
        }
        units.push({ target, sibling, fixed, extra, fixedMetadata, content });
    }
    return { audit, units };
}

function buildFixedMetadata(unit, operation) {
    return {
        ...unit.fixedMetadata,
        traitOverride: {
            description: unit.content.description,
            ...(unit.content.effectText ? { effectText: unit.content.effectText } : {}),
            ...(unit.content.restrictionsText ? { restrictionsText: unit.content.restrictionsText } : {}),
        },
        traitOverrideAudit: {
            operationCode: operation.code,
            actorId: operation.actorId,
            updatedAt: operation.timestamp,
            action: 'migrate_duplicate_anomaly',
        },
        duplicateAnomalyMigration: {
            operationCode: operation.code,
            sourceAssignmentId: Number(unit.extra.id),
            sourceTraitId: String(unit.extra.trait_id),
            migratedAt: operation.timestamp,
        },
    };
}

function afterSnapshots(unit, operation) {
    const fixedMetadata = buildFixedMetadata(unit, operation);
    return {
        fixed: {
            ...assignmentSnapshot(unit.fixed),
            metadataJson: JSON.stringify(fixedMetadata),
        },
        extra: {
            ...assignmentSnapshot(unit.extra),
            active: 0,
            operationCode: operation.code,
            removedBy: operation.actorId,
            removedAt: operation.timestamp,
        },
    };
}

async function ensureMigrationLogSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_trait_duplicate_anomaly_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            migration_code TEXT NOT NULL,
            audit_hash TEXT NOT NULL,
            fixed_assignment_id INTEGER NOT NULL,
            extra_assignment_id INTEGER NOT NULL,
            fixed_before_json TEXT NOT NULL,
            fixed_after_json TEXT NOT NULL,
            extra_before_json TEXT NOT NULL,
            extra_after_json TEXT NOT NULL,
            actor_id TEXT DEFAULT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            undone_at TEXT DEFAULT NULL,
            undo_actor_id TEXT DEFAULT NULL,
            UNIQUE (migration_code, fixed_assignment_id, extra_assignment_id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_duplicate_anomaly_migrations_code
        ON clover_trait_duplicate_anomaly_migrations (migration_code, undone_at, id)
    `);
}

async function previewMigration(db, auditInput) {
    const prepared = await preflightAudit(db, auditInput);
    return {
        mode: 'preview',
        writesPerformed: false,
        auditHash: auditHash(prepared.audit),
        migrations: prepared.units.length,
        fixedOverrides: prepared.units.length,
        extrasDeactivated: prepared.units.length,
        assignmentPairs: prepared.units.map((unit) => ({
            fixedAssignmentId: Number(unit.fixed.id),
            extraAssignmentId: Number(unit.extra.id),
            name: unit.fixed.template_name,
        })),
    };
}

async function applyMigration(db, auditInput, options = {}) {
    if (options.confirm !== APPLY_CONFIRMATION) {
        throw new DuplicateAnomalyMigrationError(
            'confirmation_required',
            `Confirmação inválida. Use ${APPLY_CONFIRMATION}.`
        );
    }
    const hash = auditHash(auditInput);
    const code = normalizeMigrationCode(options.migrationCode, hash);
    const actorId = cleanText(options.actorId) || 'local-admin';

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureMigrationLogSchema(db);
        const existing = await db.get(
            'SELECT COUNT(*) AS total FROM clover_trait_duplicate_anomaly_migrations WHERE migration_code = ?',
            [code]
        );
        if (Number(existing?.total || 0) > 0) {
            throw new DuplicateAnomalyMigrationError(
                'migration_code_already_used',
                'O código de migração já foi utilizado.',
                { migrationCode: code }
            );
        }
        const prepared = await preflightAudit(db, auditInput);
        const timestamp = new Date().toISOString();
        for (const unit of prepared.units) {
            const operation = { code, actorId, timestamp };
            const beforeFixed = assignmentSnapshot(unit.fixed);
            const beforeExtra = assignmentSnapshot(unit.extra);
            const after = afterSnapshots(unit, operation);

            const fixedResult = await db.run(
                `UPDATE clover_player_traits
                 SET metadata_json = ?
                 WHERE id = ? AND active = 1`,
                [after.fixed.metadataJson, Number(unit.fixed.id)]
            );
            const extraResult = await db.run(
                `UPDATE clover_player_traits
                 SET active = 0, operation_code = ?, removed_by = ?, removed_at = ?
                 WHERE id = ? AND active = 1`,
                [code, actorId, timestamp, Number(unit.extra.id)]
            );
            if (Number(fixedResult?.changes || 0) !== 1 || Number(extraResult?.changes || 0) !== 1) {
                throw new DuplicateAnomalyMigrationError(
                    'migration_write_conflict',
                    'Um dos vínculos mudou durante a migração.',
                    { fixedAssignmentId: unit.fixed.id, extraAssignmentId: unit.extra.id }
                );
            }
            await db.run(
                `INSERT INTO clover_trait_duplicate_anomaly_migrations
                 (migration_code, audit_hash, fixed_assignment_id, extra_assignment_id,
                  fixed_before_json, fixed_after_json, extra_before_json, extra_after_json,
                  actor_id, applied_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    code,
                    hash,
                    Number(unit.fixed.id),
                    Number(unit.extra.id),
                    JSON.stringify(beforeFixed),
                    JSON.stringify(after.fixed),
                    JSON.stringify(beforeExtra),
                    JSON.stringify(after.extra),
                    actorId,
                    timestamp,
                ]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'apply',
            writesPerformed: true,
            migrationCode: code,
            auditHash: hash,
            migrated: prepared.units.length,
            fixedOverrides: prepared.units.length,
            extrasDeactivated: prepared.units.length,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function comparableAssignment(snapshot) {
    return {
        id: Number(snapshot?.id),
        playerId: String(snapshot?.playerId ?? ''),
        traitId: String(snapshot?.traitId ?? ''),
        slotKey: snapshot?.slotKey ?? null,
        valueText: snapshot?.valueText ?? null,
        active: Number(snapshot?.active),
        operationCode: snapshot?.operationCode ?? null,
        removedBy: snapshot?.removedBy ?? null,
        removedAt: snapshot?.removedAt ?? null,
        metadata: stableValue(parseJson(snapshot?.metadataJson, {})),
    };
}

function snapshotsEqual(left, right) {
    return JSON.stringify(comparableAssignment(left)) === JSON.stringify(comparableAssignment(right));
}

async function verifyMigration(db, options = {}) {
    const code = cleanText(options.migrationCode);
    if (!code) {
        throw new DuplicateAnomalyMigrationError(
            'missing_migration_code',
            'Informe o código da migração para verificar.'
        );
    }
    await ensureMigrationLogSchema(db);
    const logs = await db.all(
        `SELECT * FROM clover_trait_duplicate_anomaly_migrations
         WHERE migration_code = ? AND undone_at IS NULL
         ORDER BY id ASC`,
        [code.toUpperCase()]
    );
    if (!logs.length) {
        throw new DuplicateAnomalyMigrationError(
            'active_migration_not_found',
            'Migração ativa não encontrada.',
            { migrationCode: code.toUpperCase() }
        );
    }
    for (const log of logs) {
        const fixed = assignmentSnapshot(await readAssignment(db, log.fixed_assignment_id));
        const extra = assignmentSnapshot(await readAssignment(db, log.extra_assignment_id));
        const expectedFixed = JSON.parse(log.fixed_after_json);
        const expectedExtra = JSON.parse(log.extra_after_json);
        if (!snapshotsEqual(fixed, expectedFixed) || !snapshotsEqual(extra, expectedExtra)) {
            throw new DuplicateAnomalyMigrationError(
                'migration_state_mismatch',
                'O estado atual não corresponde à migração aplicada.',
                { fixedAssignmentId: log.fixed_assignment_id, extraAssignmentId: log.extra_assignment_id }
            );
        }
    }
    return {
        mode: 'verify',
        writesPerformed: false,
        migrationCode: code.toUpperCase(),
        verified: logs.length,
        fixedOverrides: logs.length,
        extrasDeactivated: logs.length,
    };
}

async function undoMigration(db, options = {}) {
    if (options.confirm !== UNDO_CONFIRMATION) {
        throw new DuplicateAnomalyMigrationError(
            'confirmation_required',
            `Confirmação inválida. Use ${UNDO_CONFIRMATION}.`
        );
    }
    const code = cleanText(options.migrationCode);
    if (!code) {
        throw new DuplicateAnomalyMigrationError(
            'missing_migration_code',
            'Informe o código da migração para desfazer.'
        );
    }
    const actorId = cleanText(options.actorId) || 'local-admin';
    const normalizedCode = code.toUpperCase();

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureMigrationLogSchema(db);
        const logs = await db.all(
            `SELECT * FROM clover_trait_duplicate_anomaly_migrations
             WHERE migration_code = ? AND undone_at IS NULL
             ORDER BY id DESC`,
            [normalizedCode]
        );
        if (!logs.length) {
            throw new DuplicateAnomalyMigrationError(
                'active_migration_not_found',
                'Migração ativa não encontrada.',
                { migrationCode: normalizedCode }
            );
        }
        for (const log of logs) {
            const fixedCurrent = assignmentSnapshot(await readAssignment(db, log.fixed_assignment_id));
            const extraCurrent = assignmentSnapshot(await readAssignment(db, log.extra_assignment_id));
            const expectedFixed = JSON.parse(log.fixed_after_json);
            const expectedExtra = JSON.parse(log.extra_after_json);
            if (!snapshotsEqual(fixedCurrent, expectedFixed) || !snapshotsEqual(extraCurrent, expectedExtra)) {
                throw new DuplicateAnomalyMigrationError(
                    'migration_changed_since_apply',
                    'Os vínculos receberam alterações depois da migração e não podem ser desfeitos automaticamente.',
                    { fixedAssignmentId: log.fixed_assignment_id, extraAssignmentId: log.extra_assignment_id }
                );
            }
        }

        const timestamp = new Date().toISOString();
        for (const log of logs) {
            const fixed = JSON.parse(log.fixed_before_json);
            const extra = JSON.parse(log.extra_before_json);
            await db.run(
                `UPDATE clover_player_traits
                 SET metadata_json = ?, operation_code = ?, removed_by = ?, removed_at = ?, active = ?
                 WHERE id = ?`,
                [
                    fixed.metadataJson,
                    fixed.operationCode,
                    fixed.removedBy,
                    fixed.removedAt,
                    fixed.active,
                    fixed.id,
                ]
            );
            await db.run(
                `UPDATE clover_player_traits
                 SET metadata_json = ?, operation_code = ?, removed_by = ?, removed_at = ?, active = ?
                 WHERE id = ?`,
                [
                    extra.metadataJson,
                    extra.operationCode,
                    extra.removedBy,
                    extra.removedAt,
                    extra.active,
                    extra.id,
                ]
            );
            await db.run(
                `UPDATE clover_trait_duplicate_anomaly_migrations
                 SET undone_at = ?, undo_actor_id = ?
                 WHERE id = ?`,
                [timestamp, actorId, log.id]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'undo',
            writesPerformed: true,
            migrationCode: normalizedCode,
            restored: logs.length,
            fixedOverridesRemoved: logs.length,
            extrasReactivated: logs.length,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    DuplicateAnomalyMigrationError,
    applyMigration,
    auditHash,
    ensureSupportedAudit,
    previewMigration,
    undoMigration,
    verifyMigration,
};
