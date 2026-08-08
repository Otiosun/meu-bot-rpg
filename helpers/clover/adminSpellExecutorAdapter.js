'use strict';

const {
    AdminSpellError,
    createSpellExecutors,
    spellSnapshot,
} = require('./adminSpellService');

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

function createSpellExecutorsForRegistry() {
    const executors = createSpellExecutors();
    const baseRemove = executors['player.spell.remove'];

    return {
        ...executors,
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
    createSpellExecutorsForRegistry,
    scopeRemovedVersions,
};