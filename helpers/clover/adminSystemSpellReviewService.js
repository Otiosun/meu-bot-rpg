'use strict';

const {
    getSpellReviewFlowState,
    setSpellReviewAutoFlowEnabled,
    setSpellReviewCapacity,
} = require('./spellReviewFlowService');
const {
    cancelSpellReviewExternalJobs,
    enqueueManualFillJob,
} = require('./spellReviewExternalJobService');

class AdminSystemSpellReviewError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminSystemSpellReviewError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function normalizeSettingsPayload(payload = {}) {
    const hasCapacity = payload.capacity !== undefined && payload.capacity !== null && payload.capacity !== '';
    const hasAutoFlow = payload.autoFlow !== undefined || payload.auto_flow !== undefined;
    if (!hasCapacity && !hasAutoFlow) {
        throw new AdminSystemSpellReviewError('missing_spell_review_settings', 'Informe capacidade e/ou estado do autoflow.');
    }
    let capacity = null;
    if (hasCapacity) {
        capacity = Number(payload.capacity);
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
            throw new AdminSystemSpellReviewError('invalid_capacity', 'A capacidade de avaliação precisa estar entre 1 e 20.', 400, { min: 1, max: 20, received: payload.capacity });
        }
    }
    let autoFlow = null;
    if (hasAutoFlow) {
        const raw = payload.autoFlow ?? payload.auto_flow;
        if (typeof raw === 'boolean') autoFlow = raw;
        else if (raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true') autoFlow = true;
        else if (raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false') autoFlow = false;
        else throw new AdminSystemSpellReviewError('invalid_auto_flow', 'Autoflow precisa ser verdadeiro ou falso.', 400, { received: raw });
    }
    return { capacity, autoFlow };
}

async function readSettingsState(db) {
    const flow = await getSpellReviewFlowState(db);
    return {
        capacity: Number(flow.capacity || 0),
        autoFlow: Boolean(flow.autoFlow),
        active: Number(flow.active || 0),
        pending: Number(flow.pending || 0),
        waiting: Number(flow.waiting || 0),
        vacancies: Number(flow.vacancies || 0),
    };
}

function settingsEqual(left, right) {
    return Number(left?.capacity) === Number(right?.capacity) && Boolean(left?.autoFlow) === Boolean(right?.autoFlow);
}

function assertSystemTarget(target) {
    if (target?.kind !== 'system' || target?.systemKey !== 'clover') {
        throw new AdminSystemSpellReviewError('invalid_system_target', 'Esta ação só pode usar o alvo global do Clover.');
    }
}

function assertCapacityCanHoldActive(capacity, active, code = 'spell_review_capacity_below_active') {
    if (Number(capacity) < Number(active || 0)) {
        throw new AdminSystemSpellReviewError(code, `A capacidade não pode ficar abaixo das ${active} avaliações ativas.`, 409, { capacity: Number(capacity), active: Number(active || 0) });
    }
}

function actorId(operation = {}) {
    return operation.actor?.id || operation.actor_id || operation.created_by || operation.createdBy || 'admin-operation';
}

function compactJob(job) {
    return job ? { id: Number(job.id || 0), key: job.key, type: job.type, status: job.status } : null;
}

function createSystemSpellReviewExecutors() {
    return {
        'system.spell_review.settings.update': {
            async preview({ db, action, target }) {
                assertSystemTarget(target);
                const requested = normalizeSettingsPayload(action.payload || {});
                const before = await readSettingsState(db);
                const after = { ...before, capacity: requested.capacity ?? before.capacity, autoFlow: requested.autoFlow ?? before.autoFlow };
                assertCapacityCanHoldActive(after.capacity, before.active);
                return {
                    summary: `Avaliação de feitiços: capacidade ${before.capacity} → ${after.capacity}; autoflow ${before.autoFlow ? 'ligado' : 'desligado'} → ${after.autoFlow ? 'ligado' : 'desligado'}`,
                    before,
                    after,
                    metadata: { scope: 'system', systemKey: 'clover' },
                };
            },
            async apply({ db, target, before, after }) {
                assertSystemTarget(target);
                const current = await readSettingsState(db);
                if (!settingsEqual(current, before)) {
                    throw new AdminSystemSpellReviewError('spell_review_settings_changed_after_preview', 'A configuração global mudou depois da prévia. Gere uma nova prévia.', 409, { before, current });
                }
                assertCapacityCanHoldActive(after.capacity, current.active);
                if (Number(after.capacity) !== Number(before.capacity)) {
                    const result = await setSpellReviewCapacity(db, after.capacity);
                    if (!result?.ok) throw new AdminSystemSpellReviewError(result?.code || 'spell_review_capacity_update_failed', 'Não foi possível alterar a capacidade global.', 409, result || null);
                }
                if (Boolean(after.autoFlow) !== Boolean(before.autoFlow)) await setSpellReviewAutoFlowEnabled(db, after.autoFlow);
                const applied = await readSettingsState(db);
                return { after: applied, summary: `Avaliação de feitiços atualizada: capacidade ${applied.capacity}; autoflow ${applied.autoFlow ? 'ligado' : 'desligado'}.` };
            },
            async undo({ db, target, before, after }) {
                assertSystemTarget(target);
                const current = await readSettingsState(db);
                if (!settingsEqual(current, after)) {
                    throw new AdminSystemSpellReviewError('spell_review_settings_changed_after_apply', 'A configuração global recebeu alteração posterior; o undo automático foi bloqueado.', 409, { after, current });
                }
                assertCapacityCanHoldActive(before.capacity, current.active, 'spell_review_undo_capacity_below_active');
                if (Number(before.capacity) !== Number(current.capacity)) {
                    const result = await setSpellReviewCapacity(db, before.capacity);
                    if (!result?.ok) throw new AdminSystemSpellReviewError(result?.code || 'spell_review_capacity_restore_failed', 'Não foi possível restaurar a capacidade global.', 409, result || null);
                }
                if (Boolean(before.autoFlow) !== Boolean(current.autoFlow)) await setSpellReviewAutoFlowEnabled(db, before.autoFlow);
            },
        },
        'system.spell_review.fill.request': {
            async preview({ db, target }) {
                assertSystemTarget(target);
                const before = await readSettingsState(db);
                if (before.vacancies <= 0) {
                    throw new AdminSystemSpellReviewError('spell_review_no_vacancies', 'Não há vagas de avaliação para preencher.', 409, before);
                }
                if (before.waiting <= 0) {
                    throw new AdminSystemSpellReviewError('spell_review_queue_empty', 'Não há personagens aguardando na fila.', 409, before);
                }
                return {
                    summary: `Solicitar preenchimento de até ${Math.min(before.vacancies, before.waiting)} vaga(s) de avaliação`,
                    before,
                    after: { requested: true, maximumCalls: Math.min(before.vacancies, before.waiting) },
                    metadata: { scope: 'system', systemKey: 'clover', externalEffect: true },
                };
            },
            async apply({ db, operation, target, before }) {
                assertSystemTarget(target);
                const current = await readSettingsState(db);
                if (current.vacancies <= 0 || current.waiting <= 0) {
                    throw new AdminSystemSpellReviewError('spell_review_fill_state_changed', 'A fila mudou depois da prévia. Gere uma nova prévia.', 409, { before, current });
                }
                const job = await enqueueManualFillJob(db, {
                    operationCode: operation?.code,
                    actorId: actorId(operation),
                    force: true,
                });
                return {
                    after: { requested: true, job: compactJob(job), stateAtApply: current },
                    summary: 'Preenchimento de vagas registrado para execução recuperável pelo runtime do bot.',
                };
            },
            async undo({ db, target, after }) {
                assertSystemTarget(target);
                const jobId = Number(after?.job?.id || 0);
                if (!jobId) throw new AdminSystemSpellReviewError('spell_review_fill_job_missing', 'O job externo da operação não foi encontrado.', 409);
                try {
                    await cancelSpellReviewExternalJobs(db, [jobId]);
                } catch (error) {
                    throw new AdminSystemSpellReviewError(error?.code || 'spell_external_effect_already_started', error?.message || 'O preenchimento externo já começou; o undo automático foi bloqueado.', 409, error?.details || null);
                }
            },
        },
    };
}

module.exports = {
    AdminSystemSpellReviewError,
    assertCapacityCanHoldActive,
    createSystemSpellReviewExecutors,
    normalizeSettingsPayload,
    readSettingsState,
    settingsEqual,
};