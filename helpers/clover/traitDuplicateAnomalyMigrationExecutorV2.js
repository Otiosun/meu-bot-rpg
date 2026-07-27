'use strict';

const {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    DuplicateAnomalyMigrationError,
    auditHash,
    ensureSupportedAudit,
} = require('./traitDuplicateAnomalyMigrationExecutor');

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
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

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

async function ensureCompatibleSchema(db) {
    const templateColumns = await tableColumns(db, 'clover_trait_templates');
    for (const required of [
        'id', 'name', 'slot_key', 'description', 'effect_text',
        'restrictions_text', 'trait_kind',
    ]) {
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
        'source', 'legacy_ref',
    ]) {
        if (!assignmentColumns.has(required)) {
            throw new DuplicateAnomalyMigrationError(
                'incompatible_trait_assignment_schema',
                `Coluna obrigatória ausente em clover_player_traits: ${required}`
            );
        }
    }
    const playerColumns = await tableColumns(db, 'jogadores');
    for (const required of ['id', 'historias_extras']) {
        if (!playerColumns.has(required)) {
            throw new DuplicateAnomalyMigrationError(
                'incompatible_player_schema',
                `Coluna obrigatória ausente em jogadores: ${required}`
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

async function readPlayer(db, playerId) {
    const row = await db.get(
        'SELECT id, historias_extras FROM jogadores WHERE id = ?',
        [playerId]
    );
    if (!row) {
        throw new DuplicateAnomalyMigrationError(
            'player_not_found',
            'Jogador da duplicação não foi encontrado.',
            { playerId }
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

function playerSnapshot(row) {
    return {
        id: String(row.id),
        historiasExtrasRaw: row.historias_extras ?? null,
    };
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

function assignmentEqual(left, right) {
    return JSON.stringify(comparableAssignment(left))
        === JSON.stringify(comparableAssignment(right));
}

function playerEqual(left, right) {
    return String(left?.id ?? '') === String(right?.id ?? '')
        && (left?.historiasExtrasRaw ?? null) === (right?.historiasExtrasRaw ?? null);
}

function mergedCustomContent(extraRow) {
    const metadata = parseJson(extraRow.metadata_json, {});
    const override = parseJson(metadata.traitOverride, {});
    return {
        description: cleanText(override.description) || cleanText(extraRow.template_description),
        effectText: cleanText(override.effectText) || cleanText(extraRow.template_effect_text),
        restrictionsText: cleanText(override.restrictionsText)
            || cleanText(extraRow.template_restrictions_text),
    };
}

function assertAuditAssignment(actual, expected, label) {
    if (Number(actual.id) !== Number(expected.assignmentId)
        || String(actual.trait_id) !== String(expected.traitId)
        || actual.slot_key !== expected.slotKey
        || cleanText(actual.value_text) !== cleanText(expected.valueText)
        || cleanText(actual.source) !== cleanText(expected.source)
        || cleanText(actual.legacy_ref) !== cleanText(expected.legacyRef)) {
        throw new DuplicateAnomalyMigrationError(
            'stale_duplicate_audit',
            `${label} divergiu da auditoria usada para montar a migração.`,
            { assignmentId: actual.id }
        );
    }
}

function legacyIndex(legacyRef) {
    const match = /^jogadores\.historias_extras\[(\d+)\]$/.exec(String(legacyRef || ''));
    return match ? Number(match[1]) : null;
}

function legacyEntryTitle(entry) {
    return cleanText(entry?.title ?? entry?.name ?? entry?.nome);
}

function legacyEntryDescription(entry) {
    return cleanText(entry?.description ?? entry?.descricao);
}

function prepareLegacyRemoval(player, extra, content) {
    const entries = parseJson(player.historias_extras, null);
    if (!Array.isArray(entries)) {
        throw new DuplicateAnomalyMigrationError(
            'invalid_legacy_extra_history',
            'O histórico legado de extras não é uma lista JSON válida.',
            { playerId: player.id }
        );
    }
    const index = legacyIndex(extra.legacy_ref);
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        throw new DuplicateAnomalyMigrationError(
            'legacy_extra_index_not_found',
            'A referência legada da Anomalia Extra não aponta para uma entrada válida.',
            { playerId: player.id, legacyRef: extra.legacy_ref }
        );
    }
    const entry = entries[index];
    if (normalizedKey(legacyEntryTitle(entry)) !== normalizedKey(extra.template_name)
        || legacyEntryDescription(entry) !== content.description) {
        throw new DuplicateAnomalyMigrationError(
            'legacy_extra_changed_since_audit',
            'A entrada em historias_extras não corresponde mais à Anomalia auditada.',
            { playerId: player.id, index }
        );
    }
    const afterEntries = entries.filter((_, currentIndex) => currentIndex !== index);
    return {
        index,
        entry,
        beforeRaw: player.historias_extras,
        afterRaw: JSON.stringify(afterEntries),
    };
}

async function preflightAudit(db, auditInput) {
    const audit = ensureSupportedAudit(auditInput);
    await ensureCompatibleSchema(db);
    const units = [];
    const playerIds = new Set();

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
            || cleanText(fixed.template_description)
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

        if (playerIds.has(String(fixed.player_id))) {
            throw new DuplicateAnomalyMigrationError(
                'multiple_migrations_for_same_player',
                'Mais de uma migração do mesmo jogador exige revisão manual.',
                { playerId: fixed.player_id }
            );
        }
        playerIds.add(String(fixed.player_id));

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
        if (!content.description
            || content.description !== cleanText(sibling.template.description)
            || content.effectText !== cleanText(sibling.template.effectText)
            || content.restrictionsText !== cleanText(sibling.template.restrictionsText)) {
            throw new DuplicateAnomalyMigrationError(
                'custom_content_changed_since_audit',
                'O conteúdo personalizado mudou depois da auditoria.',
                { assignmentId: extra.id }
            );
        }

        const player = await readPlayer(db, fixed.player_id);
        const legacy = prepareLegacyRemoval(player, extra, content);
        units.push({ fixed, extra, fixedMetadata, content, player, legacy });
    }
    return { audit, units };
}

function buildFixedMetadata(unit, operation) {
    return {
        ...unit.fixedMetadata,
        traitOverride: {
            description: unit.content.description,
            ...(unit.content.effectText ? { effectText: unit.content.effectText } : {}),
            ...(unit.content.restrictionsText
                ? { restrictionsText: unit.content.restrictionsText }
                : {}),
        },
        traitOverrideAudit: {
            operationCode: operation.code,
            actorId: operation.actorId,
            updatedAt: operation.timestamp,
            action: 'migrate_duplicate_anomaly',
        },
        duplicateAnomalyMigration: {
            version: 2,
            operationCode: operation.code,
            sourceAssignmentId: Number(unit.extra.id),
            sourceTraitId: String(unit.extra.trait_id),
            legacyIndex: unit.legacy.index,
            migratedAt: operation.timestamp,
        },
    };
}

function afterSnapshots(unit, operation) {
    return {
        fixed: {
            ...assignmentSnapshot(unit.fixed),
            metadataJson: JSON.stringify(buildFixedMetadata(unit, operation)),
        },
        extra: {
            ...assignmentSnapshot(unit.extra),
            active: 0,
            operationCode: operation.code,
            removedBy: operation.actorId,
            removedAt: operation.timestamp,
        },
        player: {
            id: String(unit.player.id),
            historiasExtrasRaw: unit.legacy.afterRaw,
        },
    };
}

async function ensureMigrationLogSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_trait_duplicate_anomaly_migrations_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            migration_code TEXT NOT NULL,
            audit_hash TEXT NOT NULL,
            fixed_assignment_id INTEGER NOT NULL,
            extra_assignment_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            fixed_before_json TEXT NOT NULL,
            fixed_after_json TEXT NOT NULL,
            extra_before_json TEXT NOT NULL,
            extra_after_json TEXT NOT NULL,
            player_before_json TEXT NOT NULL,
            player_after_json TEXT NOT NULL,
            actor_id TEXT DEFAULT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            undone_at TEXT DEFAULT NULL,
            undo_actor_id TEXT DEFAULT NULL,
            UNIQUE (migration_code, fixed_assignment_id, extra_assignment_id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_duplicate_anomaly_migrations_v2_code
        ON clover_trait_duplicate_anomaly_migrations_v2 (migration_code, undone_at, id)
    `);
}

async function previewMigration(db, auditInput) {
    const prepared = await preflightAudit(db, auditInput);
    return {
        mode: 'preview',
        writesPerformed: false,
        executorVersion: 2,
        auditHash: auditHash(prepared.audit),
        migrations: prepared.units.length,
        fixedOverrides: prepared.units.length,
        extrasDeactivated: prepared.units.length,
        legacyEntriesRemoved: prepared.units.length,
        assignmentPairs: prepared.units.map((unit) => ({
            fixedAssignmentId: Number(unit.fixed.id),
            extraAssignmentId: Number(unit.extra.id),
            name: unit.fixed.template_name,
            legacyIndex: unit.legacy.index,
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
            `SELECT COUNT(*) AS total
             FROM clover_trait_duplicate_anomaly_migrations_v2
             WHERE migration_code = ?`,
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
            const beforePlayer = playerSnapshot(unit.player);
            const after = afterSnapshots(unit, operation);

            const fixedResult = await db.run(
                `UPDATE clover_player_traits SET metadata_json = ?
                 WHERE id = ? AND active = 1`,
                [after.fixed.metadataJson, Number(unit.fixed.id)]
            );
            const extraResult = await db.run(
                `UPDATE clover_player_traits
                 SET active = 0, operation_code = ?, removed_by = ?, removed_at = ?
                 WHERE id = ? AND active = 1`,
                [code, actorId, timestamp, Number(unit.extra.id)]
            );
            const playerResult = await db.run(
                `UPDATE jogadores SET historias_extras = ?
                 WHERE id = ? AND historias_extras = ?`,
                [after.player.historiasExtrasRaw, unit.player.id, beforePlayer.historiasExtrasRaw]
            );
            if (Number(fixedResult?.changes || 0) !== 1
                || Number(extraResult?.changes || 0) !== 1
                || Number(playerResult?.changes || 0) !== 1) {
                throw new DuplicateAnomalyMigrationError(
                    'migration_write_conflict',
                    'Um dos registros mudou durante a migração.',
                    { fixedAssignmentId: unit.fixed.id, extraAssignmentId: unit.extra.id }
                );
            }

            await db.run(
                `INSERT INTO clover_trait_duplicate_anomaly_migrations_v2
                 (migration_code, audit_hash, fixed_assignment_id, extra_assignment_id,
                  player_id, fixed_before_json, fixed_after_json, extra_before_json,
                  extra_after_json, player_before_json, player_after_json, actor_id, applied_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    code,
                    hash,
                    Number(unit.fixed.id),
                    Number(unit.extra.id),
                    String(unit.player.id),
                    JSON.stringify(beforeFixed),
                    JSON.stringify(after.fixed),
                    JSON.stringify(beforeExtra),
                    JSON.stringify(after.extra),
                    JSON.stringify(beforePlayer),
                    JSON.stringify(after.player),
                    actorId,
                    timestamp,
                ]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'apply',
            writesPerformed: true,
            executorVersion: 2,
            migrationCode: code,
            auditHash: hash,
            migrated: prepared.units.length,
            fixedOverrides: prepared.units.length,
            extrasDeactivated: prepared.units.length,
            legacyEntriesRemoved: prepared.units.length,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function activeLogs(db, code) {
    await ensureMigrationLogSchema(db);
    return db.all(
        `SELECT * FROM clover_trait_duplicate_anomaly_migrations_v2
         WHERE migration_code = ? AND undone_at IS NULL
         ORDER BY id ASC`,
        [code]
    );
}

async function verifyMigration(db, options = {}) {
    const code = cleanText(options.migrationCode);
    if (!code) {
        throw new DuplicateAnomalyMigrationError(
            'missing_migration_code',
            'Informe o código da migração para verificar.'
        );
    }
    const normalizedCode = code.toUpperCase();
    const logs = await activeLogs(db, normalizedCode);
    if (!logs.length) {
        throw new DuplicateAnomalyMigrationError(
            'active_migration_not_found',
            'Migração ativa não encontrada.',
            { migrationCode: normalizedCode }
        );
    }
    for (const log of logs) {
        const fixed = assignmentSnapshot(await readAssignment(db, log.fixed_assignment_id));
        const extra = assignmentSnapshot(await readAssignment(db, log.extra_assignment_id));
        const player = playerSnapshot(await readPlayer(db, log.player_id));
        if (!assignmentEqual(fixed, JSON.parse(log.fixed_after_json))
            || !assignmentEqual(extra, JSON.parse(log.extra_after_json))
            || !playerEqual(player, JSON.parse(log.player_after_json))) {
            throw new DuplicateAnomalyMigrationError(
                'migration_state_mismatch',
                'O estado atual não corresponde integralmente à migração aplicada.',
                { fixedAssignmentId: log.fixed_assignment_id }
            );
        }
    }
    return {
        mode: 'verify',
        writesPerformed: false,
        executorVersion: 2,
        migrationCode: normalizedCode,
        verified: logs.length,
        fixedOverrides: logs.length,
        extrasDeactivated: logs.length,
        legacyEntriesRemoved: logs.length,
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
    const normalizedCode = code.toUpperCase();
    const actorId = cleanText(options.actorId) || 'local-admin';

    await db.exec('BEGIN IMMEDIATE');
    try {
        const logs = await activeLogs(db, normalizedCode);
        if (!logs.length) {
            throw new DuplicateAnomalyMigrationError(
                'active_migration_not_found',
                'Migração ativa não encontrada.',
                { migrationCode: normalizedCode }
            );
        }
        for (const log of logs) {
            const fixed = assignmentSnapshot(await readAssignment(db, log.fixed_assignment_id));
            const extra = assignmentSnapshot(await readAssignment(db, log.extra_assignment_id));
            const player = playerSnapshot(await readPlayer(db, log.player_id));
            if (!assignmentEqual(fixed, JSON.parse(log.fixed_after_json))
                || !assignmentEqual(extra, JSON.parse(log.extra_after_json))
                || !playerEqual(player, JSON.parse(log.player_after_json))) {
                throw new DuplicateAnomalyMigrationError(
                    'migration_changed_since_apply',
                    'Os registros mudaram depois da migração; undo automático bloqueado.',
                    { fixedAssignmentId: log.fixed_assignment_id }
                );
            }
        }

        const timestamp = new Date().toISOString();
        for (const log of [...logs].reverse()) {
            const fixed = JSON.parse(log.fixed_before_json);
            const extra = JSON.parse(log.extra_before_json);
            const player = JSON.parse(log.player_before_json);
            const fixedResult = await db.run(
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
            const extraResult = await db.run(
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
            const playerResult = await db.run(
                `UPDATE jogadores SET historias_extras = ?
                 WHERE id = ?`,
                [player.historiasExtrasRaw, player.id]
            );
            if (Number(fixedResult?.changes || 0) !== 1
                || Number(extraResult?.changes || 0) !== 1
                || Number(playerResult?.changes || 0) !== 1) {
                throw new DuplicateAnomalyMigrationError(
                    'undo_write_conflict',
                    'O undo não restaurou exatamente um dos registros.',
                    { fixedAssignmentId: fixed.id }
                );
            }
            await db.run(
                `UPDATE clover_trait_duplicate_anomaly_migrations_v2
                 SET undone_at = ?, undo_actor_id = ? WHERE id = ?`,
                [timestamp, actorId, log.id]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'undo',
            writesPerformed: true,
            executorVersion: 2,
            migrationCode: normalizedCode,
            restored: logs.length,
            fixedOverridesRemoved: logs.length,
            extrasReactivated: logs.length,
            legacyEntriesRestored: logs.length,
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
    previewMigration,
    undoMigration,
    verifyMigration,
};
