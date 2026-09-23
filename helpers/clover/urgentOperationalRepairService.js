'use strict';

const ADMIN_ROLE_KEYS = Object.freeze(['admin', 'evaluator', 'narrator', 'assistant']);
const REPAIR_KEY = 'urgent-operational-drift-2026-08-06-v1';
const REPAIR_ACTOR = 'system:urgent-operational-repair-2026-08-06';
const REPAIR_REASON = 'Sincronização segura entre projeções legadas e fontes canônicas após auditoria do banco vivo.';

class UrgentOperationalRepairError extends Error {
    constructor(message, code = 'urgent_operational_repair_error', details = null) {
        super(message || code);
        this.name = 'UrgentOperationalRepairError';
        this.code = code;
        this.details = details;
    }
}

function cleanText(value) {
    return String(value || '').trim();
}

function normalizeText(value) {
    return cleanText(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function normalizeSquadKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeIdentity(value) {
    return cleanText(value).toLowerCase();
}

function filled(value) {
    const text = cleanText(value);
    return text && text !== '-' ? text : null;
}

function databaseDate(value) {
    if (value instanceof Date) return value;
    const raw = cleanText(value);
    if (!raw) return null;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
        ? `${raw.replace(' ', 'T')}Z`
        : raw;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function canonicalGrantEffective(row, referenceDate = new Date()) {
    if (!row || cleanText(row.status) !== 'active') return false;
    const now = databaseDate(referenceDate);
    if (!now) return false;
    const starts = databaseDate(row.valid_from || row.created_at);
    const ends = databaseDate(row.valid_until);
    if (starts && starts > now) return false;
    if (ends && ends <= now) return false;
    return true;
}

function playerEligibleForMembership(player = {}) {
    return Boolean(
        filled(player.personagem_nome)
        && normalizeText(player.ficha_status) === 'aprovada'
        && normalizeText(player.jogo_status) === 'liberado'
        && normalizeText(player.identity_status || 'active') === 'active'
        && normalizeText(player.lifecycle_status || 'active') === 'active'
        && Number(player.is_shadow || 0) === 0
        && !filled(player.merged_into)
    );
}

function groupBy(rows, keyFn) {
    const result = new Map();
    for (const row of rows || []) {
        const key = keyFn(row);
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(row);
    }
    return result;
}

function countBy(rows, keyFn) {
    const result = {};
    for (const row of rows || []) {
        const key = String(keyFn(row) || 'unknown');
        result[key] = (result[key] || 0) + 1;
    }
    return result;
}

async function tableExists(db, name) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [name]
    );
    return Boolean(row?.found);
}

async function readOptionalRows(db, tableName, sql, params = []) {
    if (!await tableExists(db, tableName)) return [];
    return db.all(sql, params);
}

async function readUrgentOperationalSnapshot(db) {
    const tables = {};
    for (const name of [
        'jogadores',
        'clover_squads',
        'clover_squad_memberships',
        'clover_squad_membership_events',
        'clover_admin_roles',
        'clover_role_grants',
        'clover_captain_profiles',
        'clover_admin_operations',
        'clover_reward_packages',
        'clover_reward_grants',
        'clover_raids',
        'clover_raid_participants',
        'clover_raid_rewards',
        'clover_player_aliases',
        'clover_player_target_aliases',
    ]) {
        tables[name] = await tableExists(db, name);
    }

    const required = [
        'jogadores',
        'clover_squads',
        'clover_squad_memberships',
        'clover_squad_membership_events',
        'clover_admin_roles',
        'clover_role_grants',
    ];
    const missingRequired = required.filter((name) => !tables[name]);

    const players = tables.jogadores ? await db.all(`
        SELECT id, nome, display_name, personagem_nome, esquadrao,
               ficha_status, jogo_status, identity_status, lifecycle_status,
               is_shadow, merged_into, canonical_player_id, archived_at
        FROM jogadores
        WHERE COALESCE(TRIM(id), '') <> ''
        ORDER BY id
    `) : [];

    const squads = tables.clover_squads ? await db.all(`
        SELECT squad_key, name, captain_name, captain_player_id,
               vice_captain_player_id, group_id
        FROM clover_squads
        ORDER BY squad_key
    `) : [];

    const memberships = tables.clover_squad_memberships ? await db.all(`
        SELECT id, squad_key, player_id, status, joined_at, ended_at,
               changed_by, reason, metadata_json
        FROM clover_squad_memberships
        ORDER BY id
    `) : [];

    const adminRoles = tables.clover_admin_roles ? await db.all(`
        SELECT player_id, role, active, granted_by, granted_at, updated_at,
               revoked_by, revoked_at
        FROM clover_admin_roles
        ORDER BY player_id
    `) : [];

    const canonicalRoleGrants = tables.clover_role_grants ? await db.all(`
        SELECT id, subject_id, role_key, scope_type, scope_key, status,
               valid_from, valid_until, granted_by, grant_reason,
               origin_type, origin_ref, created_at, updated_at
        FROM clover_role_grants
        WHERE scope_type = 'global'
          AND scope_key = '*'
          AND role_key IN ('admin', 'evaluator', 'narrator', 'assistant')
        ORDER BY subject_id, role_key, id
    `) : [];

    const captainProfiles = await readOptionalRows(
        db,
        'clover_captain_profiles',
        `SELECT id, account_player_id, squad_key, persona_key, account_mode,
                character_name, rank, status, is_default, created_at, updated_at
         FROM clover_captain_profiles
         ORDER BY squad_key, id`
    );

    const adminOperations = await readOptionalRows(
        db,
        'clover_admin_operations',
        `SELECT id, code, status, title, reason, actor_id, created_at,
                simulated_at, applied_at, undone_at, updated_at, error_json
         FROM clover_admin_operations
         ORDER BY datetime(created_at) DESC, id DESC`
    );

    const rewardPackages = await readOptionalRows(
        db,
        'clover_reward_packages',
        `SELECT id, canonical_key, name, status, version, operation_code,
                created_at, updated_at
         FROM clover_reward_packages
         ORDER BY datetime(updated_at) DESC, id`
    );

    const rewardGrants = await readOptionalRows(
        db,
        'clover_reward_grants',
        `SELECT id, grant_key, package_id, package_version, player_id,
                operation_code, status, granted_at, undone_at
         FROM clover_reward_grants
         ORDER BY datetime(granted_at) DESC, id DESC`
    );

    const raids = await readOptionalRows(
        db,
        'clover_raids',
        `SELECT raid_key, code, name, status, scope_type, scope_squad_key,
                owner_player_id, salary_eligible, created_at, updated_at,
                started_at, finalization_at, completed_at, cancelled_at
         FROM clover_raids
         ORDER BY datetime(created_at) DESC, id DESC`
    );

    const raidParticipantCounts = await readOptionalRows(
        db,
        'clover_raid_participants',
        `SELECT raid_id, status, finalization_status, COUNT(*) AS total
         FROM clover_raid_participants
         GROUP BY raid_id, status, finalization_status`
    );

    const raidRewardCounts = await readOptionalRows(
        db,
        'clover_raid_rewards',
        `SELECT raid_id, status, COUNT(*) AS total
         FROM clover_raid_rewards
         GROUP BY raid_id, status`
    );

    const activeMembershipIndex = tables.clover_squad_memberships
        ? await db.get(`
            SELECT name, sql
            FROM sqlite_master
            WHERE type = 'index'
              AND name = 'idx_clover_squad_memberships_active_player'
        `)
        : null;

    return {
        tables,
        missingRequired,
        players,
        squads,
        memberships,
        adminRoles,
        canonicalRoleGrants,
        captainProfiles,
        adminOperations,
        rewardPackages,
        rewardGrants,
        raids,
        raidParticipantCounts,
        raidRewardCounts,
        activeMembershipIndex,
        write: false,
    };
}

function buildAdminPlan(snapshot, referenceDate) {
    const legacyBySubject = new Map(
        (snapshot.adminRoles || []).map((row) => [normalizeIdentity(row.player_id), row])
    );
    const effectiveCanonical = (snapshot.canonicalRoleGrants || [])
        .filter((row) => canonicalGrantEffective(row, referenceDate));
    const canonicalBySubject = groupBy(
        effectiveCanonical,
        (row) => normalizeIdentity(row.subject_id)
    );
    const subjects = new Set([
        ...legacyBySubject.keys(),
        ...canonicalBySubject.keys(),
    ]);

    const candidates = [];
    const matched = [];
    const legacyOnly = [];
    const canonicalOnly = [];
    const mismatches = [];
    const ambiguousCanonical = [];

    for (const subjectId of [...subjects].sort()) {
        const legacy = legacyBySubject.get(subjectId) || null;
        const legacyRole = Number(legacy?.active || 0) === 1
            && ADMIN_ROLE_KEYS.includes(cleanText(legacy.role))
            ? cleanText(legacy.role)
            : null;
        const canonicalRows = canonicalBySubject.get(subjectId) || [];
        const roles = [...new Set(canonicalRows.map((row) => cleanText(row.role_key)))].sort();

        if (!legacyRole && roles.length === 0) continue;
        if (roles.length > 1) {
            ambiguousCanonical.push({ subjectId, legacyRole, canonicalRoles: roles });
            continue;
        }
        if (legacyRole && roles.length === 0) {
            legacyOnly.push({ subjectId, legacyRole });
            continue;
        }
        if (!legacyRole && roles.length === 1) {
            const canonicalRow = canonicalRows.find((row) => row.role_key === roles[0]);
            const item = {
                subjectId,
                role: roles[0],
                canonicalGrantId: Number(canonicalRow.id),
                grantedBy: canonicalRow.granted_by || REPAIR_ACTOR,
                grantedAt: canonicalRow.valid_from || canonicalRow.created_at || null,
                inactiveLegacyExists: Boolean(legacy),
            };
            canonicalOnly.push(item);
            candidates.push(item);
            continue;
        }
        if (legacyRole === roles[0]) {
            matched.push({ subjectId, role: legacyRole });
        } else {
            mismatches.push({ subjectId, legacyRole, canonicalRole: roles[0] });
        }
    }

    return {
        candidates,
        matched,
        legacyOnly,
        canonicalOnly,
        mismatches,
        ambiguousCanonical,
        blockingCount: legacyOnly.length + mismatches.length + ambiguousCanonical.length,
    };
}

function buildSquadPlan(snapshot, approvedMembershipMap = []) {
    const playersById = new Map(
        (snapshot.players || []).map((row) => [normalizeIdentity(row.id), row])
    );
    const squadsByKey = new Map();
    for (const row of snapshot.squads || []) {
        const key = normalizeSquadKey(row.squad_key || row.name);
        if (key) squadsByKey.set(key, row);
        const nameKey = normalizeSquadKey(row.name);
        if (nameKey) squadsByKey.set(nameKey, row);
    }

    const activeMemberships = (snapshot.memberships || [])
        .filter((row) => cleanText(row.status) === 'active');
    const activeByPlayer = groupBy(
        activeMemberships,
        (row) => normalizeIdentity(row.player_id)
    );
    const approvedByPlayer = new Map(
        (approvedMembershipMap || []).map((item) => [
            normalizeIdentity(item.playerId),
            normalizeSquadKey(item.squadKey),
        ])
    );

    const duplicateActive = [];
    for (const [playerId, rows] of activeByPlayer.entries()) {
        if (rows.length > 1) {
            duplicateActive.push({
                playerId,
                membershipIds: rows.map((row) => Number(row.id)),
                squadKeys: rows.map((row) => normalizeSquadKey(row.squad_key)),
            });
        }
    }

    const candidates = [];
    const automaticCandidates = [];
    const requiresApprovedMap = [];
    const approvedTransferRequired = [];
    const matched = [];
    const ineligibleLegacy = [];
    const unknownLegacySquad = [];
    const mismatches = [];

    for (const player of snapshot.players || []) {
        const playerId = normalizeIdentity(player.id);
        const legacyName = filled(player.esquadrao);
        if (!legacyName) continue;
        const legacyKey = normalizeSquadKey(legacyName);
        const squad = squadsByKey.get(legacyKey) || null;
        const activeRows = activeByPlayer.get(playerId) || [];

        if (!squad) {
            unknownLegacySquad.push({
                playerId,
                characterName: filled(player.personagem_nome) || filled(player.nome),
                legacySquad: legacyName,
                normalizedKey: legacyKey,
            });
            continue;
        }
        if (!playerEligibleForMembership(player)) {
            ineligibleLegacy.push({
                playerId,
                characterName: filled(player.personagem_nome) || filled(player.nome),
                squadKey: squad.squad_key,
                sheetStatus: player.ficha_status || null,
                gameStatus: player.jogo_status || null,
                identityStatus: player.identity_status || null,
                lifecycleStatus: player.lifecycle_status || null,
                isShadow: Number(player.is_shadow || 0),
                mergedInto: player.merged_into || null,
            });
            continue;
        }
        if (activeRows.length > 1) continue;
        if (activeRows.length === 1) {
            const activeKey = normalizeSquadKey(activeRows[0].squad_key);
            if (activeKey === normalizeSquadKey(squad.squad_key)) {
                matched.push({
                    playerId,
                    characterName: filled(player.personagem_nome) || filled(player.nome),
                    squadKey: squad.squad_key,
                    membershipId: Number(activeRows[0].id),
                });
            } else {
                mismatches.push({
                    playerId,
                    characterName: filled(player.personagem_nome) || filled(player.nome),
                    legacySquadKey: squad.squad_key,
                    activeSquadKey: activeRows[0].squad_key,
                    membershipId: Number(activeRows[0].id),
                });
            }
            continue;
        }

        const item = {
            playerId,
            characterName: filled(player.personagem_nome) || filled(player.nome),
            squadKey: squad.squad_key,
            squadName: squad.name,
        };
        candidates.push(item);
        const approvedTarget = approvedByPlayer.get(playerId) || null;
        if (!approvedTarget) {
            requiresApprovedMap.push(item);
        } else if (approvedTarget !== normalizeSquadKey(squad.squad_key)) {
            approvedTransferRequired.push({
                ...item,
                approvedSquadKey: approvedTarget,
            });
        } else {
            automaticCandidates.push(item);
        }
    }

    const activeWithoutLegacy = [];
    const activeOrphans = [];
    for (const membership of activeMemberships) {
        const playerId = normalizeIdentity(membership.player_id);
        const player = playersById.get(playerId);
        const squad = squadsByKey.get(normalizeSquadKey(membership.squad_key));
        if (!player || !squad) {
            activeOrphans.push({
                membershipId: Number(membership.id),
                playerId,
                squadKey: membership.squad_key,
                missingPlayer: !player,
                missingSquad: !squad,
            });
            continue;
        }
        if (!filled(player.esquadrao)) {
            activeWithoutLegacy.push({
                membershipId: Number(membership.id),
                playerId,
                activeSquadKey: membership.squad_key,
            });
        }
    }

    const indexSql = cleanText(snapshot.activeMembershipIndex?.sql).toLowerCase();
    const uniqueIndexValid = Boolean(
        snapshot.activeMembershipIndex
        && indexSql.includes('unique')
        && indexSql.includes("where status = 'active'")
    );

    return {
        candidates,
        automaticCandidates,
        requiresApprovedMap,
        approvedTransferRequired,
        matched,
        duplicateActive,
        ineligibleLegacy,
        unknownLegacySquad,
        mismatches,
        activeWithoutLegacy,
        activeOrphans,
        uniqueIndexValid,
        blockingCount:
            duplicateActive.length
            + ineligibleLegacy.length
            + unknownLegacySquad.length
            + mismatches.length
            + activeWithoutLegacy.length
            + activeOrphans.length
            + (uniqueIndexValid ? 0 : 1),
    };
}

function buildCaptainAudit(snapshot) {
    const playersById = new Map(
        (snapshot.players || []).map((row) => [normalizeIdentity(row.id), row])
    );
    const squadsByKey = new Map(
        (snapshot.squads || []).map((row) => [normalizeSquadKey(row.squad_key), row])
    );
    const activeProfiles = (snapshot.captainProfiles || [])
        .filter((row) => cleanText(row.status) === 'active');
    const profileBySquad = groupBy(activeProfiles, (row) => normalizeSquadKey(row.squad_key));

    const profileFindings = [];
    for (const profile of activeProfiles) {
        const squadKey = normalizeSquadKey(profile.squad_key);
        const squad = squadsByKey.get(squadKey);
        const accountId = normalizeIdentity(profile.account_player_id);
        const player = playersById.get(accountId);
        if (!squad || !player) {
            profileFindings.push({
                code: !squad ? 'captain_profile_unknown_squad' : 'captain_profile_unknown_player',
                squadKey,
                accountPlayerId: accountId,
                profileId: Number(profile.id),
            });
            continue;
        }
        const registeredCaptain = normalizeIdentity(squad.captain_player_id);
        if (registeredCaptain && registeredCaptain !== accountId) {
            profileFindings.push({
                code: 'captain_profile_squad_mismatch',
                squadKey,
                accountPlayerId: accountId,
                registeredCaptainPlayerId: registeredCaptain,
                profileId: Number(profile.id),
            });
        }
    }

    const manualMissingCaptainIdentity = [];
    const squadProfileFindings = [];
    for (const squad of snapshot.squads || []) {
        const key = normalizeSquadKey(squad.squad_key);
        const captainId = normalizeIdentity(squad.captain_player_id);
        const profiles = profileBySquad.get(key) || [];
        if (filled(squad.captain_name) && !captainId) {
            manualMissingCaptainIdentity.push({
                squadKey: squad.squad_key,
                squadName: squad.name,
                captainName: squad.captain_name,
            });
        }
        if (captainId && profiles.length === 0) {
            squadProfileFindings.push({
                code: 'captain_without_active_profile',
                squadKey: squad.squad_key,
                captainPlayerId: captainId,
            });
        }
        if (profiles.length > 1) {
            squadProfileFindings.push({
                code: 'multiple_active_captain_profiles',
                squadKey: squad.squad_key,
                profileIds: profiles.map((row) => Number(row.id)),
            });
        }
    }

    return {
        activeProfileCount: activeProfiles.length,
        profileFindings,
        squadProfileFindings,
        manualMissingCaptainIdentity,
        automaticRepairCount: 0,
    };
}

function buildOperationsAudit(snapshot, referenceDate) {
    const now = databaseDate(referenceDate) || new Date();
    const stale = [];
    for (const operation of snapshot.adminOperations || []) {
        const status = cleanText(operation.status);
        if (!['draft', 'simulated', 'failed', 'partially_applied'].includes(status)) continue;
        const updated = databaseDate(operation.updated_at || operation.created_at);
        const ageHours = updated ? Math.floor((now.getTime() - updated.getTime()) / 3600000) : null;
        if (ageHours === null || ageHours >= 24) {
            stale.push({
                code: operation.code,
                status,
                title: operation.title,
                ageHours,
                updatedAt: operation.updated_at || operation.created_at || null,
            });
        }
    }
    return {
        statusCounts: countBy(snapshot.adminOperations || [], (row) => row.status),
        stale,
        rewardPackageCount: (snapshot.rewardPackages || []).length,
        rewardGrantStatusCounts: countBy(snapshot.rewardGrants || [], (row) => row.status),
        write: false,
    };
}

function buildRaidAudit(snapshot, referenceDate) {
    const now = databaseDate(referenceDate) || new Date();
    const stuck = [];
    const active = [];
    for (const raid of snapshot.raids || []) {
        const status = cleanText(raid.status);
        if (['in_progress', 'active', 'started'].includes(status)) {
            active.push({
                raidKey: raid.raid_key || raid.code,
                name: raid.name,
                status,
                scopeType: raid.scope_type,
                scopeSquadKey: raid.scope_squad_key || null,
                updatedAt: raid.updated_at,
            });
        }
        if (status === 'finalization') {
            const since = databaseDate(raid.finalization_at || raid.updated_at);
            const ageHours = since ? Math.floor((now.getTime() - since.getTime()) / 3600000) : null;
            if (ageHours === null || ageHours >= 24) {
                stuck.push({
                    raidKey: raid.raid_key || raid.code,
                    name: raid.name,
                    status,
                    ageHours,
                    finalizationAt: raid.finalization_at || null,
                });
            }
        }
    }
    return {
        statusCounts: countBy(snapshot.raids || [], (row) => row.status),
        active,
        stuckFinalization: stuck,
        write: false,
    };
}

function buildIdentityAudit(snapshot) {
    const players = snapshot.players || [];
    const activeReleased = players.filter((player) => (
        normalizeText(player.identity_status || 'active') === 'active'
        && normalizeText(player.lifecycle_status || 'active') === 'active'
        && Number(player.is_shadow || 0) === 0
        && !filled(player.merged_into)
        && normalizeText(player.jogo_status) === 'liberado'
    ));
    const canonicalMissing = activeReleased.filter((player) => !filled(player.canonical_player_id));
    return {
        playerCount: players.length,
        activeReleasedCount: activeReleased.length,
        canonicalPlayerIdMissingCount: canonicalMissing.length,
        canonicalPlayerIdMissing: canonicalMissing.map((player) => ({
            playerId: player.id,
            characterName: filled(player.personagem_nome) || filled(player.nome),
        })),
        automaticRepairCount: 0,
        note: 'Identidades específicas não são fundidas ou reatribuídas sem evidência individual.',
        write: false,
    };
}

function buildUrgentOperationalPlan(snapshot, options = {}) {
    const referenceDate = options.referenceDate || new Date();
    const admin = buildAdminPlan(snapshot, referenceDate);
    const squads = buildSquadPlan(snapshot, options.approvedMembershipMap || []);
    const captains = buildCaptainAudit(snapshot);
    const operations = buildOperationsAudit(snapshot, referenceDate);
    const raids = buildRaidAudit(snapshot, referenceDate);
    const identities = buildIdentityAudit(snapshot);
    const blockingReasons = [];

    if ((snapshot.missingRequired || []).length) {
        blockingReasons.push({
            code: 'required_tables_missing',
            tables: snapshot.missingRequired,
        });
    }
    if (admin.blockingCount) {
        blockingReasons.push({
            code: 'admin_projection_conflicts',
            count: admin.blockingCount,
        });
    }
    if ((options.approvedMembershipMap || []).length && squads.blockingCount) {
        blockingReasons.push({
            code: 'squad_membership_conflicts',
            count: squads.blockingCount,
        });
    }

    return {
        version: 'clover.urgent-operational-repair-plan.v1',
        generatedAt: new Date().toISOString(),
        referenceDate: databaseDate(referenceDate)?.toISOString() || null,
        repairKey: REPAIR_KEY,
        safeToApply: blockingReasons.length === 0,
        blockingReasons,
        summary: {
            adminProjectionCandidates: admin.candidates.length,
            squadMembershipCandidates: squads.automaticCandidates.length,
            squadMembershipReviewCount: squads.candidates.length,
            automaticRepairCount: admin.candidates.length + squads.automaticCandidates.length,
            manualCaptainIdentities: captains.manualMissingCaptainIdentity.length,
            staleAdminOperations: operations.stale.length,
            stuckRaids: raids.stuckFinalization.length,
            activeRaids: raids.active.length,
            identityRowsNeedingIndividualReview: identities.canonicalPlayerIdMissingCount,
        },
        admin,
        squads,
        captains,
        operations,
        raids,
        identities,
        write: false,
    };
}

async function ensureRepairReceiptSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_urgent_operational_repairs (
            repair_key TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
            actor_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            admin_rows INTEGER NOT NULL DEFAULT 0,
            membership_rows INTEGER NOT NULL DEFAULT 0,
            before_summary_json TEXT NOT NULL,
            after_summary_json TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
}

async function readEffectiveCanonicalAdminRows(db, subjectId) {
    return db.all(`
        SELECT id, subject_id, role_key, status, valid_from, valid_until,
               granted_by, created_at
        FROM clover_role_grants
        WHERE subject_id = ?
          AND scope_type = 'global'
          AND scope_key = '*'
          AND role_key IN ('admin', 'evaluator', 'narrator', 'assistant')
          AND status = 'active'
          AND datetime(COALESCE(valid_from, created_at)) <= datetime('now')
          AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
        ORDER BY role_key, id
    `, [subjectId]);
}

async function applyAdminCandidate(db, candidate) {
    const canonicalRows = await readEffectiveCanonicalAdminRows(db, candidate.subjectId);
    const roles = [...new Set(canonicalRows.map((row) => row.role_key))].sort();
    if (roles.length !== 1 || roles[0] !== candidate.role) {
        throw new UrgentOperationalRepairError(
            'O cargo canônico mudou entre a auditoria e a aplicação.',
            'admin_candidate_drift',
            { subjectId: candidate.subjectId, expectedRole: candidate.role, actualRoles: roles }
        );
    }

    const legacy = await db.get(
        'SELECT * FROM clover_admin_roles WHERE player_id = ?',
        [candidate.subjectId]
    );
    if (legacy && Number(legacy.active) === 1) {
        if (legacy.role === candidate.role) return { changed: false, reason: 'already_matched' };
        throw new UrgentOperationalRepairError(
            'A projeção legada ganhou outro cargo antes da aplicação.',
            'admin_legacy_drift',
            { subjectId: candidate.subjectId, expectedRole: candidate.role, actualRole: legacy.role }
        );
    }

    const canonical = canonicalRows.find((row) => row.role_key === candidate.role);
    await db.run(`
        INSERT INTO clover_admin_roles
        (player_id, role, active, granted_by, granted_at, updated_at,
         revoked_by, revoked_at)
        VALUES (?, ?, 1, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, NULL, NULL)
        ON CONFLICT(player_id) DO UPDATE SET
            role = excluded.role,
            active = 1,
            granted_by = excluded.granted_by,
            granted_at = excluded.granted_at,
            updated_at = CURRENT_TIMESTAMP,
            revoked_by = NULL,
            revoked_at = NULL
        WHERE clover_admin_roles.active <> 1
    `, [
        candidate.subjectId,
        candidate.role,
        canonical?.granted_by || REPAIR_ACTOR,
        canonical?.valid_from || canonical?.created_at || null,
    ]);
    return { changed: true };
}

async function applyMembershipCandidate(db, candidate) {
    const player = await db.get(`
        SELECT id, personagem_nome, esquadrao, ficha_status, jogo_status,
               identity_status, lifecycle_status, is_shadow, merged_into
        FROM jogadores
        WHERE id = ?
    `, [candidate.playerId]);
    if (!player) {
        throw new UrgentOperationalRepairError(
            'O personagem desapareceu antes da aplicação.',
            'membership_player_missing',
            { playerId: candidate.playerId }
        );
    }
    if (!playerEligibleForMembership(player)) {
        throw new UrgentOperationalRepairError(
            'A elegibilidade do personagem mudou antes da aplicação.',
            'membership_player_became_ineligible',
            { playerId: candidate.playerId }
        );
    }
    const legacyKey = normalizeSquadKey(player.esquadrao);
    if (legacyKey !== normalizeSquadKey(candidate.squadKey)) {
        throw new UrgentOperationalRepairError(
            'O esquadrão legado mudou antes da aplicação.',
            'membership_legacy_drift',
            { playerId: candidate.playerId, expected: candidate.squadKey, actual: legacyKey }
        );
    }
    const squad = await db.get(
        'SELECT squad_key, name FROM clover_squads WHERE squad_key = ?',
        [candidate.squadKey]
    );
    if (!squad) {
        throw new UrgentOperationalRepairError(
            'O esquadrão deixou de existir antes da aplicação.',
            'membership_squad_missing',
            { squadKey: candidate.squadKey }
        );
    }

    const activeRows = await db.all(`
        SELECT * FROM clover_squad_memberships
        WHERE player_id = ? AND status = 'active'
        ORDER BY id
    `, [candidate.playerId]);
    if (activeRows.length > 1) {
        throw new UrgentOperationalRepairError(
            'O personagem possui mais de um vínculo ativo.',
            'multiple_active_memberships',
            { playerId: candidate.playerId, membershipIds: activeRows.map((row) => row.id) }
        );
    }
    if (activeRows.length === 1) {
        if (normalizeSquadKey(activeRows[0].squad_key) === normalizeSquadKey(candidate.squadKey)) {
            return { changed: false, reason: 'already_matched', membershipId: Number(activeRows[0].id) };
        }
        throw new UrgentOperationalRepairError(
            'O personagem ganhou vínculo ativo com outro esquadrão antes da aplicação.',
            'active_membership_drift',
            {
                playerId: candidate.playerId,
                expected: candidate.squadKey,
                actual: activeRows[0].squad_key,
            }
        );
    }

    const metadata = JSON.stringify({
        source: 'legacy_membership_backfill',
        repairKey: REPAIR_KEY,
        preservedLegacySquad: player.esquadrao,
        eligibilityPolicy: {
            fichaStatus: 'aprovada',
            jogoStatus: 'liberado',
            activeIdentity: true,
        },
    });
    const inserted = await db.run(`
        INSERT INTO clover_squad_memberships
        (squad_key, player_id, status, joined_at, ended_at,
         changed_by, reason, metadata_json)
        VALUES (?, ?, 'active', CURRENT_TIMESTAMP, NULL, ?, ?, ?)
    `, [candidate.squadKey, candidate.playerId, REPAIR_ACTOR, REPAIR_REASON, metadata]);
    const membershipId = Number(inserted.lastID);
    await db.run(`
        INSERT INTO clover_squad_membership_events
        (membership_id, squad_key, player_id, action, performed_by,
         reason, created_at, metadata_json)
        VALUES (?, ?, ?, 'added', ?, ?, CURRENT_TIMESTAMP, ?)
    `, [
        membershipId,
        candidate.squadKey,
        candidate.playerId,
        REPAIR_ACTOR,
        REPAIR_REASON,
        metadata,
    ]);
    return { changed: true, membershipId };
}

async function applyUrgentOperationalPlan(db, plan, options = {}) {
    if (!plan?.safeToApply) {
        throw new UrgentOperationalRepairError(
            'O plano contém conflitos e não pode ser aplicado automaticamente.',
            'repair_plan_unsafe',
            { blockingReasons: plan?.blockingReasons || [] }
        );
    }

    const actorId = cleanText(options.actorId) || REPAIR_ACTOR;
    const reason = cleanText(options.reason) || REPAIR_REASON;
    let adminRows = 0;
    let membershipRows = 0;
    const adminResults = [];
    const membershipResults = [];

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRepairReceiptSchema(db);
        const existing = await db.get(
            'SELECT * FROM clover_urgent_operational_repairs WHERE repair_key = ?',
            [REPAIR_KEY]
        );
        if (existing?.status === 'applied') {
            await db.exec('COMMIT');
            return {
                ok: true,
                idempotent: true,
                repairKey: REPAIR_KEY,
                adminRows: Number(existing.admin_rows || 0),
                membershipRows: Number(existing.membership_rows || 0),
                appliedAt: existing.applied_at,
            };
        }

        for (const candidate of plan.admin.candidates) {
            const result = await applyAdminCandidate(db, candidate);
            adminResults.push({ ...candidate, ...result });
            if (result.changed) adminRows += 1;
        }
        for (const candidate of plan.squads.automaticCandidates) {
            const result = await applyMembershipCandidate(db, candidate);
            membershipResults.push({ ...candidate, ...result });
            if (result.changed) membershipRows += 1;
        }

        const afterSnapshot = await readUrgentOperationalSnapshot(db);
        const afterPlan = buildUrgentOperationalPlan(afterSnapshot, {
            referenceDate: options.referenceDate || new Date(),
        });
        if (!afterPlan.safeToApply) {
            throw new UrgentOperationalRepairError(
                'A validação posterior encontrou novos conflitos.',
                'repair_postcondition_conflict',
                { blockingReasons: afterPlan.blockingReasons }
            );
        }
        if (afterPlan.admin.candidates.length || afterPlan.squads.automaticCandidates.length) {
            throw new UrgentOperationalRepairError(
                'A validação posterior ainda encontrou linhas reparáveis.',
                'repair_postcondition_incomplete',
                {
                    adminCandidates: afterPlan.admin.candidates.length,
                    membershipCandidates: afterPlan.squads.automaticCandidates.length,
                }
            );
        }

        await db.run(`
            INSERT INTO clover_urgent_operational_repairs
            (repair_key, status, actor_id, reason, admin_rows, membership_rows,
             before_summary_json, after_summary_json, applied_at, metadata_json)
            VALUES (?, 'applied', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        `, [
            REPAIR_KEY,
            actorId,
            reason,
            adminRows,
            membershipRows,
            JSON.stringify(plan.summary),
            JSON.stringify(afterPlan.summary),
            JSON.stringify({
                version: 'v1',
                adminResults,
                membershipResults,
            }),
        ]);
        await db.exec('COMMIT');

        return {
            ok: true,
            idempotent: false,
            repairKey: REPAIR_KEY,
            adminRows,
            membershipRows,
            adminResults,
            membershipResults,
            afterPlan,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ADMIN_ROLE_KEYS,
    REPAIR_ACTOR,
    REPAIR_KEY,
    REPAIR_REASON,
    UrgentOperationalRepairError,
    applyUrgentOperationalPlan,
    buildAdminPlan,
    buildCaptainAudit,
    buildIdentityAudit,
    buildOperationsAudit,
    buildRaidAudit,
    buildSquadPlan,
    buildUrgentOperationalPlan,
    canonicalGrantEffective,
    cleanText,
    databaseDate,
    normalizeIdentity,
    normalizeSquadKey,
    normalizeText,
    playerEligibleForMembership,
    readUrgentOperationalSnapshot,
};
