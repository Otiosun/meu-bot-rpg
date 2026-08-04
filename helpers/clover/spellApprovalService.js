'use strict';

const { getSpellCapacity } = require('./spellCapacityService');
const {
    listApprovedSpells,
    normalizeSpellName,
    saveSpell,
} = require('./spellbookService');
const {
    ensureSpellReviewFlowSchema,
    findActiveEntryForPlayer,
} = require('./spellReviewFlowService');

function approvalFailure(code, details = {}) {
    return {
        ok: false,
        code,
        ...details,
    };
}

function isCompatibleUpdateName(existingName, requestedName) {
    const existing = String(existingName || '');
    const requested = String(requestedName || '');
    if (!existing || !requested) return false;
    return existing === requested
        || existing.endsWith(`_${requested}`)
        || requested.endsWith(`_${existing}`)
        || existing.includes(requested);
}

function findCompatibleUpdateSpell(spells, normalizedName) {
    const candidates = spells.filter((spell) => (
        isCompatibleUpdateName(spell.normalized_name, normalizedName)
    ));
    if (candidates.length !== 1) {
        return {
            ok: false,
            code: candidates.length > 1 ? 'spell_update_ambiguous' : 'spell_update_not_found',
            candidates,
        };
    }
    return { ok: true, spell: candidates[0] };
}

async function inspectApprovalRequest(db, playerId, sheet, options = {}) {
    await ensureSpellReviewFlowSchema(db);

    const entry = await findActiveEntryForPlayer(db, playerId);
    const normalizedName = sheet?.normalizedName || normalizeSpellName(sheet?.name);
    if (!normalizedName) return approvalFailure('invalid_spell_name', { entry });

    const [capacity, spells] = await Promise.all([
        getSpellCapacity(db, playerId),
        listApprovedSpells(db, playerId),
    ]);
    let existingSpell = spells.find((spell) => spell.normalized_name === normalizedName) || null;
    if (!existingSpell && options.nextVersion) {
        const compatible = findCompatibleUpdateSpell(spells, normalizedName);
        if (!compatible.ok && compatible.code === 'spell_update_ambiguous') {
            return approvalFailure(compatible.code, {
                entry,
                candidates: compatible.candidates,
            });
        }
        existingSpell = compatible.spell || null;
    }
    const createsNewSpellSlot = !existingSpell;
    const effectiveNormalizedName = existingSpell?.normalized_name || normalizedName;

    if (createsNewSpellSlot && !capacity.canApproveNewSpell) {
        return approvalFailure('spell_capacity_full', {
            entry,
            capacity,
            createsNewSpellSlot,
            preservesQueueEntry: Boolean(entry),
        });
    }

    return {
        ok: true,
        entry,
        capacity,
        existingSpell,
        createsNewSpellSlot,
        normalizedName: effectiveNormalizedName,
        saveOptions: {
            ...options,
            nextVersion: Boolean(options.nextVersion),
        },
    };
}

async function approveCalledSpell(db, playerId, sheet, adminId, options = {}) {
    const preview = await inspectApprovalRequest(db, playerId, sheet, options);
    if (!preview.ok) return preview;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const checked = await inspectApprovalRequest(db, playerId, sheet, options);
        if (!checked.ok) {
            await db.exec('ROLLBACK');
            return checked;
        }

        const saved = await saveSpell(
            db,
            playerId,
            {
                ...sheet,
                normalizedName: checked.normalizedName,
            },
            adminId,
            checked.saveOptions
        );
        if (!saved.ok) {
            await db.exec('ROLLBACK');
            return approvalFailure('spell_save_failed', {
                saveResult: saved,
                entry: checked.entry,
            });
        }

        await db.exec('COMMIT');
        return {
            ok: true,
            code: checked.createsNewSpellSlot ? 'spell_approved' : 'spell_version_approved',
            spell: saved.spell,
            mode: saved.mode,
            queueEntry: checked.entry,
            queuePreserved: Boolean(checked.entry),
            capacityBefore: checked.capacity,
            createsNewSpellSlot: checked.createsNewSpellSlot,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    approveCalledSpell,
    inspectApprovalRequest,
};
