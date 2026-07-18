'use strict';

const { ensureCloverInventorySchema } = require('../../database');

class TitleServiceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TitleServiceError';
        this.code = code;
    }
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

module.exports = { TitleServiceError, activatePlayerTitle, listPlayerTitles };
