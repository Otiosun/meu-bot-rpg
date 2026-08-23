'use strict';

const { isSameUser } = require('../groupAccess');
const { normalizeText } = require('../textUtils');

class SquadMembershipReadError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SquadMembershipReadError';
        this.code = code;
        this.details = details;
    }
}

function normalizeSquadKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function rawPlayerId(value) {
    const raw = value && typeof value === 'object'
        ? (value.id || value.player_id)
        : value;
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/:\d+(?=@)/g, '') || null;
}

function samePlayer(left, right) {
    const a = rawPlayerId(left);
    const b = rawPlayerId(right);
    if (!a || !b) return false;
    if (a === b) return true;
    return isSameUser(a, b);
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
        [tableName]
    ).catch(() => null);
    return Boolean(row?.found);
}

async function readPlayerProjection(db, playerOrId) {
    if (playerOrId && typeof playerOrId === 'object') {
        const id = rawPlayerId(playerOrId);
        if (!id) return null;

        if (Object.prototype.hasOwnProperty.call(playerOrId, 'esquadrao')) {
            return { ...playerOrId, id: rawPlayerId(playerOrId.id || playerOrId.player_id) };
        }

        const exact = await db.get(
            'SELECT id, esquadrao FROM jogadores WHERE id=?',
            [id]
        ).catch(() => null);
        if (exact) return { ...playerOrId, ...exact };

        const rows = await db.all(
            'SELECT id, esquadrao FROM jogadores'
        ).catch(() => []);
        const equivalent = rows.filter((row) => samePlayer(row.id, id));

        if (equivalent.length > 1) {
            throw new SquadMembershipReadError(
                'ambiguous_player_identity',
                'Mais de um jogador equivale à identidade consultada.',
                { requestedPlayerId: id, equivalentPlayerIds: equivalent.map((row) => row.id) }
            );
        }

        return equivalent.length === 1
            ? { ...playerOrId, ...equivalent[0] }
            : { ...playerOrId, id };
    }

    const id = rawPlayerId(playerOrId);
    if (!id) return null;

    const exact = await db.get(
        'SELECT id, esquadrao FROM jogadores WHERE id=?',
        [id]
    ).catch(() => null);
    if (exact) return exact;

    const rows = await db.all(
        'SELECT id, esquadrao FROM jogadores'
    ).catch(() => []);
    const equivalent = rows.filter((row) => samePlayer(row.id, id));

    if (equivalent.length > 1) {
        throw new SquadMembershipReadError(
            'ambiguous_player_identity',
            'Mais de um jogador equivale à identidade consultada.',
            { requestedPlayerId: id, equivalentPlayerIds: equivalent.map((row) => row.id) }
        );
    }

    return equivalent.length === 1 ? equivalent[0] : { id, esquadrao: null };
}

async function readAllActiveMemberships(db) {
    if (!await tableExists(db, 'clover_squad_memberships')) return [];

    const squadsExist = await tableExists(db, 'clover_squads');
    if (squadsExist) {
        return db.all(
            `SELECT membership.id, membership.player_id, membership.squad_key,
                    membership.status, squad.name AS squad_name
             FROM clover_squad_memberships membership
             LEFT JOIN clover_squads squad ON squad.squad_key=membership.squad_key
             WHERE membership.status='active'
             ORDER BY membership.player_id, membership.id`
        );
    }

    return db.all(
        `SELECT id, player_id, squad_key, status, NULL AS squad_name
         FROM clover_squad_memberships
         WHERE status='active'
         ORDER BY player_id,id`
    );
}

async function readActiveMembershipsForPlayer(db, rawId) {
    const playerId = rawPlayerId(rawId);
    if (!playerId) return [];

    const rows = await readAllActiveMemberships(db);
    const matches = rows.filter((row) => samePlayer(row.player_id, playerId));

    // A membership row can only appear once, but dedupe defensively by id.
    const byId = new Map();
    for (const row of matches) byId.set(Number(row.id), row);
    return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

async function resolvePlayerSquadMembership(db, playerOrId) {
    const requestedId = rawPlayerId(playerOrId);
    const player = await readPlayerProjection(db, playerOrId);
    const playerId = rawPlayerId(player?.id || requestedId);

    if (!playerId) {
        return {
            ok: false,
            code: 'invalid_player',
            playerId: null,
            source: null,
            squadKey: null,
            squadName: null,
        };
    }

    const active = await readActiveMembershipsForPlayer(db, playerId);

    if (active.length > 1) {
        return {
            ok: false,
            code: 'multiple_active_memberships',
            playerId,
            source: 'canonical_conflict',
            squadKey: null,
            squadName: null,
            membershipIds: active.map((row) => Number(row.id)),
            activeSquadKeys: active.map((row) => normalizeSquadKey(row.squad_key)).filter(Boolean),
        };
    }

    const legacySquadKey = normalizeSquadKey(player?.esquadrao) || null;

    if (active.length === 1) {
        const membership = active[0];
        const canonicalSquadKey = normalizeSquadKey(membership.squad_key) || null;

        if (!canonicalSquadKey) {
            return {
                ok: false,
                code: 'invalid_canonical_squad',
                playerId,
                source: 'canonical_conflict',
                squadKey: null,
                squadName: null,
                membershipId: Number(membership.id),
            };
        }

        return {
            ok: true,
            code: 'canonical',
            playerId,
            requestedPlayerId: requestedId,
            membershipPlayerId: membership.player_id,
            source: 'canonical',
            squadKey: canonicalSquadKey,
            squadName: String(membership.squad_name || membership.squad_key || '').trim() || canonicalSquadKey,
            membershipId: Number(membership.id),
            legacySquadKey,
            canonicalSquadKey,
            mismatch: Boolean(legacySquadKey && legacySquadKey !== canonicalSquadKey),
            identityEquivalent: samePlayer(membership.player_id, playerId),
        };
    }

    return {
        ok: false,
        code: 'no_squad',
        playerId,
        requestedPlayerId: requestedId,
        source: null,
        squadKey: null,
        squadName: null,
        membershipId: null,
        legacySquadKey,
        canonicalSquadKey: null,
        mismatch: false,
    };
}

async function listEffectiveSquadMembers(db, rawSquadKey) {
    const squadKey = normalizeSquadKey(rawSquadKey);
    if (!squadKey) {
        return { ok: false, code: 'invalid_squad', squadKey: null, members: [] };
    }

    const players = await db.all('SELECT * FROM jogadores').catch(() => []);
    const memberships = await readAllActiveMemberships(db);

    const conflicts = [];
    const members = [];
    let canonicalCount = 0;
    let mismatchCount = 0;

    for (const rawPlayer of players) {
        const id = rawPlayerId(rawPlayer.id);
        if (!id) continue;

        const active = memberships.filter((row) => samePlayer(row.player_id, id));
        const uniqueActive = [...new Map(active.map((row) => [Number(row.id), row])).values()];

        if (uniqueActive.length > 1) {
            conflicts.push({
                playerId: id,
                membershipIds: uniqueActive.map((row) => Number(row.id)),
                activeSquadKeys: uniqueActive.map((row) => normalizeSquadKey(row.squad_key)).filter(Boolean),
            });
            continue;
        }

        const legacySquadKey = normalizeSquadKey(rawPlayer.esquadrao) || null;
        let effectiveSquadKey = null;
        let membershipSource = null;
        let membershipId = null;
        let canonicalSquadKey = null;

        if (uniqueActive.length === 1) {
            canonicalSquadKey = normalizeSquadKey(uniqueActive[0].squad_key) || null;
            effectiveSquadKey = canonicalSquadKey;
            membershipSource = 'canonical';
            membershipId = Number(uniqueActive[0].id);
            canonicalCount += 1;

            if (legacySquadKey && canonicalSquadKey && legacySquadKey !== canonicalSquadKey) {
                mismatchCount += 1;
            }
        }

        if (effectiveSquadKey !== squadKey) continue;

        members.push({
            ...rawPlayer,
            membership_source: membershipSource,
            membership_id: membershipId,
            canonical_squad_key: canonicalSquadKey,
            legacy_squad_key: legacySquadKey,
            membership_mismatch: Boolean(
                canonicalSquadKey
                && legacySquadKey
                && canonicalSquadKey !== legacySquadKey
            ),
        });
    }

    if (conflicts.length) {
        throw new SquadMembershipReadError(
            'multiple_active_memberships',
            'Há identidade com mais de um membership ativo; leitura de esquadrão bloqueada.',
            { squadKey, conflicts }
        );
    }

    return {
        ok: true,
        code: 'ok',
        squadKey,
        members,
        sourceStats: {
            canonical: canonicalCount,
            legacyFallback: 0,
            mismatches: mismatchCount,
        },
        conflicts: [],
    };
}

module.exports = {
    SquadMembershipReadError,
    listEffectiveSquadMembers,
    normalizeSquadKey,
    rawPlayerId,
    readActiveMembershipsForPlayer,
    readPlayerProjection,
    resolvePlayerSquadMembership,
    samePlayer,
    tableExists,
};
