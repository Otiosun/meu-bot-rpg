const { isOwner } = require('../groupAccess');
const {
    formatMention,
    playerDisplayName,
} = require('./commandTargetUtils');
const {
    ensureCloverScriptSchema,
} = require('./cloverScriptService');
const {
    removePlayerForAntiGhost,
} = require('./antiGhostSafeService');

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

function serialize(value) {
    return JSON.stringify(value ?? null);
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

function successFromLegacyResult(result) {
    return Boolean(
        result?.ok
        || result?.archive?.ok
        || result?.archive?.lifecycle?.ok
        || result?.archive?.lifecycle?.lifecycle?.ok
    );
}

function collectWarnings(result) {
    const warnings = [...(result?.warnings || [])];
    if (result?.community && !result.community.ok) {
        warnings.push(`arquivado, mas não removido da comunidade: ${result.community.reason || 'falha externa'}`);
    }
    const archiveSync = result?.archive?.archiveSync;
    if (archiveSync && archiveSync.ok === false && !archiveSync.skipped) {
        warnings.push(`card de arquivo não sincronizado: ${archiveSync.error || archiveSync.reason || 'falha externa'}`);
    }
    return [...new Set(warnings)];
}

function renderApplied({ run, item, result, warnings }) {
    const lifecycleCode = result?.lifecycleCode
        || result?.archive?.lifecycle?.code
        || result?.archive?.lifecycle?.lifecycle?.code
        || '-';
    return [
        '*♧┃CLOVERSCRIPT APLICADO 𖥔 CLOVER MULTICOLOR*',
        '     ── anti-ghost convertido em arquivamento seguro ──',
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Código:* ${run.code}`,
        `*Player:* ${playerDisplayName(item.target, item.target.id)} (${formatMention(item.target.id)})`,
        `*Evento de ciclo:* ${lifecycleCode}`,
        `*Motivo:* ${item.action.reason || 'anti-ghost'}`,
        '',
        '> Cadastro, personagem, PH, inventário, grimório e histórico foram preservados.',
        '> Fila, reservas, esquadrão e liderança foram tratados pelo ciclo de vida protegido.',
        warnings.length ? '' : null,
        warnings.length ? '_`─( ! )───── Avisos externos`_' : null,
        warnings.length ? '' : null,
        ...warnings.map((warning) => `> ${warning}`),
    ].filter(Boolean).join('\n');
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
        const result = await removePlayerForAntiGhost({
            sock,
            db,
            player: item.target,
            moderatorId: actorId,
            reason: item.action.reason,
        });
        if (!successFromLegacyResult(result)) {
            throw new CloverScriptAntiGhostApplyError(
                result?.error || result?.reason || result?.archive?.error || 'Não consegui arquivar o player com segurança.',
                'safe_archive_failed',
                result
            );
        }

        const warnings = collectWarnings(result);
        const summary = `${playerDisplayName(item.target, item.target.id)}: anti-ghost arquivado com segurança`;
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
             VALUES (?, ?, 'antighost_remove_safe', ?, 'applied', ?, ?, CURRENT_TIMESTAMP)`,
            [
                run.id,
                item.target.id,
                summary,
                serialize({ action: item.action }),
                serialize({ result, warnings }),
            ]
        );
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'applied', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = NULL
             WHERE id = ?`,
            [actorId || null, run.id]
        );

        return {
            ok: true,
            run,
            plan,
            item,
            result,
            warnings,
            text: renderApplied({ run, item, result, warnings }),
        };
    } catch (error) {
        const message = error?.message || String(error);
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, error, created_at)
             VALUES (?, ?, 'antighost_remove_safe', ?, 'failed', ?, CURRENT_TIMESTAMP)`,
            [run.id, item.target.id, 'ANTIGHOST remover recusado', message]
        ).catch(() => null);
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
    collectWarnings,
    shouldHandleSafeAntiGhostApply,
    successFromLegacyResult,
    validatePlan,
};
