'use strict';

const { extractPhoneNumber, normalizeJid } = require('../groupAccess');

const MAX_ALIAS_ROUNDS = 3;
const EXPLICIT_ALIAS_TYPES = Object.freeze([
    'jid',
    'lid',
    'whatsapp_mention',
    'phone',
]);

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row);
}

function identityVariants(value, type = null) {
    const raw = String(value || '').trim().replace(/^@/, '');
    if (!raw) return [];
    const aliasType = String(type || '').trim().toLowerCase();
    const variants = new Set();

    if (!aliasType || ['jid', 'lid', 'whatsapp_mention'].includes(aliasType)) {
        const jid = normalizeJid(raw);
        if (jid) variants.add(jid);
        const phone = extractPhoneNumber(jid || raw);
        if (phone && phone.length >= 8) variants.add(normalizeJid(`${phone}@s.whatsapp.net`));
    }

    if (!aliasType || aliasType === 'phone') {
        const digits = raw.replace(/\D/g, '');
        if (digits.length >= 8) variants.add(normalizeJid(`${digits}@s.whatsapp.net`));
    }

    return [...variants].filter(Boolean);
}

function intersects(left, right) {
    for (const value of left) {
        if (right.has(value)) return true;
    }
    return false;
}

async function equivalentPlayerIds(db, playerId, options = {}) {
    const canonical = normalizeJid(playerId);
    if (!canonical) return [];
    const known = new Set(identityVariants(canonical));
    known.add(canonical);

    if (!await tableExists(db, 'clover_player_aliases')) return [...known];
    const rows = await db.all(
        `SELECT player_id_destino, alias_type, alias_value
         FROM clover_player_aliases
         WHERE active = 1
         ORDER BY id ASC`
    );

    const rounds = Math.max(1, Math.min(MAX_ALIAS_ROUNDS, Number(options.rounds) || MAX_ALIAS_ROUNDS));
    for (let round = 0; round < rounds; round += 1) {
        let changed = false;
        for (const row of rows || []) {
            const type = String(row.alias_type || '').trim().toLowerCase();
            if (!EXPLICIT_ALIAS_TYPES.includes(type)) continue;
            const destination = new Set(identityVariants(row.player_id_destino));
            const aliases = new Set(identityVariants(row.alias_value, type));
            if (!destination.size || !aliases.size) continue;
            if (!intersects(destination, known) && !intersects(aliases, known)) continue;

            for (const value of [...destination, ...aliases]) {
                if (!known.has(value)) {
                    known.add(value);
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }

    return [...known].sort();
}

module.exports = {
    EXPLICIT_ALIAS_TYPES,
    MAX_ALIAS_ROUNDS,
    equivalentPlayerIds,
    identityVariants,
    tableExists,
};
