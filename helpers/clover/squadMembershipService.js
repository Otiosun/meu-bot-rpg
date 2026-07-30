'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { isSameUser, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('./accessIntegrationService');
const { normalizeSquadKey } = require('./cavalierService');
const { resolveSquad } = require('./squadStateService');

const APPROVED_SHEET_STATUSES = new Set(['aprovada', 'aprovado', 'confirmada', 'confirmado']);
const RELEASED_GAME_STATUSES = new Set(['liberado', 'liberada']);

class SquadMembershipError extends Error {
    constructor(message, code = 'squad_membership_error', details = null) {
        super(message);
        this.name = 'SquadMembershipError';
        this.code = code;
        this.details = details;
    }
}

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function displayName(player = {}) {
    return filled(player.personagem_nome)
        || filled(player.display_name)
        || filled(player.nome)
        || 'Personagem';
}

function normalizeSearch(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function squadMembershipEligibility(player = {}) {
    const characterName = filled(player.personagem_nome);
    const sheetStatus = normalizeText(player.ficha_status || '');
    const gameStatus = normalizeText(player.jogo_status || '');

    if (!characterName) {
        return {
            ok: false,
            code: 'character_incomplete',
            message: 'O personagem ainda nao possui nome de ficha valido.',
            sheetStatus,
            gameStatus,
        };
    }
    if (!APPROVED_SHEET_STATUSES.has(sheetStatus)) {
        return {
            ok: false,
            code: 'sheet_not_approved',
            message: 'A ficha precisa estar aprovada antes da entrada no esquadrao.',
            sheetStatus,
            gameStatus,
        };
    }
    if (!RELEASED_GAME_STATUSES.has(gameStatus)) {
        return {
            ok: false,
            code: 'game_not_released',
            message: 'O personagem precisa estar liberado no jogo antes da entrada no esquadrao.',
            sheetStatus,
            gameStatus,
        };
    }
    return {
        ok: true,
        code: null,
        message: null,
        sheetStatus,
        gameStatus,
    };
}

async function ensureSquadMembershipSchema(db) {
    await ensureCloverSquadSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'removed', 'transferred', 'archived')),
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ended_at TEXT DEFAULT NULL,
            changed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_squad_memberships_active_player
        ON clover_squad_memberships (player_id)
        WHERE status = 'active'
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_memberships_squad
        ON clover_squad_memberships (squad_key, status, joined_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_membership_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            membership_id INTEGER DEFAULT NULL,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('added', 'removed', 'transferred')),
            performed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
}

async function resolveManagedSquad(db, actorId, squadInput) {
    await ensureSquadMembershipSchema(db);
    const squad = await resolveSquad(db, { squadName: squadInput });
    if (!squad) throw new SquadMembershipError('Esquadrao nao encontrado.', 'squad_not_found');
    const access = await authorizeSquadAccess(db, {
        actorId,
        squad,
        permission: ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE,
        allowMemberRead: false,
    });
    if (!access.ok) {
        throw new SquadMembershipError(
            'Voce nao pode gerenciar membros deste esquadrao.',
            'forbidden'
        );
    }
    return { squad, access };
}

function serializeCandidate(player, targetSquadKey, activeMembership = null) {
    const legacySquadKey = normalizeSquadKey(player.esquadrao);
    const activeSquadKey = normalizeSquadKey(activeMembership?.squad_key);
    const conflict = Boolean(
        legacySquadKey
        && activeSquadKey
        && legacySquadKey !== activeSquadKey
    );
    const currentSquadKey = activeSquadKey || legacySquadKey;
    const membershipStateAllowsTarget = !currentSquadKey || currentSquadKey === targetSquadKey;
    const operationalEligibility = squadMembershipEligibility(player);
    const isCurrentMember = currentSquadKey === targetSquadKey;

    let blockedReason = null;
    if (conflict) blockedReason = 'membership_legacy_conflict';
    else if (!membershipStateAllowsTarget) blockedReason = 'already_in_other_squad';
    else if (!isCurrentMember && !operationalEligibility.ok) blockedReason = operationalEligibility.code;

    return {
        characterId: player.id,
        code: filled(player.codigo) || filled(player.code),
        name: displayName(player),
        image: filled(player.site_profile_image_data) || filled(player.personagem_aparencia_image_path),
        magic: filled(player.magia),
        sheetStatus: operationalEligibility.sheetStatus || null,
        gameStatus: operationalEligibility.gameStatus || null,
        currentSquad: currentSquadKey
            ? { key: currentSquadKey, name: filled(player.esquadrao) || currentSquadKey }
            : null,
        eligible: Boolean(!blockedReason && !currentSquadKey && operationalEligibility.ok),
        blockedReason,
    };
}

async function searchSquadMemberCandidates(db, { actorId, squadInput, query }) {
    const { squad } = await resolveManagedSquad(db, actorId, squadInput);
    const needle = normalizeSearch(query);
    if (needle.length < 2) return { ok: true, candidates: [] };
    const rows = await db.all(
        `SELECT id, nome, display_name, personagem_nome, codigo, code,
                magia, esquadrao, site_profile_image_data, personagem_aparencia_image_path,
                ficha_status, jogo_status
         FROM jogadores
         WHERE COALESCE(NULLIF(TRIM(personagem_nome), ''), '-') <> '-'
         ORDER BY LOWER(personagem_nome), LOWER(nome), id`
    ).catch(async () => db.all(
        `SELECT id, nome, display_name, personagem_nome,
                magia, esquadrao, site_profile_image_data, personagem_aparencia_image_path,
                ficha_status, jogo_status
         FROM jogadores
         WHERE COALESCE(NULLIF(TRIM(personagem_nome), ''), '-') <> '-'
         ORDER BY LOWER(personagem_nome), LOWER(nome), id`
    ));
    const memberships = await db.all(
        `SELECT m.*
         FROM clover_squad_memberships m
         WHERE m.status = 'active'`
    );
    const activeByPlayer = new Map(
        memberships.map((membership) => [membership.player_id, membership])
    );
    const candidates = rows
        .map((row) => ({
            row,
            haystack: normalizeSearch([
                row.personagem_nome,
                row.nome,
                row.display_name,
                row.id,
                row.codigo,
                row.code,
            ].filter(Boolean).join(' ')),
        }))
        .filter((entry) => entry.haystack.includes(needle))
        .slice(0, 12)
        .map((entry) => serializeCandidate(
            entry.row,
            squad.squad_key,
            activeByPlayer.get(entry.row.id)
        ));
    return { ok: true, candidates };
}

async function activeMembershipForPlayer(db, playerId) {
    return db.get(
        `SELECT * FROM clover_squad_memberships
         WHERE player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [playerId]
    );
}

async function writeMembershipEvent(db, membership, action, actorId, reason, metadata = {}) {
    await db.run(
        `INSERT INTO clover_squad_membership_events
         (membership_id, squad_key, player_id, action, performed_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            membership?.id || null,
            membership.squad_key,
            membership.player_id,
            action,
            normalizeJid(actorId) || String(actorId || 'system'),
            reason || null,
            metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : null,
        ]
    );
}

function membershipResult(row, player) {
    return {
        squadKey: row.squad_key,
        characterId: row.player_id,
        characterName: displayName(player),
        membershipId: String(row.id),
        changedAt: row.ended_at || row.joined_at,
    };
}

async function addSquadMember(db, { actorId, squadInput, characterId }) {
    const { squad } = await resolveManagedSquad(db, actorId, squadInput);
    const actor = normalizeJid(actorId);
    const playerId = normalizeJid(characterId) || String(characterId || '').trim();
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new SquadMembershipError('Personagem nao encontrado.', 'player_not_found');

    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        const currentSquadKey = normalizeSquadKey(freshPlayer?.esquadrao);
        let membership = await activeMembershipForPlayer(db, playerId);
        const activeSquadKey = normalizeSquadKey(membership?.squad_key);
        if (activeSquadKey && activeSquadKey !== squad.squad_key) {
            throw new SquadMembershipError(
                'Personagem possui vinculo ativo com outro esquadrao.',
                'active_membership_conflict',
                { activeSquadKey }
            );
        }
        if (currentSquadKey && currentSquadKey !== squad.squad_key) {
            throw new SquadMembershipError(
                'Personagem ja esta em outro esquadrao.',
                activeSquadKey ? 'membership_legacy_conflict' : 'already_in_other_squad',
                { legacySquadKey: currentSquadKey, activeSquadKey: activeSquadKey || null }
            );
        }

        const alreadyActive = Boolean(membership && activeSquadKey === squad.squad_key);
        if (!alreadyActive) {
            const eligibility = squadMembershipEligibility(freshPlayer);
            if (!eligibility.ok) {
                throw new SquadMembershipError(
                    eligibility.message,
                    eligibility.code,
                    {
                        sheetStatus: eligibility.sheetStatus,
                        gameStatus: eligibility.gameStatus,
                    }
                );
            }
        }

        if (!membership) {
            const inserted = await db.run(
                `INSERT INTO clover_squad_memberships
                 (squad_key, player_id, status, changed_by, reason, metadata_json)
                 VALUES (?, ?, 'active', ?, 'Adicao manual pela lideranca', ?)`,
                [
                    squad.squad_key,
                    playerId,
                    actor,
                    JSON.stringify({ source: 'captain_api' }),
                ]
            );
            membership = await db.get(
                'SELECT * FROM clover_squad_memberships WHERE id = ?',
                [inserted.lastID]
            );
            await writeMembershipEvent(
                db,
                membership,
                'added',
                actor,
                'Adicao manual pela lideranca'
            );
        }
        await db.run(
            `UPDATE jogadores
             SET esquadrao = ?
             WHERE id = ?`,
            [squad.name, playerId]
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: alreadyActive,
            membership: membershipResult(membership, freshPlayer || player),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function removeSquadMember(db, { actorId, squadInput, characterId, reason }) {
    const { squad } = await resolveManagedSquad(db, actorId, squadInput);
    const actor = normalizeJid(actorId);
    const playerId = normalizeJid(characterId) || String(characterId || '').trim();
    const cleanReason = String(reason || '').trim().replace(/\s+/g, ' ');
    if (cleanReason.length < 3) {
        throw new SquadMembershipError('Informe o motivo da remocao.', 'missing_reason');
    }
    if (isSameUser(playerId, squad.captain_player_id)) {
        throw new SquadMembershipError(
            'Capitao nao pode remover a si mesmo por este fluxo.',
            'captain_self_removal_blocked'
        );
    }
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new SquadMembershipError('Personagem nao encontrado.', 'player_not_found');

    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        const legacySquadKey = normalizeSquadKey(freshPlayer?.esquadrao);
        const active = await activeMembershipForPlayer(db, playerId);
        const activeSquadKey = normalizeSquadKey(active?.squad_key);
        if (activeSquadKey && activeSquadKey !== squad.squad_key) {
            throw new SquadMembershipError(
                'Personagem possui vinculo ativo com outro esquadrao.',
                'active_membership_conflict',
                { activeSquadKey }
            );
        }
        if (legacySquadKey && legacySquadKey !== squad.squad_key) {
            throw new SquadMembershipError(
                'Personagem possui campo legado em outro esquadrao.',
                'membership_legacy_conflict',
                { legacySquadKey, activeSquadKey: activeSquadKey || null }
            );
        }
        if (!active && legacySquadKey !== squad.squad_key) {
            throw new SquadMembershipError(
                'Personagem nao pertence a este esquadrao.',
                'not_squad_member'
            );
        }
        let membership = active;
        if (active) {
            await db.run(
                `UPDATE clover_squad_memberships
                 SET status = 'removed',
                     ended_at = CURRENT_TIMESTAMP,
                     changed_by = ?,
                     reason = ?
                 WHERE id = ?`,
                [actor, cleanReason, active.id]
            );
            membership = await db.get(
                'SELECT * FROM clover_squad_memberships WHERE id = ?',
                [active.id]
            );
        } else {
            const inserted = await db.run(
                `INSERT INTO clover_squad_memberships
                 (squad_key, player_id, status, joined_at, ended_at, changed_by, reason, metadata_json)
                 VALUES (?, ?, 'removed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)`,
                [
                    squad.squad_key,
                    playerId,
                    actor,
                    cleanReason,
                    JSON.stringify({ reconstructed_from_legacy: true }),
                ]
            );
            membership = await db.get(
                'SELECT * FROM clover_squad_memberships WHERE id = ?',
                [inserted.lastID]
            );
        }
        await db.run(
            "UPDATE jogadores SET esquadrao = '-' WHERE id = ?",
            [playerId]
        );
        await writeMembershipEvent(db, membership, 'removed', actor, cleanReason);
        await db.exec('COMMIT');
        return { ok: true, membership: membershipResult(membership, player) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    SquadMembershipError,
    addSquadMember,
    ensureSquadMembershipSchema,
    removeSquadMember,
    searchSquadMemberCandidates,
    squadMembershipEligibility,
};
