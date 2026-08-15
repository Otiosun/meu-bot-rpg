'use strict';

const {
    getRoleLabel,
} = require('./accessControlService');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('./accessIntegrationService');
const {
    contextCanAnywhere,
    contextCanForSquad,
    contextHasGlobalAdministration,
    getIntegratedAccessContext,
} = require('./integratedAccessContextService');
const { listAccountPersonas } = require('./captainPersonaService');
const {
    getIntegratedSquadState,
} = require('./squadStateIntegrationService');
const {
    resolveSquad,
} = require('./squadStateService');
const { listEffectiveSquadMembers } = require('./squadMembershipReadService');

function safeNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
}

function humanizeScopeKey(value) {
    return String(value || '')
        .split('_')
        .filter(Boolean)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(' ')
        || null;
}

function readMetadata(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function serializeAssignment(assignment = {}) {
    const metadata = assignment.metadata || readMetadata(assignment.metadata_json);
    return {
        roleKey: assignment.role_key,
        roleLabel: getRoleLabel(assignment.role_key),
        scopeType: assignment.scope_type,
        scopeKey: assignment.scope_key === '*' ? null : assignment.scope_key,
        scopeLabel: assignment.scope_type === 'global'
            ? 'Global'
            : (metadata.scope_label || humanizeScopeKey(assignment.scope_key)),
        assignedAt: assignment.created_at || null,
    };
}

function contextCan(context, permission) {
    return contextCanAnywhere(context, permission);
}

function buildCapabilityFlags(context) {
    return {
        owner: Boolean(context.owner),
        globalAdministration: contextHasGlobalAdministration(context),
        readProfiles: contextCan(context, ACCESS_PERMISSIONS.PROFILE_READ),
        readCapabilities: contextCan(context, ACCESS_PERMISSIONS.CAPACITY_READ),
        readTechnicalCapabilities: contextCan(context, ACCESS_PERMISSIONS.CAPACITY_TECHNICAL),
        readGrimoires: contextCan(context, ACCESS_PERMISSIONS.GRIMOIRE_READ),
        readTechnicalGrimoires: contextCan(context, ACCESS_PERMISSIONS.GRIMOIRE_TECHNICAL),
        readSquadStates: contextCan(context, ACCESS_PERMISSIONS.SQUAD_STATE_READ),
        readSquadMembers: contextCan(context, ACCESS_PERMISSIONS.SQUAD_MEMBERS_READ),
        readSquadResources: contextCan(context, ACCESS_PERMISSIONS.SQUAD_RESOURCES_READ),
        manageSquadUpgrades: contextCan(context, ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE),
        manageSquadMembers: contextCan(context, ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE),
        createRaids: contextCan(context, ACCESS_PERMISSIONS.RAID_CREATE),
        readAllRaids: contextCan(context, ACCESS_PERMISSIONS.RAID_READ_ALL),
        manageRaids: contextCan(context, ACCESS_PERMISSIONS.RAID_MANAGE),
        reviewRaidRewards: contextCan(context, ACCESS_PERMISSIONS.RAID_REWARD_REVIEW),
    };
}

function serializeSquadState(state) {
    if (!state?.ok) return null;
    return {
        key: state.squadKey,
        name: state.name,
        phrase: state.phrase || null,
        memberCount: safeNumber(state.memberCount),
        stars: {
            current: safeNumber(state.currentStars),
            historical: safeNumber(state.historicalStars),
            black: safeNumber(state.blackStars),
        },
        renown: {
            grade: safeNumber(state.renown?.grade),
            name: state.renown?.name || null,
            description: state.renown?.description || null,
        },
        resources: {
            key: state.resources?.key || null,
            label: state.resources?.label || null,
            description: state.resources?.description || null,
        },
        reputation: {
            key: state.reputation?.key || null,
            label: state.reputation?.label || null,
            description: state.reputation?.description || null,
        },
        command: {
            key: state.command?.key || null,
            label: state.command?.label || null,
            description: state.command?.description || null,
        },
        activity: {
            key: state.activity?.key || null,
            label: state.activity?.label || null,
            description: state.activity?.description || null,
        },
        structure: {
            registered: Boolean(state.structure?.registered),
            label: state.structure?.label || null,
            description: state.structure?.description || null,
            count: safeNumber(state.structure?.count),
            sectorCount: safeNumber(state.structure?.sectorCount),
            categories: (state.structure?.categories || []).map((category) => ({
                key: category.key,
                label: category.label,
                count: safeNumber(category.count),
            })),
            upgrades: [...(state.structure?.upgrades || [])],
        },
        reading: state.overallReading || null,
    };
}

async function filterOperationalSquadsForOwner(db, rows, context) {
    if (!context?.owner) return rows;

    const canonicalState = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_squad_memberships
         WHERE status='active'`
    ).catch(() => null);

    // Preserve the pre-canonical contract for installations/fixtures that have
    // no active canonical memberships yet. Once canonical membership is in use,
    // it becomes authoritative for the Owner's operational squad selector.
    if (!canonicalState || safeNumber(canonicalState.total) === 0) return rows;

    const operational = [];
    for (const squad of rows) {
        const membership = await listEffectiveSquadMembers(
            db,
            squad.squad_key,
            { allowLegacyFallback: false }
        );
        if (!membership.ok || membership.members.length === 0) continue;
        operational.push(squad);
    }
    return operational;
}

async function listAccessibleSquads(db, actorId, context) {
    const rows = await db.all(
        `SELECT squad_key, name, group_id, phrase, historical_stars,
                current_stars, black_stars, captain_player_id,
                vice_captain_player_id
         FROM clover_squads
         ORDER BY name ASC, squad_key ASC`
    ).catch(() => []);

    const candidates = await filterOperationalSquadsForOwner(db, rows, context);
    const readable = [];
    for (const squad of candidates) {
        const access = await authorizeSquadAccess(db, {
            actorId,
            squad,
            permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
            allowMemberRead: true,
        });
        if (!access.ok) continue;
        readable.push({
            key: squad.squad_key,
            name: squad.name || humanizeScopeKey(squad.squad_key),
            scope: access.code,
            currentStars: safeNumber(squad.current_stars),
            historicalStars: safeNumber(squad.historical_stars),
            blackStars: safeNumber(squad.black_stars),
            canManageUpgrades: contextCanForSquad(
                context,
                ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
                squad.squad_key
            ),
        });
    }
    return readable;
}

async function buildSiteAccessPayload(db, playerId) {
    const context = await getIntegratedAccessContext(db, playerId);
    const assignments = context.assignments.map(serializeAssignment);
    const ownSquad = await resolveSquad(db, { playerId });
    const ownSquadState = ownSquad
        ? await getIntegratedSquadState(db, ownSquad)
        : null;
    const [accessibleSquads, personas] = await Promise.all([
        listAccessibleSquads(db, playerId, context),
        listAccountPersonas(db, playerId),
    ]);
    const activePersona = personas.find((persona) => persona.isDefault) || personas[0] || null;

    return {
        actorId: context.actorId,
        owner: Boolean(context.owner),
        roles: assignments,
        roleKeys: [...context.roleKeys],
        permissions: [...context.permissions],
        squadScopes: [...context.squadScopes],
        accessSource: context.source,
        capabilities: buildCapabilityFlags(context),
        ownSquad: serializeSquadState(ownSquadState),
        accessibleSquads,
        personas,
        activePersonaKey: activePersona?.key || null,
    };
}

module.exports = {
    buildCapabilityFlags,
    buildSiteAccessPayload,
    contextCan,
    filterOperationalSquadsForOwner,
    humanizeScopeKey,
    listAccessibleSquads,
    serializeAssignment,
    serializeSquadState,
};
