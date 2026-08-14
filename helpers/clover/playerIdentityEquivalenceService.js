'use strict';

const { normalizeJid } = require('../groupAccess');

function rawJid(value) {
    return String(value || '').trim().toLowerCase().replace(/:\d+(?=@)/g, '');
}

function addVariant(set, value) {
    const raw = rawJid(value);
    if (raw) set.add(raw);
    const normalized = normalizeJid(value);
    if (normalized) set.add(normalized);
}

async function tableExists(db, name) {
    return Boolean(await db.get(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).catch(() => null));
}

async function equivalentPlayerIds(db, actorId) {
    const ids = new Set();
    addVariant(ids, actorId);
    if (!ids.size) return [];

    if (await tableExists(db, 'clover_player_aliases')) {
        for (let round = 0; round < 3; round += 1) {
            const values = [...ids];
            const jidValues = values.filter((value) => value.includes('@'));
            const phoneValues = values
                .map((value) => String(value || '').replace(/\D/g, ''))
                .filter((value) => value.length >= 8);
            const lookup = [...new Set([...values, ...phoneValues])];
            if (!lookup.length) break;
            const marks = lookup.map(() => '?').join(', ');
            const targetMarks = jidValues.length ? jidValues.map(() => '?').join(', ') : "''";
            const rows = await db.all(
                `SELECT player_id_destino, alias_type, alias_value
                   FROM clover_player_aliases
                  WHERE active = 1
                    AND (alias_value IN (${marks})${jidValues.length ? ` OR player_id_destino IN (${targetMarks})` : ''})`,
                [...lookup, ...jidValues]
            ).catch(() => []);
            const before = ids.size;
            for (const row of rows || []) {
                addVariant(ids, row.player_id_destino);
                const type = String(row.alias_type || '').toLowerCase();
                const value = String(row.alias_value || '').trim();
                if (value.includes('@')) addVariant(ids, value);
                else if (type === 'phone' && /\d{8,}/.test(value)) {
                    addVariant(ids, `${value.replace(/\D/g, '')}@s.whatsapp.net`);
                }
            }
            if (ids.size === before) break;
        }
    }

    if (await tableExists(db, 'jogadores')) {
        const columns = new Set((await db.all('PRAGMA table_info(jogadores)').catch(() => [])).map((row) => row.name));
        if (columns.has('canonical_player_id') || columns.has('merged_into')) {
            const values = [...ids].filter((value) => value.includes('@'));
            if (values.length) {
                const marks = values.map(() => '?').join(', ');
                const predicates = [`id IN (${marks})`];
                const params = [...values];
                if (columns.has('canonical_player_id')) { predicates.push(`canonical_player_id IN (${marks})`); params.push(...values); }
                if (columns.has('merged_into')) { predicates.push(`merged_into IN (${marks})`); params.push(...values); }
                const rows = await db.all(
                    `SELECT id, ${columns.has('canonical_player_id') ? 'canonical_player_id' : 'NULL AS canonical_player_id'}, ${columns.has('merged_into') ? 'merged_into' : 'NULL AS merged_into'}
                       FROM jogadores WHERE ${predicates.join(' OR ')}`,
                    params
                ).catch(() => []);
                for (const row of rows || []) { addVariant(ids, row.id); addVariant(ids, row.canonical_player_id); addVariant(ids, row.merged_into); }
            }
        }
    }

    return [...ids];
}

module.exports = { addVariant, equivalentPlayerIds, rawJid, tableExists };
