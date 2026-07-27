'use strict';

const crypto = require('node:crypto');

const APPLY_CONFIRMATION = 'APPLY-CANONICAL-TRAIT-DESCRIPTIONS';
const UNDO_CONFIRMATION = 'UNDO-CANONICAL-TRAIT-DESCRIPTIONS';

class TraitDescriptionRepairError extends Error {
    constructor(code, message, details = null) {
        super(message || code);
        this.name = 'TraitDescriptionRepairError';
        this.code = code;
        this.details = details;
    }
}

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
}

function semanticPlan(planInput) {
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    return {
        policy: {
            exactNameOnly: plan.policy?.exactNameOnly === true,
            changesNames: plan.policy?.changesNames === true,
            appliesWrites: plan.policy?.appliesWrites === true,
            onlyMissing: plan.policy?.onlyMissing !== false,
        },
        actions: Array.isArray(plan.actions)
            ? plan.actions.map((action) => ({
                templateId: action.templateId,
                matchMethod: action.matchMethod,
                namePreserved: action.namePreserved,
                before: {
                    name: action.before?.name ?? null,
                    description: action.before?.description ?? null,
                    effectText: action.before?.effectText ?? null,
                    restrictionsText: action.before?.restrictionsText ?? null,
                },
                after: {
                    name: action.after?.name ?? null,
                    description: action.after?.description ?? null,
                    effectText: action.after?.effectText ?? null,
                    restrictionsText: action.after?.restrictionsText ?? null,
                },
            }))
            : [],
    };
}

function planHash(plan) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(stableValue(semanticPlan(plan))))
        .digest('hex');
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

function ensureSupportedPlan(planInput) {
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (!actions.length) {
        throw new TraitDescriptionRepairError('empty_plan', 'O plano não possui atualizações canônicas.');
    }
    if (plan.mode !== 'readonly_plan'
        || plan.policy?.exactNameOnly !== true
        || plan.policy?.changesNames !== false
        || plan.policy?.appliesWrites !== false
        || plan.policy?.onlyMissing === false) {
        throw new TraitDescriptionRepairError(
            'unsafe_plan_policy',
            'O plano não possui a política segura esperada.'
        );
    }

    const ids = new Set();
    actions.forEach((action, index) => {
        const id = cleanText(action?.templateId);
        if (!id || ids.has(id)) {
            throw new TraitDescriptionRepairError(
                'invalid_or_duplicate_template_id',
                'O plano possui ID ausente ou duplicado.',
                { index, id }
            );
        }
        ids.add(id);
        if (action.matchMethod !== 'exact_normalized_name' || action.namePreserved !== true) {
            throw new TraitDescriptionRepairError(
                'unsafe_match_method',
                'Ação sem correspondência exata ou sem preservação de nome.',
                { index, id }
            );
        }
        const beforeName = cleanText(action.before?.name);
        const afterName = cleanText(action.after?.name);
        if (!beforeName || beforeName !== afterName) {
            throw new TraitDescriptionRepairError(
                'name_rewrite_forbidden',
                'O executor não aceita alteração de nome.',
                { index, id, beforeName, afterName }
            );
        }
        if (cleanText(action.before?.description)) {
            throw new TraitDescriptionRepairError(
                'description_not_missing_in_plan',
                'O plano tenta alterar um modelo que já possuía descrição.',
                { index, id }
            );
        }
        if (!cleanText(action.after?.description)) {
            throw new TraitDescriptionRepairError(
                'missing_canonical_description',
                'A descrição canônica proposta está vazia.',
                { index, id }
            );
        }
    });

    return { ...plan, actions };
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

function rowSnapshot(row) {
    return {
        id: row.id,
        name: row.name,
        description: cleanText(row.description),
        effectText: cleanText(row.effect_text),
        restrictionsText: cleanText(row.restrictions_text),
    };
}

function comparableSnapshot(value) {
    return {
        name: cleanText(value?.name),
        description: cleanText(value?.description),
        effectText: cleanText(value?.effectText),
        restrictionsText: cleanText(value?.restrictionsText),
    };
}

function snapshotsEqual(left, right) {
    return JSON.stringify(comparableSnapshot(left)) === JSON.stringify(comparableSnapshot(right));
}

async function readTemplate(db, templateId) {
    const row = await db.get(
        `SELECT id, name, description, effect_text, restrictions_text
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
    await ensureCompatibleSchema(db);
    const rows = [];
    for (const action of plan.actions) {
        const row = await readTemplate(db, action.templateId);
        const actual = rowSnapshot(row);
        const expected = expectedState === 'after' ? expectedAfter(action) : expectedBefore(action);
        if (!snapshotsEqual(actual, expected)) {
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
    return { plan, rows };
}

async function previewRepairPlan(db, planInput) {
    const prepared = await preflightPlan(db, planInput, 'before');
    return {
        mode: 'preview',
        writesPerformed: false,
        planHash: planHash(prepared.plan),
        updates: prepared.rows.length,
        namesChanged: 0,
        templateIds: prepared.rows.map((entry) => entry.action.templateId),
    };
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
        const columns = await tableColumns(db, 'clover_trait_templates');
        for (const { action, actual } of prepared.rows) {
            const after = expectedAfter(action);
            const setters = [
                'description = ?',
                'effect_text = ?',
                'restrictions_text = ?',
            ];
            const values = [after.description, after.effectText, after.restrictionsText];
            if (columns.has('updated_at')) setters.push('updated_at = CURRENT_TIMESTAMP');
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
            await db.run(
                `INSERT INTO clover_trait_description_repairs
                 (repair_code, plan_hash, template_id, before_json, after_json, actor_id)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    repairCode,
                    hash,
                    action.templateId,
                    JSON.stringify(actual),
                    JSON.stringify({ id: action.templateId, ...after }),
                    actorId,
                ]
            );
        }
        await db.exec('COMMIT');
        return {
            mode: 'apply',
            writesPerformed: true,
            repairCode,
            planHash: hash,
            updated: prepared.rows.length,
            namesChanged: 0,
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
        const columns = await tableColumns(db, 'clover_trait_templates');
        for (const log of logs) {
            const before = JSON.parse(log.before_json);
            const after = JSON.parse(log.after_json);
            const row = await readTemplate(db, log.template_id);
            const actual = rowSnapshot(row);
            if (!snapshotsEqual(actual, after)) {
                throw new TraitDescriptionRepairError(
                    'undo_state_mismatch',
                    'O modelo mudou após o reparo; undo automático bloqueado.',
                    { templateId: log.template_id, actual, expected: after }
                );
            }
            const setters = [
                'description = ?',
                'effect_text = ?',
                'restrictions_text = ?',
            ];
            const values = [before.description, before.effectText, before.restrictionsText];
            if (columns.has('updated_at')) setters.push('updated_at = CURRENT_TIMESTAMP');
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
            repairCode,
            restored: logs.length,
            namesChanged: 0,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    APPLY_CONFIRMATION,
    TraitDescriptionRepairError,
    UNDO_CONFIRMATION,
    applyRepairPlan,
    ensureSupportedPlan,
    planHash,
    previewRepairPlan,
    undoRepairBatch,
    verifyAppliedPlan,
};
