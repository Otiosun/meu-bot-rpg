const { isOwner } = require('../groupAccess');
const {
    ensureCloverScriptSchema,
} = require('./cloverScriptService');
const {
    removePlayerForAntiGhost,
} = require('./antiGhostService');

class CloverScriptAntiGhostApplyError extends Error {
    constructor(message, code = 'antighost_apply_error', details = null) {
        super(message);
        this.name = 'CloverScriptAntiGhostApplyError';
        this.code = code;
        this.details = details || null;
    }
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function flattenPlan(plan = {}) {
    const items = [];
    for (const block of plan.blocks || []) {
        for (const target of block.targets || []) {
            for (const action of block.actions || []) {
                items.push({ target, action });
            }
        }
    }
    return items;
}

function antiGhostRemovalItems(plan) {
    return flattenPlan(plan).filter(({ action }) => (
        action?.type === 'antighost' && action?.op === 'remove'
    ));
}

async function findRun(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureCloverScriptSchema(db);
    if (code) {
        return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [String(code).trim().toUpperCase()]);
    }
    return db.get(
        `SELECT * FROM clover_script_runs
         WHERE status IN ('simulated', 'failed') AND created_by = ? AND chat_id = ?
         ORDER BY id DESC LIMIT 1`,
        [actorId || null, chatId || null]
    );
}

async function shouldHandleSafeAntiGhostApply(db, options = {}) {
    const run = await findRun(db, options);
    if (!run) return false;
    const plan = safeJsonParse(run.plan_json, {});
    return antiGhostRemovalItems(plan).length > 0;
}

function validatePlan(plan) {
    const all = flattenPlan(plan);
    const removals = antiGhostRemovalItems(plan);
    if (removals.length !== 1 || all.length !== 1) {
        throw new CloverScriptAntiGhostApplyError(
            'ANTIGHOST remover precisa estar sozinho, com exatamente um player por simulação.',
            'single_antighost_removal_required',
            { totalActions: all.length, removals: removals.length }
        );
    }
    const item = removals[0];
    if (!item.action.confirm) {
        throw new CloverScriptAntiGhostApplyError(
            'ANTIGHOST remover precisa de confirmar=true.',
            'confirmation_required'
        );
    }
    if (!item.target?.id) {
        throw new CloverScriptAntiGhostApplyError('Plano sem player canônico.', 'missing_target');
    }
    return item;
}

async function applySafeAntiGhostSimulation(db, {
    code = null,
    actorId,
    chatId,
    sock = null,
} = {}) {
    if (!isOwner(actorId)) {
        throw new CloverScriptAntiGhostApplyError('ANTIGHOST remover é apenas para Owner.', 'permission_denied');
    }
    const run = await findRun(db, { code, actorId, chatId });
    if (!run) {
        throw new CloverScriptAntiGhostApplyError('Não encontrei simulação anti-ghost pendente.', 'missing_simulation');
    }
    const plan = safeJsonParse(run.plan_json, null);
    if (!plan) throw new CloverScriptAntiGhostApplyError('Plano CloverScript inválido.', 'invalid_plan');
    const item = validatePlan(plan);

    const previous = await db.get(
        `SELECT * FROM clover_script_actions
         WHERE run_id = ? AND action_type = 'antighost_remove_safe' AND status = 'applied'
         ORDER BY id DESC LIMIT 1`,
        [run.id]
    );
    if (run.status === 'applied' && previous) {
        return {
            ok: true,
            alreadyApplied: true,
            text: '*♧┃CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*\n\n> Essa remoção anti-ghost segura já foi concluída.',
        };
    }
    if (!['simulated', 'failed'].includes(run.status)) {
        throw new CloverScriptAntiGhostApplyError('Essa simulação não está pendente.', 'invalid_status');
    }

    try {
        await removePlayerForAntiGhost({
            sock,
            db,
            player: item.target,
            moderatorId: actorId,
            reason: item.action.reason,
        });
        throw new CloverScriptAntiGhostApplyError(
            'ANTIGHOST remover exige uma operação administrativa de ciclo de vida.',
            'manual_staff_lifecycle_required'
        );
    } catch (error) {
        const message = error?.message || String(error);
        const duplicate = await db.get(
            `SELECT id FROM clover_script_actions
             WHERE run_id = ? AND player_id = ?
               AND action_type = 'antighost_remove_safe'
               AND status = 'failed' AND error = ?
             ORDER BY id DESC LIMIT 1`,
            [run.id, item.target.id, message]
        ).catch(() => null);
        if (!duplicate) {
            await db.run(
                `INSERT INTO clover_script_actions
                 (run_id, player_id, action_type, summary, status, error, created_at)
                 VALUES (?, ?, 'antighost_remove_safe', ?, 'failed', ?, CURRENT_TIMESTAMP)`,
                [run.id, item.target.id, 'ANTIGHOST remover recusado', message]
            ).catch(() => null);
        }
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'failed', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = ?
             WHERE id = ?`,
            [actorId || null, message, run.id]
        ).catch(() => null);
        throw error;
    }
}

module.exports = {
    CloverScriptAntiGhostApplyError,
    antiGhostRemovalItems,
    applySafeAntiGhostSimulation,
    shouldHandleSafeAntiGhostApply,
    validatePlan,
};
