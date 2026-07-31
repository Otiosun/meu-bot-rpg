'use strict';

const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');

function text(value) {
    return String(value ?? '').trim();
}

function playerId(value) {
    return normalizeJid(value) || text(value).toLowerCase() || null;
}

function squadKey(value) {
    return normalizeSquadKey(value) || null;
}

function displayName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.id]
        .map(text)
        .find((value) => value && value !== '-') || 'Personagem';
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function readSquadMembershipSourceSnapshot(db) {
    const [playersExist, squadsExist, membershipsExist] = await Promise.all([
        tableExists(db, 'jogadores'),
        tableExists(db, 'clover_squads'),
        tableExists(db, 'clover_squad_memberships'),
    ]);

    const [players, squads, memberships] = await Promise.all([
        playersExist
            ? db.all(`SELECT id, nome, display_name, personagem_nome, esquadrao,
                             estrelas, patente, jogo_status, ficha_status
                      FROM jogadores
                      ORDER BY id`)
            : [],
        squadsExist
            ? db.all('SELECT squad_key, name FROM clover_squads ORDER BY squad_key')
            : [],
        membershipsExist
            ? db.all(`SELECT id, squad_key, player_id, status, joined_at, ended_at
                      FROM clover_squad_memberships
                      WHERE status = 'active'
                      ORDER BY player_id, id`)
            : [],
    ]);

    return {
        write: false,
        queryOnlySafe: true,
        tables: {
            jogadores: playersExist,
            clover_squads: squadsExist,
            clover_squad_memberships: membershipsExist,
        },
        players,
        squads,
        memberships,
    };
}

function classifyPlayerMembership({ player, activeMemberships, knownSquads }) {
    const legacySquadKey = squadKey(player?.esquadrao);
    const activeKeys = [...new Set((activeMemberships || []).map((row) => squadKey(row.squad_key)).filter(Boolean))];
    const canonicalSquadKey = activeKeys.length === 1 ? activeKeys[0] : null;
    let state = 'none';
    let severity = 'none';

    if (activeMemberships.length > 1 || activeKeys.length > 1) {
        state = 'multiple_active';
        severity = 'critical';
    } else if (canonicalSquadKey && legacySquadKey && canonicalSquadKey !== legacySquadKey) {
        state = 'mismatch';
        severity = 'critical';
    } else if (canonicalSquadKey && !legacySquadKey) {
        state = 'canonical_only';
        severity = 'critical';
    } else if (!canonicalSquadKey && legacySquadKey) {
        state = 'legacy_only';
        severity = 'warning';
    } else if (canonicalSquadKey && legacySquadKey === canonicalSquadKey) {
        state = 'consistent';
    }

    const unknownSquads = [...new Set([
        legacySquadKey,
        ...activeKeys,
    ].filter((key) => key && !knownSquads.has(key)))];
    if (unknownSquads.length) severity = 'critical';

    return {
        playerId: playerId(player?.id || activeMemberships[0]?.player_id),
        characterName: displayName(player || { id: activeMemberships[0]?.player_id }),
        state,
        severity,
        divergent: state !== 'none' && state !== 'consistent',
        legacySquadKey,
        canonicalSquadKey,
        activeMembershipIds: activeMemberships.map((row) => Number(row.id)),
        activeSquadKeys: activeKeys,
        unknownSquadKeys: unknownSquads,
        consumerImpact: {
            listSquadMembersChanges: legacySquadKey !== canonicalSquadKey,
            resolveSquadByPlayerChanges: legacySquadKey !== canonicalSquadKey,
            participationMemberSetChanges: legacySquadKey !== canonicalSquadKey,
        },
    };
}

function buildSquadMembershipReadShadow(snapshot) {
    const players = new Map();
    const squads = new Map();
    const membershipsByPlayer = new Map();

    for (const row of snapshot.players || []) {
        const id = playerId(row.id);
        if (id) players.set(id, { ...row, id });
    }
    for (const row of snapshot.squads || []) {
        const key = squadKey(row.squad_key || row.name);
        if (key) squads.set(key, { ...row, squadKey: key });
    }
    for (const row of snapshot.memberships || []) {
        const id = playerId(row.player_id);
        if (!id) continue;
        if (!membershipsByPlayer.has(id)) membershipsByPlayer.set(id, []);
        membershipsByPlayer.get(id).push(row);
    }

    const subjects = new Set([...players.keys(), ...membershipsByPlayer.keys()]);
    const playerReports = [...subjects].sort().map((id) => classifyPlayerMembership({
        player: players.get(id) || { id },
        activeMemberships: membershipsByPlayer.get(id) || [],
        knownSquads: squads,
    }));

    const allSquadKeys = new Set(squads.keys());
    for (const report of playerReports) {
        if (report.legacySquadKey) allSquadKeys.add(report.legacySquadKey);
        for (const key of report.activeSquadKeys) allSquadKeys.add(key);
    }

    const squadReports = [...allSquadKeys].sort().map((key) => {
        const legacyMembers = playerReports
            .filter((report) => report.legacySquadKey === key)
            .map((report) => report.playerId)
            .sort();
        const canonicalMembers = playerReports
            .filter((report) => report.canonicalSquadKey === key)
            .map((report) => report.playerId)
            .sort();
        const legacySet = new Set(legacyMembers);
        const canonicalSet = new Set(canonicalMembers);
        const onlyLegacy = legacyMembers.filter((id) => !canonicalSet.has(id));
        const onlyCanonical = canonicalMembers.filter((id) => !legacySet.has(id));
        return {
            squadKey: key,
            squadName: squads.get(key)?.name || key,
            legacyMembers,
            canonicalMembers,
            onlyLegacy,
            onlyCanonical,
            membershipSetChanges: onlyLegacy.length > 0 || onlyCanonical.length > 0,
        };
    });

    const criticalCount = playerReports.filter((report) => report.severity === 'critical').length;
    const warningCount = playerReports.filter((report) => report.severity === 'warning').length;
    const divergentPlayers = playerReports.filter((report) => report.divergent);
    const changedSquads = squadReports.filter((report) => report.membershipSetChanges);

    return {
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        tables: snapshot.tables || {},
        summary: {
            playerCount: playerReports.length,
            squadCount: squadReports.length,
            divergentPlayerCount: divergentPlayers.length,
            changedSquadCount: changedSquads.length,
            criticalCount,
            warningCount,
            safeToSwitchConsumers: criticalCount === 0 && divergentPlayers.length === 0,
        },
        players: playerReports,
        squads: squadReports,
    };
}

async function buildSquadMembershipConsumerShadowReport(db) {
    return buildSquadMembershipReadShadow(await readSquadMembershipSourceSnapshot(db));
}

function resolvePlayerSquadShadow(report, rawPlayerId) {
    const id = playerId(rawPlayerId);
    const player = (report.players || []).find((item) => item.playerId === id) || null;
    if (!player) return null;
    return {
        playerId: id,
        legacySquadKey: player.legacySquadKey,
        canonicalSquadKey: player.canonicalSquadKey,
        changes: player.legacySquadKey !== player.canonicalSquadKey,
        state: player.state,
    };
}

function squadMemberIdsShadow(report, rawSquadKey) {
    const key = squadKey(rawSquadKey);
    const squad = (report.squads || []).find((item) => item.squadKey === key) || null;
    return squad ? {
        squadKey: key,
        legacyMemberIds: [...squad.legacyMembers],
        canonicalMemberIds: [...squad.canonicalMembers],
        onlyLegacy: [...squad.onlyLegacy],
        onlyCanonical: [...squad.onlyCanonical],
        changes: squad.membershipSetChanges,
    } : null;
}

module.exports = {
    buildSquadMembershipConsumerShadowReport,
    buildSquadMembershipReadShadow,
    classifyPlayerMembership,
    displayName,
    readSquadMembershipSourceSnapshot,
    resolvePlayerSquadShadow,
    squadMemberIdsShadow,
    tableExists,
};
