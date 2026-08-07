'use strict';

const { normalizeJid } = require('../groupAccess');
const { isGrantActiveAt, rowToGrant } = require('./canonicalRoleGrantSchema');

const LEADERSHIP_ROLE_KEYS = Object.freeze(['captain', 'vice_captain']);
const IDENTITY_ALIAS_TYPES = Object.freeze(['jid', 'lid', 'whatsapp_mention', 'phone']);

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row);
}

function aliasSubject(aliasType, aliasValue) {
    const type = String(aliasType || '').trim().toLowerCase();
    const value = String(aliasValue || '').trim();
    if (!value || !IDENTITY_ALIAS_TYPES.includes(type)) return null;
    if (type === 'phone') {
        const digits = value.replace(/\D/g, '');
        return digits ? normalizeJid(`${digits}@s.whatsapp.net`) : null;
    }
    return normalizeJid(value.replace(/^@/, '')) || null;
}

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

async function resolveLeadershipAliasSubjects(db, subjectId) {
    const subject = normalizeJid(subjectId);
    if (!subject || !await tableExists(db, 'clover_player_aliases')) return [];

    const aliases = await db.all(
        `SELECT player_id_destino, alias_type, alias_value
         FROM clover_player_aliases
         WHERE active = 1
           AND (
             player_id_destino = ?
             OR (
               alias_type IN ('jid', 'lid', 'whatsapp_mention')
               AND alias_value = ?
             )
           )
         ORDER BY id ASC`,
        [subject, subject]
    );

    const candidates = [];
    for (const row of aliases || []) {
        const destination = normalizeJid(row.player_id_destino);
        const alias = aliasSubject(row.alias_type, row.alias_value);
        if (destination === subject && alias && alias !== subject) candidates.push(alias);
        if (alias === subject && destination && destination !== subject) candidates.push(destination);
    }
    return unique(candidates);
}

async function readLeadershipAliasGrantsReadOnly(db, subjectId, options = {}) {
    if (!await tableExists(db, 'clover_role_grants')) return [];
    const aliases = await resolveLeadershipAliasSubjects(db, subjectId);
    if (!aliases.length) return [];

    const placeholders = aliases.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT * FROM clover_role_grants
         WHERE status = 'active'
           AND subject_id IN (${placeholders})
           AND role_key IN ('captain', 'vice_captain')
           AND scope_type = 'squad'
         ORDER BY subject_id, role_key, scope_key, id`,
        aliases
    );
    const referenceDate = options.referenceDate || new Date();
    return (rows || [])
        .map((row) => ({
            ...rowToGrant(row, 'canonical_alias'),
            aliasForSubjectId: normalizeJid(subjectId),
        }))
        .filter((grant) => isGrantActiveAt(grant, referenceDate));
}

module.exports = {
    IDENTITY_ALIAS_TYPES,
    LEADERSHIP_ROLE_KEYS,
    aliasSubject,
    readLeadershipAliasGrantsReadOnly,
    resolveLeadershipAliasSubjects,
    tableExists,
};
