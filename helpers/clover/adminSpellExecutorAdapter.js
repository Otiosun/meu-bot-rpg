'use strict';

const {
    AdminSpellError,
    createSpellExecutors,
    spellSnapshot,
} = require('./adminSpellService');
const {
    cancelSpellReviewExternalJobs,
    enqueueSpellReviewPostCommitJobs,
} = require('./spellReviewExternalJobService');

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function affectedIds(before = {}) {
    return new Set((before.versions || []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0));
}

function scopeRemovedVersions(rows, before) {
    const ids = affectedIds(before);
    return (rows || [])
        .filter((row) => ids.has(Number(row.id)))
        .map(spellSnapshot);
}

function assertApprovalModeMatchesHistory(preview) {
    const mode = String(preview?.before?.mode || '').trim().toLowerCase();
    const versions = Array.isArray(preview?.before?.versions) ? preview.before.versions : [];
    if (mode === 'add' && versions.length > 0) {
        throw new AdminSpellError(
            'spell_add_requires_new_name',
            'Já existe histórico para esse nome. Use atualização para criar uma nova versão.',
            409,
            { existingVersions: versions.map((row) => row.version) }
        );
    }
    if (mode === 'update' && versions.length === 0) {
        throw new AdminSpellError(
            'spell_update_requires_existing',
            'Não existe histórico para esse nome. Use adicionar para o primeiro registro.',
            409
        );
    }
    return preview;
}

function operationActorId(operation = {}) {
    return operation.actor?.id
        || operation.actor_id
        || operation.created_by
        || operation.createdBy
        || 'admin-operation';
}

function summarizeExternalJobs(jobs = []) {
    return jobs.map((job) => ({
        id: Number(job.id || 0),
        key: job.key,
        type: job.type,
        status: job.status,
    }));
}

function createSpellExecutorsForRegistry() {
    const executors = createSpellExecutors();
    const baseApprove = executors['player.spell.approve'];
    const baseRemove = executors['player.spell.remove'];

    return {
        ...executors,
        'player.spell.approve': {
            ...baseApprove,
            async preview(context) {
                return assertApprovalModeMatchesHistory(await baseApprove.preview(context));
            },
            async apply(context) {
                const result = await baseApprove.apply(context);
                const jobs = await enqueueSpellReviewPostCommitJobs(context.db, {
                    operationCode: context.operation?.code,
                    playerId: context.target?.playerId,
                    actorId: operationActorId(context.operation),
                });
                result.after = {
                    ...(result.after || {}),
                    externalJobs: summarizeExternalJobs(jobs),
                };
                result.summary = `${result.summary} Efeitos externos registrados para processamento recuperável.`;
                return result;
            },
            async undo(context) {
                const jobIds = (context.after?.externalJobs || [])
                    .map((job) => Number(job.id))
                    .filter((id) => Number.isInteger(id) && id > 0);
                if (jobIds.length) {
                    try {
                        await cancelSpellReviewExternalJobs(context.db, jobIds);
                    } catch (error) {
                        throw new AdminSpellError(
                            error?.code || 'spell_external_effect_already_started',
                            error?.message || 'Um efeito externo já começou; o undo automático foi bloqueado.',
                            409,
                            error?.details || null
                        );
                    }
                }
                await baseApprove.undo(context);
            },
        },
        'player.spell.remove': {
            ...baseRemove,
            async apply(context) {
                const result = await baseRemove.apply(context);
                const before = context.before || {};
                const ids = affectedIds(before);
                result.after = {
                    ...(result.after || {}),
                    removedVersions: (result.after?.removedVersions || []).filter((row) => ids.has(Number(row.id))),
                };
                return result;
            },
            async undo({ db, target, before, after }) {
                const ids = affectedIds(before);
                if (!ids.size) {
                    throw new AdminSpellError('spell_remove_snapshot_empty', 'A remoção não possui versões afetadas registradas.', 409);
                }
                const placeholders = [...ids].map(() => '?').join(', ');
                const rows = await db.all(
                    `SELECT * FROM clover_spellbook_spells
                     WHERE player_id = ? AND id IN (${placeholders})
                     ORDER BY version ASC, id ASC`,
                    [target.playerId, ...ids]
                );
                const currentRemoved = scopeRemovedVersions(
                    rows.filter((row) => row.status === 'removed'),
                    before
                );
                if (!valuesMatch(currentRemoved, after?.removedVersions || [])) {
                    throw new AdminSpellError(
                        'spell_changed_after_remove',
                        'As versões afetadas mudaram depois da remoção; o undo automático foi bloqueado.',
                        409
                    );
                }
                const beforeById = new Map((before.versions || []).map((row) => [Number(row.id), row]));
                for (const id of ids) {
                    const original = beforeById.get(id);
                    if (!original) continue;
                    await db.run(
                        `UPDATE clover_spellbook_spells
                         SET status = ?, removed_at = ?, updated_at = ?
                         WHERE id = ? AND player_id = ?`,
                        [original.status, original.removedAt, original.updatedAt, id, target.playerId]
                    );
                }
            },
        },
    };
}

module.exports = {
    affectedIds,
    assertApprovalModeMatchesHistory,
    createSpellExecutorsForRegistry,
    operationActorId,
    scopeRemovedVersions,
    summarizeExternalJobs,
};