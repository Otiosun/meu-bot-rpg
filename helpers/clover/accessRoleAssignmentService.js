'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { normalizeJid } = require('../groupAccess');
const {
    assignAccessRole: assignBaseRole,
    getRoleDefinition,
    listActiveAccessRoles,
    normalizeScopeKey,
    revokeAccessRole: revokeBaseRole,
} = require('./accessControlService');

function displayName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-')
        || null;
}

async function ensureSquadRecord(db, scopeKey, scopeLabel = null) {
    await ensureCloverSquadSchema(db);
    const normalized = normalizeScopeKey(scopeKey);
    if (!normalized) return null;
    const label = String(scopeLabel || '').trim() || normalized
        .split('_')
        .filter(Boolean)
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(' ');
    await db.run(
        `INSERT OR IGNORE INTO clover_squads (squad_key, name)
         VALUES (?, ?)`,
        [normalized, label]
    );
    return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [normalized]);
}

async function getPlayerLabel(db, subjectId) {
    const player = await db.get(
        `SELECT id, nome, display_name, personagem_nome
         FROM jogadores
         WHERE id = ?`,
        [normalizeJid(subjectId)]
    ).catch(() => null);
    return displayName(player);
}

async function revokeCompetingLeadership(db, {
    subjectId,
    roleKey,
    scopeKey,
    actorId,
}) {
    const active = await listActiveAccessRoles(db, { role: roleKey });
    const competing = active.filter((assignment) => (
        assignment.scope_type === 'squad'
        && assignment.scope_key === scopeKey
        && assignment.subject_id !== normalizeJid(subjectId)
    ));
    for (const assignment of competing) {
        await revokeBaseRole(db, {
            subjectId: assignment.subject_id,
            role: roleKey,
            scopeKey,
            revokedBy: actorId,
            reason: 'Cargo de liderança substituído por nova atribuição',
            metadata: { replaced_by: normalizeJid(subjectId) },
        });
    }
    return competing;
}

async function syncLeadershipAssignment(db, assignment, subjectId, metadata = {}) {
    if (!assignment || assignment.scope_type !== 'squad') return null;
    if (!['captain', 'vice_captain'].includes(assignment.role_key)) return null;
    const squad = await ensureSquadRecord(
        db,
        assignment.scope_key,
        metadata.scope_label
    );
    if (!squad) return null;

    const subject = normalizeJid(subjectId);
    if (assignment.role_key === 'captain') {
        const label = await getPlayerLabel(db, subject);
        await db.run(
            `UPDATE clover_squads
             SET captain_player_id = ?,
                 captain_name = COALESCE(?, captain_name),
                 updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ?`,
            [subject, label, assignment.scope_key]
        );
    } else {
        await db.run(
            `UPDATE clover_squads
             SET vice_captain_player_id = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ?`,
            [subject, assignment.scope_key]
        );
    }
    return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [assignment.scope_key]);
}

async function clearLeadershipAssignment(db, assignment) {
    if (!assignment || assignment.scope_type !== 'squad') return null;
    if (!['captain', 'vice_captain'].includes(assignment.role_key)) return null;

    if (assignment.role_key === 'captain') {
        await db.run(
            `UPDATE clover_squads
             SET captain_player_id = CASE WHEN captain_player_id = ? THEN NULL ELSE captain_player_id END,
                 captain_name = CASE WHEN captain_player_id = ? THEN NULL ELSE captain_name END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ?`,
            [assignment.subject_id, assignment.subject_id, assignment.scope_key]
        );
    } else {
        await db.run(
            `UPDATE clover_squads
             SET vice_captain_player_id = CASE WHEN vice_captain_player_id = ? THEN NULL ELSE vice_captain_player_id END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ?`,
            [assignment.subject_id, assignment.scope_key]
        );
    }
    return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [assignment.scope_key]);
}

async function assignAccessRole(db, options) {
    const definition = getRoleDefinition(options?.role);
    const metadata = options?.metadata || {};
    const scopeKey = definition?.scopeType === 'squad'
        ? normalizeScopeKey(options?.scopeKey)
        : null;
    let replaced = [];

    if (definition && ['captain', 'vice_captain'].includes(definition.key) && scopeKey) {
        await ensureSquadRecord(db, scopeKey, metadata.scope_label || options.scopeKey);
        replaced = await revokeCompetingLeadership(db, {
            subjectId: options.subjectId,
            roleKey: definition.key,
            scopeKey,
            actorId: options.assignedBy,
        });
        for (const assignment of replaced) await clearLeadershipAssignment(db, assignment);
    }

    const result = await assignBaseRole(db, options);
    if (result.ok && result.assignment) {
        result.squad = await syncLeadershipAssignment(db, result.assignment, options.subjectId, metadata);
        result.replaced = replaced;
    }
    return result;
}

async function revokeAccessRole(db, options) {
    const result = await revokeBaseRole(db, options);
    if (result.ok) {
        for (const assignment of result.revoked || []) await clearLeadershipAssignment(db, assignment);
    }
    return result;
}

module.exports = {
    assignAccessRole,
    clearLeadershipAssignment,
    ensureSquadRecord,
    revokeAccessRole,
    syncLeadershipAssignment,
};
