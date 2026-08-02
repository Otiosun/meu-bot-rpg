'use strict';

const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');

const REQUIRED_TABLES = Object.freeze([
    'jogadores',
    'clover_squads',
    'clover_squad_memberships',
    'clover_squad_membership_events',
]);

function text(value) {
    return String(value ?? '').trim();
}

function playerKey(value) {
    return normalizeJid(value) || text(value).toLowerCase() || null;
}

function squadKey(value) {
    return normalizeSquadKey(value) || null;
}

function parseDate(value) {
    const raw = text(value);
    if (!raw) return null;
    const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function readSquadMembershipIntegritySnapshot(db) {
    const tables = Object.fromEntries(await Promise.all(REQUIRED_TABLES.map(async (name) => [
        name,
        await tableExists(db, name),
    ])));

    const [players, squads, memberships, events, activeIndex] = await Promise.all([
        tables.jogadores
            ? db.all('SELECT id, personagem_nome, esquadrao FROM jogadores ORDER BY id')
            : [],
        tables.clover_squads
            ? db.all('SELECT squad_key, name FROM clover_squads ORDER BY squad_key')
            : [],
        tables.clover_squad_memberships
            ? db.all(`SELECT id, squad_key, player_id, status, joined_at, ended_at,
                             changed_by, reason, metadata_json
                      FROM clover_squad_memberships
                      ORDER BY player_id, joined_at, id`)
            : [],
        tables.clover_squad_membership_events
            ? db.all(`SELECT id, membership_id, squad_key, player_id, action,
                             performed_by, reason, created_at, metadata_json
                      FROM clover_squad_membership_events
                      ORDER BY id`)
            : [],
        db.get(
            `SELECT name, sql
             FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_clover_squad_memberships_active_player'`
        ),
    ]);

    return {
        queryOnlySafe: true,
        write: false,
        tables,
        players,
        squads,
        memberships,
        events,
        activeUniqueIndex: {
            exists: Boolean(activeIndex?.name),
            sql: activeIndex?.sql || null,
            valid: Boolean(
                activeIndex?.name
                && /UNIQUE\s+INDEX/i.test(activeIndex.sql || '')
                && /player_id/i.test(activeIndex.sql || '')
                && /WHERE\s+status\s*=\s*['"]active['"]/i.test(activeIndex.sql || '')
            ),
        },
    };
}

function finding(severity, code, message, details = {}) {
    return { severity, code, message, details };
}

function proposal(kind, playerId, details = {}) {
    return { kind, playerId, ...details };
}

function classifySquadMembershipIntegrity(snapshot) {
    const findings = [];
    const automaticCandidates = [];
    const manualRequired = [];
    const players = new Map();
    const squads = new Map();
    const membershipsByPlayer = new Map();
    const membershipsById = new Map();

    for (const row of snapshot.players || []) {
        const id = playerKey(row.id);
        if (!id) continue;
        players.set(id, {
            ...row,
            id,
            legacySquadKey: squadKey(row.esquadrao),
        });
    }
    for (const row of snapshot.squads || []) {
        const key = squadKey(row.squad_key || row.name);
        if (key) squads.set(key, { ...row, squadKey: key });
    }
    for (const row of snapshot.memberships || []) {
        const normalized = {
            ...row,
            id: Number(row.id),
            playerId: playerKey(row.player_id),
            squadKey: squadKey(row.squad_key),
            status: text(row.status).toLowerCase(),
        };
        membershipsById.set(normalized.id, normalized);
        if (!membershipsByPlayer.has(normalized.playerId)) membershipsByPlayer.set(normalized.playerId, []);
        membershipsByPlayer.get(normalized.playerId).push(normalized);
    }

    if (!snapshot.tables?.clover_squad_memberships) {
        findings.push(finding(
            players.size ? 'critical' : 'warning',
            'membership_table_missing',
            'A tabela canônica de vínculos de esquadrão não existe.',
            { legacyPlayerCount: [...players.values()].filter((player) => player.legacySquadKey).length }
        ));
    } else if (!snapshot.activeUniqueIndex?.valid) {
        findings.push(finding(
            'critical',
            'active_membership_unique_index_missing',
            'O banco não possui a trava válida de um único vínculo ativo por personagem.',
            { indexSql: snapshot.activeUniqueIndex?.sql || null }
        ));
    }

    const subjectIds = new Set([...players.keys(), ...membershipsByPlayer.keys()].filter(Boolean));
    for (const id of [...subjectIds].sort()) {
        const player = players.get(id) || null;
        const memberships = membershipsByPlayer.get(id) || [];
        const active = memberships.filter((membership) => membership.status === 'active');
        const legacyKey = player?.legacySquadKey || null;

        if (!player) {
            findings.push(finding(
                'critical',
                'membership_unknown_player',
                'Existe vínculo para um personagem inexistente.',
                { playerId: id, membershipIds: memberships.map((membership) => membership.id) }
            ));
            manualRequired.push(proposal('resolve_unknown_player', id, {
                membershipIds: memberships.map((membership) => membership.id),
            }));
        }

        if (active.length > 1) {
            findings.push(finding(
                'critical',
                'multiple_active_memberships',
                'O personagem possui mais de um vínculo ativo.',
                {
                    playerId: id,
                    memberships: active.map((membership) => ({
                        id: membership.id,
                        squadKey: membership.squadKey,
                    })),
                }
            ));
            manualRequired.push(proposal('resolve_multiple_active_memberships', id, {
                membershipIds: active.map((membership) => membership.id),
            }));
        }

        for (const membership of memberships) {
            if (!membership.squadKey || !squads.has(membership.squadKey)) {
                findings.push(finding(
                    'critical',
                    'membership_unknown_squad',
                    'O vínculo aponta para um esquadrão inexistente.',
                    { playerId: id, membershipId: membership.id, squadKey: membership.squadKey }
                ));
                manualRequired.push(proposal('resolve_unknown_squad', id, {
                    membershipId: membership.id,
                    squadKey: membership.squadKey,
                }));
            }

            const joinedAt = parseDate(membership.joined_at);
            const endedAt = parseDate(membership.ended_at);
            if (membership.status === 'active' && membership.ended_at) {
                findings.push(finding(
                    'critical',
                    'active_membership_has_end',
                    'Um vínculo ativo possui data de encerramento.',
                    { playerId: id, membershipId: membership.id, endedAt: membership.ended_at }
                ));
            }
            if (membership.status !== 'active' && !membership.ended_at) {
                findings.push(finding(
                    'warning',
                    'inactive_membership_without_end',
                    'Um vínculo encerrado não possui data de encerramento.',
                    { playerId: id, membershipId: membership.id, status: membership.status }
                ));
            }
            if (joinedAt && endedAt && endedAt < joinedAt) {
                findings.push(finding(
                    'critical',
                    'membership_invalid_period',
                    'A data de encerramento é anterior à entrada.',
                    {
                        playerId: id,
                        membershipId: membership.id,
                        joinedAt: membership.joined_at,
                        endedAt: membership.ended_at,
                    }
                ));
            }
        }

        if (active.length === 1 && player) {
            const activeKey = active[0].squadKey;
            if (!legacyKey) {
                findings.push(finding(
                    'critical',
                    'active_membership_without_legacy_projection',
                    'O vínculo ativo existe, mas jogadores.esquadrao está vazio.',
                    { playerId: id, membershipId: active[0].id, activeSquadKey: activeKey }
                ));
                automaticCandidates.push(proposal('sync_legacy_projection_from_active', id, {
                    membershipId: active[0].id,
                    squadKey: activeKey,
                }));
            } else if (legacyKey !== activeKey) {
                findings.push(finding(
                    'critical',
                    'membership_legacy_mismatch',
                    'O vínculo ativo e jogadores.esquadrao apontam para esquadrões diferentes.',
                    {
                        playerId: id,
                        membershipId: active[0].id,
                        activeSquadKey: activeKey,
                        legacySquadKey: legacyKey,
                    }
                ));
                manualRequired.push(proposal('resolve_membership_legacy_mismatch', id, {
                    membershipId: active[0].id,
                    activeSquadKey: activeKey,
                    legacySquadKey: legacyKey,
                }));
            }
        }

        if (active.length === 0 && player && legacyKey) {
            if (!squads.has(legacyKey)) {
                findings.push(finding(
                    'critical',
                    'legacy_membership_unknown_squad',
                    'jogadores.esquadrao aponta para um esquadrão inexistente.',
                    { playerId: id, legacySquadKey: legacyKey }
                ));
                manualRequired.push(proposal('resolve_legacy_unknown_squad', id, { legacySquadKey: legacyKey }));
            } else {
                findings.push(finding(
                    'warning',
                    'legacy_membership_without_active_record',
                    'O personagem possui esquadrão legado, mas não possui vínculo ativo canônico.',
                    { playerId: id, legacySquadKey: legacyKey }
                ));
                automaticCandidates.push(proposal('create_active_membership_from_legacy', id, {
                    squadKey: legacyKey,
                }));
            }
        }
    }

    for (const event of snapshot.events || []) {
        const membershipId = event.membership_id === null || event.membership_id === undefined
            ? null
            : Number(event.membership_id);
        if (membershipId !== null && !membershipsById.has(membershipId)) {
            findings.push(finding(
                'warning',
                'membership_event_orphan',
                'Um evento aponta para vínculo inexistente.',
                { eventId: Number(event.id), membershipId }
            ));
        }
    }

    const counts = findings.reduce((summary, item) => {
        summary[item.severity] = (summary[item.severity] || 0) + 1;
        summary[item.code] = (summary[item.code] || 0) + 1;
        return summary;
    }, {});

    return {
        write: false,
        queryOnlySafe: true,
        summary: {
            playerCount: players.size,
            squadCount: squads.size,
            membershipCount: (snapshot.memberships || []).length,
            activeMembershipCount: (snapshot.memberships || []).filter((row) => text(row.status).toLowerCase() === 'active').length,
            eventCount: (snapshot.events || []).length,
            findingCount: findings.length,
            criticalCount: counts.critical || 0,
            warningCount: counts.warning || 0,
            automaticCandidateCount: automaticCandidates.length,
            manualRequiredCount: manualRequired.length,
            canAdvance: (counts.critical || 0) === 0,
        },
        findings,
        repairPlan: {
            automaticCandidates,
            manualRequired,
            executed: false,
        },
    };
}

async function buildSquadMembershipIntegrityReport(db) {
    const snapshot = await readSquadMembershipIntegritySnapshot(db);
    return {
        generatedAt: new Date().toISOString(),
        snapshot: {
            tables: snapshot.tables,
            activeUniqueIndex: snapshot.activeUniqueIndex,
        },
        ...classifySquadMembershipIntegrity(snapshot),
    };
}

module.exports = {
    REQUIRED_TABLES,
    buildSquadMembershipIntegrityReport,
    classifySquadMembershipIntegrity,
    parseDate,
    readSquadMembershipIntegritySnapshot,
    tableExists,
};
