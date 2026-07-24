'use strict';

const { ensureCloverInventorySchema } = require('../../database');

class TitleServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'TitleServiceError';
        this.code = code;
        this.details = details;
    }
}

function normalizeRequired(value, field) {
    const text = String(value || '').trim();
    if (!text) throw new TitleServiceError('missing_title_field', `${field} não informado.`, { field });
    return text;
}

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

async function listPlayerTitles(db, playerId) {
    await ensureCloverInventorySchema(db);
    return db.all(
        `SELECT id, title_key, title_name, source, active, unlocked_at
         FROM clover_player_titles
         WHERE player_id = ?
         ORDER BY active DESC, unlocked_at DESC, id DESC`,
        [playerId]
    );
}

async function unlockPlayerTitleInTransaction(db, playerId, input = {}) {
    const titleKey = normalizeRequired(input.titleKey || input.title_key, 'Código do título');
    const titleName = normalizeRequired(input.titleName || input.title_name, 'Nome do título');
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new TitleServiceError('player_not_found', 'Player não encontrado.');

    const existing = await db.get(
        `SELECT * FROM clover_player_titles
         WHERE player_id = ? AND title_key = ? COLLATE NOCASE`,
        [playerId, titleKey]
    );
    if (existing) {
        if (String(existing.title_name || '').trim() !== titleName) {
            throw new TitleServiceError(
                'title_key_conflict',
                'O código do título já existe com outro nome.',
                { playerId, titleKey, existingTitleName: existing.title_name, requestedTitleName: titleName }
            );
        }
        return { ok: true, duplicate: true, title: existing };
    }

    const inserted = await db.run(
        `INSERT INTO clover_player_titles
         (player_id, title_key, title_name, source, related_id, active, unlocked_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?)`,
        [
            playerId,
            titleKey,
            titleName,
            String(input.source || 'title_service').trim() || 'title_service',
            String(input.relatedId || input.related_id || '').trim() || null,
            serializeMetadata(input.metadata),
        ]
    );
    const title = await db.get('SELECT * FROM clover_player_titles WHERE id = ?', [inserted.lastID]);
    return { ok: true, duplicate: false, title };
}

async function unlockPlayerTitle(db, playerId, input = {}) {
    await ensureCloverInventorySchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await unlockPlayerTitleInTransaction(db, playerId, input);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function activatePlayerTitle(db, playerId, titleRef) {
    await ensureCloverInventorySchema(db);
    const title = await db.get(
        `SELECT * FROM clover_player_titles
         WHERE player_id = ? AND (title_key = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?)`,
        [playerId, String(titleRef || '').trim(), String(titleRef || '').trim()]
    );
    if (!title) throw new TitleServiceError('title_not_found', 'Título não encontrado entre os seus desbloqueios.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run('UPDATE clover_player_titles SET active = 0 WHERE player_id = ?', [playerId]);
        await db.run('UPDATE clover_player_titles SET active = 1 WHERE id = ?', [title.id]);
        await db.exec('COMMIT');
        return { ok: true, title: { ...title, active: 1 } };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    TitleServiceError,
    activatePlayerTitle,
    listPlayerTitles,
    unlockPlayerTitle,
    unlockPlayerTitleInTransaction,
};
