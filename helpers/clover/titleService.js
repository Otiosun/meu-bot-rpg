'use strict';

const { ensurePossessionsV1Schema } = require('./possessionsSchema');

class TitleServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'TitleServiceError';
        this.code = code;
        this.details = details;
    }
}

function safeJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeTitle(row) {
    if (!row) return null;
    const titleMetadata = safeJson(row.metadata_json, {});
    const templateMetadata = safeJson(row.template_metadata_json, {});
    return {
        id: Number(row.id),
        key: row.title_key,
        name: row.title_name,
        title_key: row.title_key,
        title_name: row.title_name,
        description: row.template_description || titleMetadata.description || null,
        active: Boolean(row.active),
        source: row.source || null,
        relatedId: row.related_id || null,
        related_id: row.related_id || null,
        unlockedAt: row.unlocked_at || null,
        unlocked_at: row.unlocked_at || null,
        rarity: templateMetadata.rarity || titleMetadata.rarity || null,
        metadata: titleMetadata,
    };
}

function serializeTitleHistory(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        titleId: row.title_id === null ? null : Number(row.title_id),
        titleKey: row.title_key,
        titleName: row.title_name,
        action: row.action,
        actorId: row.actor_id || null,
        source: row.source || null,
        relatedId: row.related_id || null,
        beforeActive: row.before_active === null ? null : Boolean(row.before_active),
        afterActive: row.after_active === null ? null : Boolean(row.after_active),
        reason: row.reason || null,
        createdAt: row.created_at || null,
        metadata: safeJson(row.metadata_json, {}),
    };
}

async function recordTitleHistoryInTransaction(db, entry) {
    const idempotencyKey = entry.idempotencyKey
        ? String(entry.idempotencyKey).trim()
        : null;

    if (idempotencyKey) {
        const existing = await db.get(
            'SELECT * FROM clover_title_history WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (existing) return serializeTitleHistory(existing);
    }

    const inserted = await db.run(
        `INSERT INTO clover_title_history (
            title_id, player_id, title_key, title_name, action, actor_id,
            source, related_id, before_active, after_active, reason,
            idempotency_key, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            entry.titleId ?? null,
            entry.playerId,
            entry.titleKey,
            entry.titleName,
            entry.action,
            entry.actorId || null,
            entry.source || null,
            entry.relatedId || null,
            entry.beforeActive === undefined || entry.beforeActive === null
                ? null
                : (entry.beforeActive ? 1 : 0),
            entry.afterActive === undefined || entry.afterActive === null
                ? null
                : (entry.afterActive ? 1 : 0),
            String(entry.reason || '').trim().slice(0, 500) || null,
            idempotencyKey,
            JSON.stringify(entry.metadata || {}),
        ]
    );
    return serializeTitleHistory(
        await db.get('SELECT * FROM clover_title_history WHERE id = ?', [inserted.lastID])
    );
}

async function grantPlayerTitleInTransaction(db, playerId, title, options = {}) {
    await ensurePossessionsV1Schema(db);
    const key = String(title?.key || title?.titleKey || '').trim();
    const name = String(title?.name || title?.titleName || '').trim();
    if (!key || !name) {
        throw new TitleServiceError('invalid_title', 'Informe a chave e o nome do Título.');
    }

    const existing = await db.get(
        'SELECT * FROM clover_player_titles WHERE player_id = ? AND title_key = ? COLLATE NOCASE',
        [playerId, key]
    );
    if (existing) {
        return {
            ok: true,
            newlyUnlocked: false,
            title: serializeTitle(existing),
        };
    }

    const inserted = await db.run(
        `INSERT INTO clover_player_titles (
            player_id, title_key, title_name, source, related_id,
            active, unlocked_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?)`,
        [
            playerId,
            key,
            name,
            options.source || null,
            options.relatedId || null,
            JSON.stringify(options.metadata || {}),
        ]
    );

    const row = await db.get(
        'SELECT * FROM clover_player_titles WHERE id = ?',
        [inserted.lastID]
    );

    await recordTitleHistoryInTransaction(db, {
        titleId: row.id,
        playerId,
        titleKey: row.title_key,
        titleName: row.title_name,
        action: 'granted',
        actorId: options.actorId || options.createdBy || null,
        source: options.source || null,
        relatedId: options.relatedId || null,
        beforeActive: false,
        afterActive: false,
        reason: options.reason || 'Título desbloqueado',
        idempotencyKey: options.idempotencyKey || `title-grant:${row.id}`,
        metadata: options.metadata || {},
    });

    return {
        ok: true,
        newlyUnlocked: true,
        title: serializeTitle(row),
    };
}

async function grantPlayerTitle(db, playerId, title, options = {}) {
    await ensurePossessionsV1Schema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await grantPlayerTitleInTransaction(db, playerId, title, options);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listPlayerTitles(db, playerId) {
    await ensurePossessionsV1Schema(db);
    const rows = await db.all(
        `SELECT
            title.*,
            template.description AS template_description,
            template.metadata_json AS template_metadata_json
         FROM clover_player_titles title
         LEFT JOIN clover_item_templates template
           ON template.template_key = title.title_key
         WHERE title.player_id = ?
         ORDER BY title.active DESC, title.unlocked_at DESC, title.id DESC`,
        [playerId]
    );
    return rows.map(serializeTitle);
}

async function getActivePlayerTitle(db, playerId) {
    await ensurePossessionsV1Schema(db);
    const row = await db.get(
        `SELECT
            title.*,
            template.description AS template_description,
            template.metadata_json AS template_metadata_json
         FROM clover_player_titles title
         LEFT JOIN clover_item_templates template
           ON template.template_key = title.title_key
         WHERE title.player_id = ? AND title.active = 1
         LIMIT 1`,
        [playerId]
    );
    return serializeTitle(row);
}

async function listPlayerTitleHistory(db, playerId, limit = 30) {
    await ensurePossessionsV1Schema(db);
    const rows = await db.all(
        `SELECT *
         FROM clover_title_history
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [playerId, Math.max(1, Math.min(100, Number(limit) || 30))]
    );
    return rows.map(serializeTitleHistory);
}

function isNoTitleReference(titleRef) {
    return ['none', 'nenhum', 'sem-titulo', 'sem_titulo', 'off', '0'].includes(
        String(titleRef || '').trim().toLowerCase()
    );
}

async function deactivatePlayerTitle(db, playerId, options = {}) {
    await ensurePossessionsV1Schema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const active = await db.get(
            'SELECT * FROM clover_player_titles WHERE player_id = ? AND active = 1',
            [playerId]
        );
        if (!active) {
            await db.exec('COMMIT');
            return { ok: true, changed: false, title: null, activeTitle: null };
        }

        await db.run(
            'UPDATE clover_player_titles SET active = 0 WHERE id = ? AND active = 1',
            [active.id]
        );
        await recordTitleHistoryInTransaction(db, {
            titleId: active.id,
            playerId,
            titleKey: active.title_key,
            titleName: active.title_name,
            action: 'deactivated',
            actorId: options.actorId || playerId,
            source: options.source || 'site',
            relatedId: options.relatedId || null,
            beforeActive: true,
            afterActive: false,
            reason: options.reason || 'Jogador escolheu não usar Título',
            idempotencyKey: options.idempotencyKey || null,
            metadata: options.metadata || {},
        });
        await db.exec('COMMIT');
        return { ok: true, changed: true, title: serializeTitle(active), activeTitle: null };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function activatePlayerTitle(db, playerId, titleRef, options = {}) {
    if (isNoTitleReference(titleRef)) {
        return deactivatePlayerTitle(db, playerId, options);
    }

    await ensurePossessionsV1Schema(db);
    const ref = String(titleRef || '').trim();
    const title = await db.get(
        `SELECT * FROM clover_player_titles
         WHERE player_id = ?
           AND (title_key = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?)`,
        [playerId, ref, ref]
    );
    if (!title) {
        throw new TitleServiceError(
            'title_not_found',
            'Título não encontrado entre os seus desbloqueios.'
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await db.get(
            'SELECT * FROM clover_player_titles WHERE player_id = ? AND active = 1',
            [playerId]
        );
        if (current && Number(current.id) === Number(title.id)) {
            await db.exec('COMMIT');
            return {
                ok: true,
                changed: false,
                title: serializeTitle({ ...title, active: 1 }),
                activeTitle: serializeTitle({ ...title, active: 1 }),
            };
        }

        if (current) {
            await db.run(
                'UPDATE clover_player_titles SET active = 0 WHERE id = ? AND active = 1',
                [current.id]
            );
            await recordTitleHistoryInTransaction(db, {
                titleId: current.id,
                playerId,
                titleKey: current.title_key,
                titleName: current.title_name,
                action: 'deactivated',
                actorId: options.actorId || playerId,
                source: options.source || 'site',
                relatedId: options.relatedId || null,
                beforeActive: true,
                afterActive: false,
                reason: options.reason || 'Substituído por outro Título',
                idempotencyKey: options.idempotencyKey
                    ? `${options.idempotencyKey}:previous`
                    : null,
                metadata: options.metadata || {},
            });
        }

        await db.run(
            'UPDATE clover_player_titles SET active = 1 WHERE id = ? AND player_id = ?',
            [title.id, playerId]
        );
        await recordTitleHistoryInTransaction(db, {
            titleId: title.id,
            playerId,
            titleKey: title.title_key,
            titleName: title.title_name,
            action: 'activated',
            actorId: options.actorId || playerId,
            source: options.source || 'site',
            relatedId: options.relatedId || null,
            beforeActive: false,
            afterActive: true,
            reason: options.reason || 'Título ativado',
            idempotencyKey: options.idempotencyKey
                ? `${options.idempotencyKey}:active`
                : null,
            metadata: options.metadata || {},
        });

        const updated = await db.get(
            'SELECT * FROM clover_player_titles WHERE id = ?',
            [title.id]
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            changed: true,
            title: serializeTitle(updated),
            activeTitle: serializeTitle(updated),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    TitleServiceError,
    activatePlayerTitle,
    deactivatePlayerTitle,
    getActivePlayerTitle,
    grantPlayerTitle,
    grantPlayerTitleInTransaction,
    isNoTitleReference,
    listPlayerTitleHistory,
    listPlayerTitles,
    recordTitleHistoryInTransaction,
    serializeTitle,
    serializeTitleHistory,
};
