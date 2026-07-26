'use strict';

const { getSpellCapacity } = require('./spellCapacityService');
const {
    listApprovedSpells,
    normalizeSpellName,
    saveSpell,
} = require('./spellbookService');
const {
    concludeSpellReviewEntry,
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

async function inspectApprovalRequest(db, playerId, sheet, options = {}) {
    await ensureSpellReviewFlowSchema(db);

    const entry = await findActiveEntryForPlayer(db, playerId);
    if (!entry) return approvalFailure('queue_entry_not_active');
    if (entry.status !== 'called') {
        return approvalFailure('queue_entry_not_called', { entry });
    }

    const normalizedName = sheet?.normalizedName || normalizeSpellName(sheet?.name);
    if (!normalizedName) return approvalFailure('invalid_spell_name', { entry });

    const [capacity, spells] = await Promise.all([
        getSpellCapacity(db, playerId),
        listApprovedSpells(db, playerId),
    ]);
    const existingSpell = spells.find((spell) => spell.normalized_name === normalizedName) || null;
    const createsNewSpellSlot = !existingSpell;

    if (createsNewSpellSlot && !capacity.canApproveNewSpell) {
        return approvalFailure('spell_capacity_full', {
            entry,
            capacity,
            createsNewSpellSlot,
            preservesQueueEntry: true,
        });
    }

    return {
        ok: true,
        entry,
        capacity,
        existingSpell,
        createsNewSpellSlot,
        saveOptions: {
            ...options,
            nextVersion: Boolean(options.nextVersion || existingSpell),
        },
    };
}

async function approveCalledSpell(db, playerId, sheet, adminId, options = {}) {
    // Inicializa schemas antes de abrir a transação de escrita.
    const preview = await inspectApprovalRequest(db, playerId, sheet, options);
    if (!preview.ok) return preview;

    await db.exec('BEGIN IMMEDIATE');
    try {
        // Revalida dentro da transação para impedir aprovação concorrente acima do limite.
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
                normalizedName: sheet?.normalizedName || normalizeSpellName(sheet?.name),
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

        const concluded = await concludeSpellReviewEntry(
            db,
            playerId,
            adminId,
            options.reason || 'feitiço aprovado com capacidade validada'
        );
        if (!concluded.ok) {
            await db.exec('ROLLBACK');
            return approvalFailure('queue_conclusion_failed', {
                queueResult: concluded,
                entry: checked.entry,
            });
        }

        await db.exec('COMMIT');
        return {
            ok: true,
            code: checked.createsNewSpellSlot ? 'spell_approved' : 'spell_version_approved',
            spell: saved.spell,
            mode: saved.mode,
            queueEntry: concluded.entry,
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
