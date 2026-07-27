'use strict';

const {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    TraitDescriptionRepairError,
    ensureSupportedPlan,
    planHash,
} = require('./traitCanonicalDescriptionExecutor');

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeRepairCode(value, hash) {
    const code = cleanText(value) || `TDR-${hash.slice(0, 12).toUpperCase()}`;
    if (!/^[A-Z0-9_-]{6,80}$/i.test(code)) {
        throw new TraitDescriptionRepairError(
            'invalid_repair_code',
            'Código de reparo inválido.',
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
    const columns = await tableColumns(db, 'clover_trait_templates');
    for (const required of ['id', 'name', 'description', 'effect_text', 'restrictions_text']) {
        if (!columns.has(required)) {
            throw new TraitDescriptionRepairError(
                'incompatible_trait_schema',
                `Coluna obrigatória ausente: ${required}`
            );
        }
    }
    return columns;
}

async function readTemplate(db, templateId, columns = null) {
    const available = columns || await tableColumns(db, 'clover_trait_templates');
    const updatedAt = available.has('updated_at') ? 'updated_at' : 'NULL AS updated_at';
    const row = await db.get(
        `SELECT id, name, description, effect_text, restrictions_text, ${updatedAt}
         FROM clover_trait_templates
         WHERE id = ?`,
        [templateId]
    );
    if (!row) {
        throw new TraitDescriptionRepairError(
            'template_not_found',
            'Modelo de Traço não encontrado.',
            { templateId }
        );
    }
    return row;
}

function rowSnapshot(row) {
    return {
        id: row.id,
        name: row.name,
        description: cleanText(row.description),
        effectText: cleanText(row.effect_text),
        restrictionsText: cleanText(row.restrictions_text),
        updatedAt: row.updated_at ?? null,
    };
}

function contentSnapshot(value) {
    return {
        name: cleanText(value?.name),
        description: cleanText(value?.description),
        effectText: cleanText(value?.effectText),
        restrictionsText: cleanText(value?.restrictionsText),
    };
}

function contentEqual(left, right) {
    return JSON.stringify(contentSnapshot(left)) === JSON.stringify(contentSnapshot(right));
}

function exactEqual(left, right) {
    return contentEqual(left, right)
        && (left?.updatedAt ?? null) === (right?.updatedAt ?? null);
}

function expectedBefore(action) {
    return {
        name: action.before.name,
        description: action.before.description,
        effectText: action.before.effectText,
        restrictionsText: action.before.restrictionsText,
    };
}

function expectedAfter(action) {
    return {
        name: action.after.name,
        description: action.after.description,
        effectText: action.after.effectText,
        restrictionsText: action.after.restrictionsText,
    };
}

async function preflightPlan(db, planInput, expectedState = 'before') {
    const plan = ensureSupportedPlan(planInput);
    const columns = await ensureCompatibleSchema(db);
    const rows = [];
    for (const action of plan.actions) {
        const actual = rowSnapshot(await readTemplate(db, action.templateId, columns));
        const expected = expectedState === 'after' ? expectedAfter(action) : expectedBefore(action);
        if (!contentEqual(actual, expected)) {
            throw new TraitDescriptionRepairError(
                expectedState === 'after' ? 'applied_state_mismatch' : 'stale_plan',
                expectedState === 'after'
                    ? 'O modelo não corresponde ao estado aplicado esperado.'
                    : 'O banco divergiu do estado usado para criar o plano.',
                { templateId: action.templateId, actual, expected }
            );
        }
        rows.push({ action, actual });
    }
    return { plan, rows, columns };
}

async function ensureRepairLogSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_trait_description_repairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repair_code TEXT NOT NULL,
            plan_hash TEXT NOT NULL,
            template_id TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            actor_id TEXT DEFAULT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            undone_at TEXT DEFAULT NULL,
            undo_actor_id TEXT DEFAULT NULL,
            UNIQUE (repair_code, template_id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_trait_description_repairs_code
        ON clover_trait_description_repairs (repair_code, undone_at, id)
    `);
}

async function previewRepairPlan(db, planInput) {
    const prepared = await preflightPlan(db, planInput, 'before');
    return {
        mode: 'preview',
        writesPerformed: false,
        executorVersion: 2,
        planHash: planHash(prepared.plan),
        updates: prepared.rows.length,
        namesChanged: 0,
        templateIds: prepared.rows.map((entry) => entry.action.templateId),
    };
}

async function applyRepairPlan(db, planInput, options = {}) {
    if (options.confirm !== APPLY_CONFIRMATION) {
        throw new TraitDescriptionRepairError(
            'confirmation_required',
            `Confirmação inválida. Use ${APPLY_CONFIRMATION}.`
        );
    }
    const hash = planHash(planInput);
    const repairCode = normalizeRepairCode(options.repairCode, hash);
    const actorId = cleanText(options.actorId) || 'local-admin';

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRepairLogSchema(db);
        const existing = await db.get(
            'SELECT COUNT(*) AS total FROM clover_trait_description_repairs WHERE repair_code = ?',
            [repairCode]
        );
        if (Number(existing?.total || 0) > 0) {
            throw new TraitDescriptionRepairError(
                'repair_code_already_used',
                'O código de reparo já foi utilizado.',
                { repairCode }
            );
        }

        const prepared = await preflightPlan(db, planInput, 'before');
        for (const { action, actual } of prepared.rows) {
            const afterContent = expectedAfter(action);
            const setters = [
                'description = ?',
                'effect_text = ?',
                'restrictions_text = ?',
            ];
            const values = [
                afterContent.description,
                afterContent.effectText,
                afterContent.restrictionsText,
            ];
            if (prepared.columns.has('updated_at')) setters.push('updated_at = CURRENT_TIMESTAMP');
            values.push(action.templateId);
            const result = await db.run(
                `UPDATE clover_trait_templates
                 SET ${setters.join(', ')}
                 WHERE id = ?`,
                values
            );
            if (Number(result?.changes || 0) !== 1) {
                throw new TraitDescriptionRepairError(
                    'template_update_failed',
                    'A atualização do modelo não afetou exatamente uma linha.',
                    { templateId: action.templateId }
                );
            }
            const after = rowSnapshot(
                await readTemplate(db, action.templateId, prepared.columns)
            );
            if (!contentEqual(after, afterContent)) {
                throw new TraitDescriptionRepairError(
                    'template_post_update_mismatch',
                    'O modelo não ficou no estado esperado após a atualização.',
                    { templateId: action.templateId, after, expected: afterContent }
                );
            }
            await db.run(
                `INSERT INTO clover_trait_description_repairs
                 (repair_code, plan_hash, template_id, before_json, after_json, actor_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    repairCode,
                    hash,
                    action.templateId,
                    JSON.stringify(actual),
                    JSON.stringify(after),
                    actorId,
                ]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'apply',
            writesPerformed: true,
            executorVersion: 2,
            repairCode,
            planHash: hash,
            updated: prepared.rows.length,
            namesChanged: 0,
            timestampsCaptured: prepared.rows.length,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function verifyAppliedPlan(db, planInput) {
    const prepared = await preflightPlan(db, planInput, 'after');
    return {
        mode: 'verify',
        writesPerformed: false,
        executorVersion: 2,
        planHash: planHash(prepared.plan),
        verified: prepared.rows.length,
        namesChanged: 0,
    };
}

async function undoRepairBatch(db, options = {}) {
    if (options.confirm !== UNDO_CONFIRMATION) {
        throw new TraitDescriptionRepairError(
            'confirmation_required',
            `Confirmação inválida. Use ${UNDO_CONFIRMATION}.`
        );
    }
    const repairCode = normalizeRepairCode(options.repairCode, '000000000000');
    const actorId = cleanText(options.actorId) || 'local-admin';

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRepairLogSchema(db);
        const logs = await db.all(
            `SELECT * FROM clover_trait_description_repairs
             WHERE repair_code = ? AND undone_at IS NULL
             ORDER BY id DESC`,
            [repairCode]
        );
        if (!logs.length) {
            throw new TraitDescriptionRepairError(
                'repair_batch_not_found',
                'Lote de reparo ativo não encontrado.',
                { repairCode }
            );
        }
        const columns = await ensureCompatibleSchema(db);
        for (const log of logs) {
            const before = JSON.parse(log.before_json);
            const after = JSON.parse(log.after_json);
            const actual = rowSnapshot(await readTemplate(db, log.template_id, columns));
            if (!exactEqual(actual, after)) {
                throw new TraitDescriptionRepairError(
                    'undo_state_mismatch',
                    'O modelo mudou após o reparo; undo automático bloqueado.',
                    { templateId: log.template_id, actual, expected: after }
                );
            }
        }

        for (const log of logs) {
            const before = JSON.parse(log.before_json);
            const setters = [
                'description = ?',
                'effect_text = ?',
                'restrictions_text = ?',
            ];
            const values = [before.description, before.effectText, before.restrictionsText];
            if (columns.has('updated_at')) {
                setters.push('updated_at = ?');
                values.push(before.updatedAt);
            }
            values.push(log.template_id);
            const result = await db.run(
                `UPDATE clover_trait_templates
                 SET ${setters.join(', ')}
                 WHERE id = ?`,
                values
            );
            if (Number(result?.changes || 0) !== 1) {
                throw new TraitDescriptionRepairError(
                    'undo_update_failed',
                    'O undo não afetou exatamente uma linha.',
                    { templateId: log.template_id }
                );
            }
            const restored = rowSnapshot(await readTemplate(db, log.template_id, columns));
            if (!exactEqual(restored, before)) {
                throw new TraitDescriptionRepairError(
                    'undo_restore_mismatch',
                    'O undo não restaurou integralmente o snapshot anterior.',
                    { templateId: log.template_id, restored, expected: before }
                );
            }
            await db.run(
                `UPDATE clover_trait_description_repairs
                 SET undone_at = CURRENT_TIMESTAMP, undo_actor_id = ?
                 WHERE id = ?`,
                [actorId, log.id]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'undo',
            writesPerformed: true,
            executorVersion: 2,
            repairCode,
            restored: logs.length,
            namesChanged: 0,
            timestampsRestored: logs.length,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    APPLY_CONFIRMATION,
    UNDO_CONFIRMATION,
    TraitDescriptionRepairError,
    applyRepairPlan,
    previewRepairPlan,
    undoRepairBatch,
    verifyAppliedPlan,
};
