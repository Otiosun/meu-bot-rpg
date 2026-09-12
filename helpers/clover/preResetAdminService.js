'use strict';

const { getFutureCharacter, reviewFutureCharacter } = require('./preResetCharacterService');
const { getTransitionDashboard, getTransitionDecision } = require('./preResetTransitionService');
const { getPreResetCampaignState } = require('./preResetCampaignStateService');
const { getPreResetPurgeTombstone } = require('./preResetPurgeStateService');

class PreResetAdminError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetAdminError';
        this.code = code;
        this.details = details;
    }
}

function normalizeLimit(value, fallback = 25, max = 100) {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
}

function currentCharacterView(player) {
    if (!player) return null;
    return Object.freeze({
        playerId: player.id,
        playerName: player.display_name || player.nome || null,
        fichaStatus: player.ficha_status || null,
        jogoStatus: player.jogo_status || null,
        name: player.personagem_nome || null,
        age: player.personagem_idade ?? null,
        gender: player.personagem_genero || null,
        appearance: player.personagem_aparencia || null,
        appearanceStatus: player.personagem_aparencia_status || null,
        appearanceApprovedBy: player.personagem_aparencia_approved_by || null,
        appearanceApprovedAt: player.personagem_aparencia_approved_at || null,
        kingdom: player.reino || null,
        socialClass: player.classe || null,
        race: player.raca || null,
        grimoire: player.grimorio || null,
        family: player.familia || null,
        familyKey: player.familia_key || null,
        magic: player.magia || null,
        magicKey: player.magia_key || null,
        selectedRoll: player.numero_roll_escolhido ?? null,
    });
}

async function getPreResetAdminOverview(db, options = {}) {
    const [transition, campaign, purgeCount] = await Promise.all([
        getTransitionDashboard(db),
        getPreResetCampaignState(db, options),
        db.get('SELECT COUNT(*) AS total FROM clover_prereset_purge_tombstones').catch(() => ({ total: 0 })),
    ]);
    return Object.freeze({
        campaign,
        transition,
        definitivePurgeCount: Number(purgeCount?.total || 0),
    });
}

async function searchPreResetPlayers(db, query = '', options = {}) {
    const term = String(query || '').trim();
    const pattern = `%${term.replace(/[%_]/g, (match) => `\\${match}`)}%`;
    const limit = normalizeLimit(options.limit);
    const rows = await db.all(
        `SELECT p.id, p.nome, p.display_name, p.ficha_status, p.jogo_status,
                p.personagem_nome, p.personagem_aparencia_status,
                c.status AS future_status, c.revision AS future_revision,
                d.status AS transition_status,
                t.created_at AS purged_at
         FROM jogadores p
         LEFT JOIN clover_prereset_characters c ON c.player_id = p.id
         LEFT JOIN clover_prereset_transition_decisions d ON d.player_id = p.id
         LEFT JOIN clover_prereset_purge_tombstones t ON t.player_id = p.id
         WHERE (? = ''
             OR p.id LIKE ? ESCAPE '\\'
             OR COALESCE(p.nome, '') LIKE ? ESCAPE '\\'
             OR COALESCE(p.display_name, '') LIKE ? ESCAPE '\\'
             OR COALESCE(p.personagem_nome, '') LIKE ? ESCAPE '\\')
         ORDER BY CASE WHEN t.player_id IS NULL THEN 0 ELSE 1 END ASC, p.id ASC
         LIMIT ?`,
        [term, pattern, pattern, pattern, pattern, limit]
    );
    return Object.freeze(rows.map((row) => Object.freeze({
        playerId: row.id,
        displayName: row.display_name || row.nome || null,
        current: Object.freeze({
            fichaStatus: row.ficha_status || null,
            jogoStatus: row.jogo_status || null,
            characterName: row.personagem_nome || null,
            appearanceStatus: row.personagem_aparencia_status || null,
        }),
        future: row.purged_at ? null : Object.freeze({
            status: row.future_status || null,
            revision: row.future_revision === null || row.future_revision === undefined ? null : Number(row.future_revision),
        }),
        transitionStatus: row.transition_status || null,
        purged: Boolean(row.purged_at),
        purgedAt: row.purged_at || null,
    })));
}

async function getPreResetPlayerDetail(db, playerId) {
    const id = String(playerId || '').trim();
    if (!id) throw new PreResetAdminError('player_not_found', 'Player invalido.');
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [id]);
    if (!player) throw new PreResetAdminError('player_not_found', 'Player nao encontrado.');
    const [future, decision, tombstone, reviews, operations] = await Promise.all([
        getFutureCharacter(db, id),
        getTransitionDecision(db, id),
        getPreResetPurgeTombstone(db, id),
        db.all(
            `SELECT operation_key, previous_revision, resulting_revision, action, reason, reviewed_by, created_at
             FROM clover_prereset_character_reviews
             WHERE player_id = ? ORDER BY id DESC LIMIT 50`,
            [id]
        ).catch(() => []),
        db.all(
            `SELECT operation_key, operation_type, resulting_status, resulting_revision, actor_id, created_at
             FROM clover_prereset_transition_operations
             WHERE player_id = ? ORDER BY created_at DESC LIMIT 50`,
            [id]
        ).catch(() => []),
    ]);
    return Object.freeze({
        playerId: id,
        purged: Boolean(tombstone),
        current: currentCharacterView(player),
        future: tombstone ? null : future,
        transition: decision,
        audit: Object.freeze({
            characterReviews: Object.freeze(reviews),
            transitionOperations: Object.freeze(operations),
            purgeTombstone: tombstone,
        }),
    });
}

async function reviewPreResetFutureCharacter(db, context = {}, request = {}) {
    return reviewFutureCharacter(db, context, request);
}

module.exports = {
    PreResetAdminError,
    currentCharacterView,
    getPreResetAdminOverview,
    getPreResetPlayerDetail,
    normalizeLimit,
    reviewPreResetFutureCharacter,
    searchPreResetPlayers,
};
