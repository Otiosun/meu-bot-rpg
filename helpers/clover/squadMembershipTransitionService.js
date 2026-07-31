'use strict';

const crypto = require('crypto');
const { isSameUser, normalizeJid } = require('../groupAccess');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('./accessIntegrationService');
const { normalizeSquadKey } = require('./cavalierService');
const {
    SquadMembershipError,
    ensureSquadMembershipSchema,
} = require('./squadMembershipService');
const { resolveSquad } = require('./squadStateService');

function cleanText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function safeJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function requestHash(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

function normalizeTransitionKey(value) {
    const key = cleanText(value);
    if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(key)) {
        throw new SquadMembershipError(
            'Informe uma chave idempotente válida para a transferência.',
            'invalid_membership_transition_key'
        );
    }
    return key;
}

async function ensureSquadMembershipTransitionSchema(db) {
    await ensureSquadMembershipSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_membership_transitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transition_key TEXT NOT NULL UNIQUE,
            request_hash TEXT NOT NULL,
            player_id TEXT NOT NULL,
            from_squad_key TEXT NOT NULL,
            to_squad_key TEXT NOT NULL,
            from_membership_id INTEGER NOT NULL,
            to_membership_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed'
                CHECK (status IN ('completed', 'reversed')),
            performed_by TEXT NOT NULL,
            reason TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            reversed_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_membership_transitions_player
        ON clover_squad_membership_transitions (player_id, created_at DESC, id DESC)
    `);
}

async function assertAuthorizedSquadAccess(db, actorId, squad) {
    const access = await authorizeSquadAccess(db, {
        actorId,
        squad,
        permission: ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE,
        allowMemberRead: false,
    });
    if (!access.ok) {
        throw new SquadMembershipError(
            'Você não pode gerenciar membros deste esquadrão.',
            'forbidden',
            { squadKey: squad.squad_key }
        );
    }
    return access;
}

async function resolveAuthorizedSquad(db, actorId, squadInput) {
    const squad = await resolveSquad(db, { squadName: squadInput });
    if (!squad) throw new SquadMembershipError('Esquadrão não encontrado.', 'squad_not_found');
    await assertAuthorizedSquadAccess(db, actorId, squad);
    return squad;
}

async function writeEvent(db, membership, action, actorId, reason, metadata) {
    await db.run(
        `INSERT INTO clover_squad_membership_events
         (membership_id, squad_key, player_id, action, performed_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            membership.id,
            membership.squad_key,
            membership.player_id,
            action,
            actorId,
            reason,
            JSON.stringify(metadata || {}),
        ]
    );
}

function transitionResult(row) {
    return safeJson(row?.result_json, null);
}

function validateExistingTransitionReceipt(row, expected) {
    if (row.status !== 'completed') {
        throw new SquadMembershipError(
            'A transferência idempotente não está concluída.',
            'membership_transition_not_completed',
            { transitionKey: row.transition_key, status: row.status }
        );
    }
    const result = transitionResult(row);
    const valid = result
        && result.transitionKey === expected.transitionKey
        && result.playerId === expected.playerId
        && result.fromSquad?.key === expected.fromSquadKey
        && result.toSquad?.key === expected.toSquadKey
        && Number(result.fromMembershipId) === Number(row.from_membership_id)
        && Number(result.toMembershipId) === Number(row.to_membership_id);
    if (!valid) {
        throw new SquadMembershipError(
            'O recibo idempotente da transferência está corrompido.',
            'membership_transition_receipt_corrupt',
            { transitionKey: row.transition_key }
        );
    }
    return result;
}

async function transferSquadMember(db, input = {}) {
    await ensureSquadMembershipTransitionSchema(db);
    const actorId = normalizeJid(input.actorId) || cleanText(input.actorId);
    const playerId = normalizeJid(input.characterId) || cleanText(input.characterId);
    const reason = cleanText(input.reason);
    const transitionKey = normalizeTransitionKey(input.transitionKey || input.idempotencyKey);
    if (!actorId) throw new SquadMembershipError('Ator inválido.', 'invalid_actor');
    if (!playerId) throw new SquadMembershipError('Personagem inválido.', 'invalid_player');
    if (reason.length < 3) throw new SquadMembershipError('Informe o motivo da transferência.', 'missing_reason');

    const source = await resolveAuthorizedSquad(db, actorId, input.fromSquadInput);
    const target = await resolveAuthorizedSquad(db, actorId, input.toSquadInput);
    const fromSquadKey = normalizeSquadKey(source.squad_key || source.name);
    const toSquadKey = normalizeSquadKey(target.squad_key || target.name);
    if (!fromSquadKey || !toSquadKey) {
        throw new SquadMembershipError('Esquadrão inválido.', 'invalid_squad');
    }
    if (fromSquadKey === toSquadKey) {
        throw new SquadMembershipError(
            'Origem e destino precisam ser esquadrões diferentes.',
            'same_squad_transfer'
        );
    }
    if (isSameUser(playerId, source.captain_player_id)
        || isSameUser(playerId, source.vice_captain_player_id)) {
        throw new SquadMembershipError(
            'A liderança precisa ser substituída antes da transferência.',
            'leadership_transfer_blocked'
        );
    }

    const payload = { playerId, fromSquadKey, toSquadKey, reason };
    const fingerprint = requestHash(payload);

    await db.exec('BEGIN IMMEDIATE');
    try {
        await assertAuthorizedSquadAccess(db, actorId, source);
        await assertAuthorizedSquadAccess(db, actorId, target);

        const existing = await db.get(
            'SELECT * FROM clover_squad_membership_transitions WHERE transition_key = ?',
            [transitionKey]
        );
        if (existing) {
            if (existing.request_hash !== fingerprint) {
                throw new SquadMembershipError(
                    'A chave idempotente já foi usada com outra transferência.',
                    'membership_transition_idempotency_conflict',
                    { transitionKey }
                );
            }
            const receipt = validateExistingTransitionReceipt(existing, {
                transitionKey,
                playerId,
                fromSquadKey,
                toSquadKey,
            });
            await db.exec('COMMIT');
            return {
                ok: true,
                duplicate: true,
                transition: receipt,
            };
        }

        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        if (!player) throw new SquadMembershipError('Personagem não encontrado.', 'player_not_found');
        const active = await db.all(
            `SELECT * FROM clover_squad_memberships
             WHERE player_id = ? AND status = 'active'
             ORDER BY id`,
            [playerId]
        );
        if (active.length !== 1) {
            throw new SquadMembershipError(
                active.length ? 'O personagem possui vínculos ativos duplicados.' : 'O personagem não possui vínculo ativo.',
                active.length ? 'multiple_active_memberships' : 'active_membership_missing',
                { playerId, activeMembershipIds: active.map((membership) => membership.id) }
            );
        }

        const sourceMembership = active[0];
        const activeSquadKey = normalizeSquadKey(sourceMembership.squad_key);
        const legacySquadKey = normalizeSquadKey(player.esquadrao);
        if (activeSquadKey !== fromSquadKey || legacySquadKey !== fromSquadKey) {
            throw new SquadMembershipError(
                'O vínculo ativo e a projeção legada não confirmam o esquadrão de origem.',
                'membership_transfer_source_conflict',
                { activeSquadKey, legacySquadKey, expectedSquadKey: fromSquadKey }
            );
        }

        const sourceMetadata = {
            ...safeJson(sourceMembership.metadata_json, {}),
            transfer: {
                transitionKey,
                direction: 'out',
                toSquadKey,
                performedBy: actorId,
            },
        };
        const ended = await db.run(
            `UPDATE clover_squad_memberships
             SET status = 'transferred', ended_at = CURRENT_TIMESTAMP,
                 changed_by = ?, reason = ?, metadata_json = ?
             WHERE id = ? AND status = 'active'`,
            [actorId, reason, JSON.stringify(sourceMetadata), sourceMembership.id]
        );
        if (Number(ended.changes || 0) !== 1) {
            throw new SquadMembershipError(
                'O vínculo de origem mudou durante a transferência.',
                'membership_transfer_concurrency_conflict'
            );
        }

        const inserted = await db.run(
            `INSERT INTO clover_squad_memberships
             (squad_key, player_id, status, changed_by, reason, metadata_json)
             VALUES (?, ?, 'active', ?, ?, ?)`,
            [
                toSquadKey,
                playerId,
                actorId,
                reason,
                JSON.stringify({
                    source: 'membership_transfer',
                    transitionKey,
                    previousMembershipId: Number(sourceMembership.id),
                    fromSquadKey,
                }),
            ]
        );
        const targetMembership = await db.get(
            'SELECT * FROM clover_squad_memberships WHERE id = ?',
            [inserted.lastID]
        );
        if (!targetMembership) {
            throw new SquadMembershipError(
                'O vínculo de destino não pôde ser confirmado.',
                'membership_transfer_target_missing'
            );
        }

        const projected = await db.run(
            'UPDATE jogadores SET esquadrao = ? WHERE id = ?',
            [target.name, playerId]
        );
        if (Number(projected.changes || 0) !== 1) {
            throw new SquadMembershipError(
                'A projeção legada não pôde ser atualizada.',
                'membership_transfer_projection_failed'
            );
        }

        const eventMetadata = { transitionKey, fromSquadKey, toSquadKey };
        await writeEvent(db, sourceMembership, 'transferred', actorId, reason, {
            ...eventMetadata,
            direction: 'out',
            targetMembershipId: Number(targetMembership.id),
        });
        await writeEvent(db, targetMembership, 'transferred', actorId, reason, {
            ...eventMetadata,
            direction: 'in',
            sourceMembershipId: Number(sourceMembership.id),
        });

        const activeAfter = await db.all(
            `SELECT * FROM clover_squad_memberships
             WHERE player_id = ? AND status = 'active'
             ORDER BY id`,
            [playerId]
        );
        const playerAfter = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        const sourceAfter = await db.get(
            'SELECT * FROM clover_squad_memberships WHERE id = ?',
            [sourceMembership.id]
        );
        if (activeAfter.length !== 1
            || normalizeSquadKey(activeAfter[0].squad_key) !== toSquadKey
            || normalizeSquadKey(playerAfter?.esquadrao) !== toSquadKey
            || sourceAfter?.status !== 'transferred'
            || !sourceAfter?.ended_at) {
            throw new SquadMembershipError(
                'A transferência não atingiu as pós-condições de integridade.',
                'membership_transfer_postcondition_failed'
            );
        }

        const result = {
            transitionKey,
            playerId,
            characterName: player.personagem_nome || player.nome || playerId,
            fromSquad: { key: fromSquadKey, name: source.name },
            toSquad: { key: toSquadKey, name: target.name },
            fromMembershipId: Number(sourceMembership.id),
            toMembershipId: Number(targetMembership.id),
            reason,
        };
        await db.run(
            `INSERT INTO clover_squad_membership_transitions
             (transition_key, request_hash, player_id, from_squad_key, to_squad_key,
              from_membership_id, to_membership_id, status, performed_by, reason,
              result_json, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
            [
                transitionKey,
                fingerprint,
                playerId,
                fromSquadKey,
                toSquadKey,
                sourceMembership.id,
                targetMembership.id,
                actorId,
                reason,
                JSON.stringify(result),
                JSON.stringify({ source: 'membership_transition_service' }),
            ]
        );
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, transition: result };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    assertAuthorizedSquadAccess,
    ensureSquadMembershipTransitionSchema,
    normalizeTransitionKey,
    requestHash,
    resolveAuthorizedSquad,
    transferSquadMember,
    validateExistingTransitionReceipt,
};
