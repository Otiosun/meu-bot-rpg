'use strict';

const { normalizeAppearanceValue } = require('../profileForms');

const APPROVAL_TARGETS = Object.freeze([
    Object.freeze({ playerId: '129403438817389@lid', name: 'Osborn Salazar' }),
    Object.freeze({ playerId: '141660990230775@lid', name: 'Nur Ubel' }),
    Object.freeze({ playerId: '1649384923198@lid', name: 'Shirou Tomoe' }),
    Object.freeze({ playerId: '168333391446026@lid', name: 'Cassandra Romanov' }),
    Object.freeze({ playerId: '170609036251189@lid', name: 'Besker F. Targaryen Primeiro' }),
    Object.freeze({ playerId: '29524225957925@lid', name: 'Davina' }),
]);

class PreResetBatchSheetApprovalError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetBatchSheetApprovalError';
        this.code = code;
        this.details = details;
    }
}

function parseDraft(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
}

async function previewPreResetBatchSheetApproval(db, options = {}) {
    const targets = options.targets || APPROVAL_TARGETS;
    const rows = [];
    for (const target of targets) {
        const character = await db.get(
            'SELECT * FROM clover_prereset_characters WHERE player_id = ?', [target.playerId]
        );
        const draft = parseDraft(character?.draft_json);
        const notice = character ? await db.get(
            `SELECT * FROM clover_prereset_sheet_notices
              WHERE player_id = ? AND revision = ?`,
            [target.playerId, character.revision]
        ) : null;
        const issues = [];
        if (!character) issues.push('character_missing');
        else if (!['submitted', 'approved', 'locked'].includes(character.status)) issues.push(`invalid_status:${character.status}`);
        if (character && draft.name !== target.name) issues.push('name_mismatch');
        if (character?.status === 'submitted' && (!notice?.group_id || !notice?.message_id)) issues.push('review_notice_missing');
        if (character?.status === 'submitted' && notice?.decision) issues.push('notice_already_decided');
        rows.push({
            target, character, draft, notice, issues,
            alreadyApproved: ['approved', 'locked'].includes(character?.status),
        });
    }

    const signatures = new Map();
    for (const row of rows) {
        const signature = normalizeAppearanceValue(row.draft.appearance);
        if (!signature) continue;
        if (signatures.has(signature)) {
            row.issues.push('appearance_conflict_in_batch');
            signatures.get(signature).issues.push('appearance_conflict_in_batch');
        } else signatures.set(signature, row);
    }

    const activePlayers = await db.all(`SELECT id, personagem_aparencia
        FROM jogadores
        WHERE personagem_aparencia_status IN ('approved','aprovada')
          AND personagem_aparencia IS NOT NULL AND TRIM(personagem_aparencia) <> ''`).catch(() => []);
    for (const row of rows) {
        const signature = normalizeAppearanceValue(row.draft.appearance);
        if (!signature) continue;
        const conflict = activePlayers.find(player => player.id !== row.target.playerId
            && normalizeAppearanceValue(player.personagem_aparencia) === signature);
        if (conflict) row.issues.push(`appearance_conflict_active:${conflict.id}`);
    }

    return {
        ok: rows.every(row => row.issues.length === 0),
        total: rows.length,
        pending: rows.filter(row => !row.alreadyApproved).length,
        alreadyApproved: rows.filter(row => row.alreadyApproved).length,
        blocked: rows.filter(row => row.issues.length > 0).length,
        rows,
    };
}

async function applyPreResetBatchSheetApproval(db, options = {}) {
    const actorId = String(options.actorId || '').trim();
    if (!actorId) throw new PreResetBatchSheetApprovalError('missing_actor', 'Informe o responsavel pela aprovacao.');
    const preview = await previewPreResetBatchSheetApproval(db, options);
    if (!preview.ok) {
        throw new PreResetBatchSheetApprovalError('approval_preflight_blocked', 'O lote possui divergencias e nao foi alterado.', {
            blocked: preview.rows.filter(row => row.issues.length).map(row => ({ playerId: row.target.playerId, issues: row.issues })),
        });
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const locked = await previewPreResetBatchSheetApproval(db, options);
        if (!locked.ok) throw new PreResetBatchSheetApprovalError('approval_preflight_changed', 'O lote mudou durante a aprovacao.');
        let applied = 0;
        for (const row of locked.rows) {
            if (row.alreadyApproved) continue;
            const result = await db.run(`UPDATE clover_prereset_characters
                SET status='approved', revision=revision+1, updated_by=?, updated_at=CURRENT_TIMESTAMP,
                    approved_at=CURRENT_TIMESTAMP
                WHERE player_id=? AND revision=? AND status='submitted'`,
            [actorId, row.target.playerId, row.character.revision]);
            if (Number(result.changes || 0) !== 1) {
                throw new PreResetBatchSheetApprovalError('approval_compare_and_swap_failed', 'Uma ficha mudou durante a aprovacao.', { playerId: row.target.playerId });
            }
            await db.run(`UPDATE clover_prereset_sheet_notices
                SET decision='approve', reason=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP
                WHERE player_id=? AND revision=? AND decision IS NULL`,
            [options.reason || 'Aprovacao administrativa confirmada pelo owner', actorId, row.target.playerId, row.character.revision]);
            applied += 1;
        }
        await db.exec('COMMIT');
        return { ok: true, applied, duplicate: applied === 0, total: locked.total };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    APPROVAL_TARGETS,
    PreResetBatchSheetApprovalError,
    applyPreResetBatchSheetApproval,
    previewPreResetBatchSheetApproval,
};
