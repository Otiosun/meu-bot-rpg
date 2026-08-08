'use strict';

const { ensurePossessionsV1Schema } = require('./possessionsSchema');
const { getItemTemplateInTransaction } = require('./inventoryService');
const {
    grantPlayerTitleInTransaction,
    recordTitleHistoryInTransaction,
    serializeTitle,
} = require('./titleService');

class TitleAdminServiceError extends Error {
    constructor(code, message, details = {}, status = 400) {
        super(message || code);
        this.name = 'TitleAdminServiceError';
        this.code = code;
        this.details = details;
        this.status = status;
    }
}

function titleRef(payload = {}) {
    return String(
        payload.titleKey
        || payload.title_key
        || payload.templateKey
        || payload.template_key
        || payload.key
        || ''
    ).trim();
}

async function resolveTitleTemplate(db, payload = {}) {
    const ref = titleRef(payload);
    if (!ref) throw new TitleAdminServiceError('missing_title_key', 'Informe o Título.');
    const template = await getItemTemplateInTransaction(db, ref);
    if (!template) throw new TitleAdminServiceError('title_template_not_found', 'Título não encontrado no catálogo.', { titleKey: ref }, 404);
    if (template.category !== 'titulo' && template.kind !== 'titulo') {
        throw new TitleAdminServiceError('item_is_not_title', 'O modelo escolhido não é um Título.', { templateKey: template.key });
    }
    return template;
}

async function findPlayerTitle(db, playerId, payload = {}) {
    await ensurePossessionsV1Schema(db);
    const ref = titleRef(payload);
    if (!ref) throw new TitleAdminServiceError('missing_title_key', 'Informe o Título.');
    return db.get(
        `SELECT * FROM clover_player_titles
         WHERE player_id = ?
           AND (title_key = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?)
         LIMIT 1`,
        [playerId, ref, ref]
    );
}

async function latestTitleHistoryId(db, playerId, titleKey = null) {
    if (titleKey) {
        const row = await db.get(
            `SELECT id FROM clover_title_history
             WHERE player_id = ? AND title_key = ? COLLATE NOCASE
             ORDER BY id DESC LIMIT 1`,
            [playerId, titleKey]
        );
        return Number(row?.id || 0);
    }
    const row = await db.get(
        `SELECT id FROM clover_title_history
         WHERE player_id = ? ORDER BY id DESC LIMIT 1`,
        [playerId]
    );
    return Number(row?.id || 0);
}

function titleSnapshot(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        playerId: row.player_id,
        titleKey: row.title_key,
        titleName: row.title_name,
        source: row.source || null,
        relatedId: row.related_id || null,
        active: Boolean(row.active),
        unlockedAt: row.unlocked_at || null,
        metadataJson: row.metadata_json || null,
    };
}

async function restoreTitleSnapshot(db, snapshot) {
    await db.run(
        `INSERT INTO clover_player_titles
         (id, player_id, title_key, title_name, source, related_id, active, unlocked_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            snapshot.id,
            snapshot.playerId,
            snapshot.titleKey,
            snapshot.titleName,
            snapshot.source,
            snapshot.relatedId,
            snapshot.active ? 1 : 0,
            snapshot.unlockedAt,
            snapshot.metadataJson,
        ]
    );
}

async function assertGrantUndoSafe(db, after) {
    const current = await db.get('SELECT * FROM clover_player_titles WHERE id = ?', [after.titleId]);
    if (!current) {
        throw new TitleAdminServiceError('title_grant_missing', 'O Título concedido já não existe para desfazer.', { titleId: after.titleId }, 409);
    }
    if (current.player_id !== after.playerId || current.title_key !== after.titleKey || Boolean(current.active) !== Boolean(after.active)) {
        throw new TitleAdminServiceError('title_grant_changed', 'O Título concedido mudou depois da aplicação.', { titleId: after.titleId }, 409);
    }
    const latest = await latestTitleHistoryId(db, after.playerId, after.titleKey);
    if (latest !== Number(after.historyWatermark || 0)) {
        throw new TitleAdminServiceError('title_history_changed', 'O Título recebeu movimentação posterior e o undo automático foi bloqueado.', { latest, expected: after.historyWatermark }, 409);
    }
}

async function assertRevokeUndoSafe(db, before, after) {
    const duplicate = await db.get(
        'SELECT id FROM clover_player_titles WHERE player_id = ? AND title_key = ? COLLATE NOCASE',
        [before.playerId, before.titleKey]
    );
    if (duplicate) {
        throw new TitleAdminServiceError('title_regranted_after_revoke', 'O Título foi concedido novamente e não pode ser restaurado automaticamente.', { titleId: duplicate.id }, 409);
    }
    const latestTitle = await latestTitleHistoryId(db, before.playerId, before.titleKey);
    if (latestTitle !== Number(after.historyWatermark || 0)) {
        throw new TitleAdminServiceError('title_history_changed', 'O Título recebeu movimentação posterior e o undo automático foi bloqueado.', { latest: latestTitle, expected: after.historyWatermark }, 409);
    }
    if (before.active) {
        const active = await db.get('SELECT id, title_key FROM clover_player_titles WHERE player_id = ? AND active = 1', [before.playerId]);
        if (active) {
            throw new TitleAdminServiceError('active_title_changed_after_revoke', 'Outro Título foi ativado depois da remoção; restauração automática bloqueada.', { activeTitleId: active.id, activeTitleKey: active.title_key }, 409);
        }
        const latestPlayerHistory = await latestTitleHistoryId(db, before.playerId);
        if (latestPlayerHistory !== Number(after.historyWatermark || 0)) {
            throw new TitleAdminServiceError('player_title_state_changed', 'O estado de Títulos do jogador mudou depois da remoção.', { latest: latestPlayerHistory, expected: after.historyWatermark }, 409);
        }
    }
}

function createTitleExecutors() {
    return {
        'player.title.grant': {
            async preview({ db, action, target }) {
                await ensurePossessionsV1Schema(db);
                const template = await resolveTitleTemplate(db, action.payload || {});
                const existing = await db.get(
                    'SELECT * FROM clover_player_titles WHERE player_id = ? AND title_key = ? COLLATE NOCASE',
                    [target.playerId, template.key]
                );
                return {
                    summary: `${target.characterName || target.playerId}: conceder Título ${template.itemName}`,
                    before: existing ? serializeTitle(existing) : null,
                    after: {
                        playerId: target.playerId,
                        titleKey: template.key,
                        titleName: template.itemName,
                        active: existing ? Boolean(existing.active) : false,
                        alreadyUnlocked: Boolean(existing),
                    },
                };
            },
            async apply({ db, operation, unit, action, target, after }) {
                const result = await grantPlayerTitleInTransaction(
                    db,
                    target.playerId,
                    { key: after.titleKey, name: after.titleName },
                    {
                        source: 'admin_operation',
                        relatedId: operation.code,
                        actorId: operation.actor.id,
                        reason: action.payload?.reason || operation.reason || 'Título concedido pela Central ADM',
                        idempotencyKey: `${operation.code}:unit:${unit.id}:title-grant`,
                        metadata: { actionPayload: action.payload || {} },
                    }
                );
                const watermark = await latestTitleHistoryId(db, target.playerId, after.titleKey);
                return {
                    after: {
                        ...after,
                        titleId: result.title.id,
                        active: result.title.active,
                        newlyUnlocked: result.newlyUnlocked,
                        historyWatermark: watermark,
                    },
                    summary: result.newlyUnlocked
                        ? `${target.characterName || target.playerId}: Título ${after.titleName} desbloqueado.`
                        : `${target.characterName || target.playerId}: Título ${after.titleName} já estava desbloqueado.`,
                };
            },
            async undo({ db, operation, after }) {
                if (!after?.newlyUnlocked) return;
                await assertGrantUndoSafe(db, after);
                await db.run('DELETE FROM clover_player_titles WHERE id = ? AND player_id = ?', [after.titleId, after.playerId]);
                await recordTitleHistoryInTransaction(db, {
                    titleId: after.titleId,
                    playerId: after.playerId,
                    titleKey: after.titleKey,
                    titleName: after.titleName,
                    action: 'revoked',
                    actorId: operation.actor.id,
                    source: 'admin_operation_undo',
                    relatedId: operation.code,
                    beforeActive: after.active,
                    afterActive: false,
                    reason: `Undo de ${operation.code}`,
                    idempotencyKey: `${operation.code}:undo:title-grant:${after.titleId}`,
                    metadata: { reversedGrant: true },
                });
            },
        },
        'player.title.remove': {
            async preview({ db, action, target }) {
                const row = await findPlayerTitle(db, target.playerId, action.payload || {});
                if (!row) throw new TitleAdminServiceError('player_title_not_found', 'O jogador não possui esse Título.', { playerId: target.playerId, titleKey: titleRef(action.payload) }, 404);
                const before = titleSnapshot(row);
                return {
                    summary: `${target.characterName || target.playerId}: remover Título ${row.title_name}`,
                    before,
                    after: {
                        playerId: target.playerId,
                        titleKey: row.title_key,
                        titleName: row.title_name,
                        removed: true,
                        wasActive: Boolean(row.active),
                    },
                };
            },
            async apply({ db, operation, unit, action, target, before, after }) {
                const current = await db.get('SELECT * FROM clover_player_titles WHERE id = ? AND player_id = ?', [before.id, target.playerId]);
                if (!current || current.title_key !== before.titleKey || Boolean(current.active) !== Boolean(before.active)) {
                    throw new TitleAdminServiceError('title_changed_since_preview', 'O Título mudou depois da prévia. Simule novamente.', { titleId: before.id }, 409);
                }
                await db.run('DELETE FROM clover_player_titles WHERE id = ? AND player_id = ?', [before.id, target.playerId]);
                const history = await recordTitleHistoryInTransaction(db, {
                    titleId: before.id,
                    playerId: target.playerId,
                    titleKey: before.titleKey,
                    titleName: before.titleName,
                    action: 'revoked',
                    actorId: operation.actor.id,
                    source: 'admin_operation',
                    relatedId: operation.code,
                    beforeActive: before.active,
                    afterActive: false,
                    reason: action.payload?.reason || operation.reason || 'Título removido pela Central ADM',
                    idempotencyKey: `${operation.code}:unit:${unit.id}:title-revoke`,
                    metadata: { actionPayload: action.payload || {} },
                });
                return {
                    after: { ...after, titleId: before.id, historyWatermark: history.id },
                    summary: `${target.characterName || target.playerId}: Título ${before.titleName} removido.`,
                };
            },
            async undo({ db, operation, before, after }) {
                await assertRevokeUndoSafe(db, before, after);
                await restoreTitleSnapshot(db, before);
                await recordTitleHistoryInTransaction(db, {
                    titleId: before.id,
                    playerId: before.playerId,
                    titleKey: before.titleKey,
                    titleName: before.titleName,
                    action: 'restored',
                    actorId: operation.actor.id,
                    source: 'admin_operation_undo',
                    relatedId: operation.code,
                    beforeActive: false,
                    afterActive: before.active,
                    reason: `Undo de ${operation.code}`,
                    idempotencyKey: `${operation.code}:undo:title-revoke:${before.id}`,
                    metadata: { restoredSnapshot: true },
                });
            },
        },
    };
}

module.exports = {
    TitleAdminServiceError,
    createTitleExecutors,
    findPlayerTitle,
    resolveTitleTemplate,
    titleSnapshot,
};
