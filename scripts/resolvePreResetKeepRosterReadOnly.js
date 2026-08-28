'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { normalizeJid } = require('../helpers/groupAccess');

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function maskPhone(value) {
    const valueDigits = digits(value);
    return valueDigits ? `***${valueDigits.slice(-4)}` : '***';
}

function normalizeName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseRosterText(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    if (raw.startsWith('[')) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('Roster JSON precisa ser array.');
        return parsed.map((entry) => ({
            name:String(entry?.name || entry?.nome || '').trim(),
            phone:String(entry?.phone || entry?.telefone || '').trim(),
        })).filter((entry) => entry.name && digits(entry.phone));
    }
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = line.match(/^(.+?)\s+[—–-]\s+(.+)$/);
        if (!match) return null;
        return { name:match[1].trim(), phone:match[2].trim() };
    }).filter((entry) => entry?.name && digits(entry.phone));
}

function sha256File(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function tableExists(db, table) {
    const row = await db.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", [table]);
    return Boolean(row);
}

function resolveCanonicalPlayer(playersById, player) {
    let current = player || null;
    const seen = new Set();
    for (let depth = 0; current && depth < 12; depth += 1) {
        const id = String(current.id || '').trim();
        if (!id || seen.has(id)) break;
        seen.add(id);
        const mergedInto = String(current.merged_into || '').trim();
        const canonicalId = String(current.canonical_player_id || '').trim();
        const nextId = mergedInto || (canonicalId && canonicalId !== id ? canonicalId : '');
        if (!nextId || !playersById.has(nextId)) break;
        current = playersById.get(nextId);
    }
    return current;
}

function playerNameMatches(player, wantedName) {
    const wanted = normalizeName(wantedName);
    if (!wanted) return false;
    return [player?.nome, player?.display_name, player?.personagem_nome]
        .some((value) => normalizeName(value) === wanted);
}

async function loadIdentitySnapshot(db) {
    if (!(await tableExists(db, 'jogadores'))) throw new Error('Tabela jogadores ausente.');
    const players = await db.all('SELECT * FROM jogadores WHERE id IS NOT NULL');
    const aliases = await tableExists(db, 'clover_player_aliases')
        ? await db.all('SELECT player_id_destino,alias_type,alias_value,active FROM clover_player_aliases WHERE active=1')
        : [];
    const legacyAliases = await tableExists(db, 'clover_player_target_aliases')
        ? await db.all('SELECT player_id,alias_key FROM clover_player_target_aliases')
        : [];
    const purgeRows = await tableExists(db, 'clover_prereset_purge_tombstones')
        ? await db.all('SELECT player_id FROM clover_prereset_purge_tombstones')
        : [];
    return {
        players,
        playersById:new Map(players.map((player) => [String(player.id), player])),
        aliases,
        legacyAliases,
        purged:new Set(purgeRows.map((row) => String(row.player_id))),
    };
}

function exactIdentityCandidates(snapshot, phone) {
    const phoneDigits = digits(phone);
    const rawJid = `${phoneDigits}@s.whatsapp.net`;
    const normalizedJid = normalizeJid(rawJid);
    const ids = new Set();

    for (const player of snapshot.players) {
        const playerId = String(player.id || '').trim();
        const playerDigits = digits(playerId.split('@')[0]);
        if (playerDigits === phoneDigits || playerId === rawJid || playerId === normalizedJid) ids.add(playerId);
    }

    for (const alias of snapshot.aliases) {
        const type = String(alias.alias_type || '').trim().toLowerCase();
        const value = String(alias.alias_value || '').trim();
        if (type === 'phone' && digits(value) === phoneDigits) ids.add(String(alias.player_id_destino));
        if (['jid','lid','whatsapp_mention'].includes(type)) {
            const normalized = normalizeJid(value);
            if (normalized === normalizedJid || value === rawJid) ids.add(String(alias.player_id_destino));
        }
    }

    const legacyKeys = new Set([
        `phone:${phoneDigits}`,
        `jid:${rawJid}`,
        normalizedJid ? `jid:${normalizedJid}` : '',
    ].filter(Boolean));
    for (const alias of snapshot.legacyAliases) {
        if (legacyKeys.has(String(alias.alias_key || '').trim())) ids.add(String(alias.player_id));
    }

    const canonical = new Map();
    for (const id of ids) {
        const player = snapshot.playersById.get(id);
        if (!player) continue;
        const resolved = resolveCanonicalPlayer(snapshot.playersById, player);
        if (resolved?.id) canonical.set(String(resolved.id), resolved);
    }
    return [...canonical.values()];
}

function classifyResolved(snapshot, entry, candidates) {
    if (candidates.length > 1) {
        return {
            name:entry.name,
            phoneMasked:maskPhone(entry.phone),
            status:'AMBIGUOUS',
            candidatePlayerIds:candidates.map((player) => String(player.id)).sort(),
        };
    }
    if (candidates.length === 1) {
        const player = candidates[0];
        const playerId = String(player.id);
        const approved = String(player.ficha_status || '').trim().toLowerCase() === 'aprovada';
        const shadow = Number(player.is_shadow || 0) === 1;
        const purged = snapshot.purged.has(playerId);
        const nameMatches = playerNameMatches(player, entry.name);
        const status = purged || shadow || !approved ? 'INELIGIBLE' : 'RESOLVED';
        return {
            name:entry.name,
            phoneMasked:maskPhone(entry.phone),
            status,
            playerId,
            characterName:player.personagem_nome || null,
            displayName:player.display_name || player.nome || null,
            nameMatches,
            eligibility:{ approved, shadow, purged },
        };
    }

    const exactName = snapshot.players
        .map((player) => resolveCanonicalPlayer(snapshot.playersById, player))
        .filter(Boolean)
        .filter((player, index, all) => all.findIndex((other) => other.id === player.id) === index)
        .filter((player) => playerNameMatches(player, entry.name));
    return {
        name:entry.name,
        phoneMasked:maskPhone(entry.phone),
        status:exactName.length ? 'NAME_ONLY_REVIEW' : 'NOT_FOUND',
        candidatePlayerIds:exactName.map((player) => String(player.id)).sort(),
    };
}

async function resolveRosterAgainstDatabase({ dbPath, entries }) {
    const filename = path.resolve(String(dbPath || ''));
    if (!filename || !fs.existsSync(filename)) throw new Error('Arquivo SQLite nao encontrado.');
    const before = sha256File(filename);
    const db = await open({ filename, driver:sqlite3.Database, mode:sqlite3.OPEN_READONLY });
    try {
        await db.exec('PRAGMA query_only=ON');
        const snapshot = await loadIdentitySnapshot(db);
        const results = entries.map((entry) => classifyResolved(snapshot, entry, exactIdentityCandidates(snapshot, entry.phone)));
        const counts = results.reduce((acc, item) => {
            acc[item.status] = (acc[item.status] || 0) + 1;
            return acc;
        }, {});
        return { results, counts, allResolved:results.every((item) => item.status === 'RESOLVED') };
    } finally {
        await db.close();
        const after = sha256File(filename);
        if (before !== after) throw new Error('Falha de seguranca: arquivo SQLite mudou durante auditoria read-only.');
    }
}

function parseArgs(argv) {
    const values = {};
    for (const arg of argv) {
        const match = String(arg).match(/^--([^=]+)=(.*)$/);
        if (match) values[match[1]] = match[2];
    }
    return values;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.db || !args.input) {
        console.error('Uso: node scripts/resolvePreResetKeepRosterReadOnly.js --db=C:\\copia.sqlite --input=C:\\roster.txt');
        process.exitCode = 2;
        return;
    }
    const entries = parseRosterText(fs.readFileSync(path.resolve(args.input), 'utf8'));
    if (!entries.length) throw new Error('Roster vazio ou invalido.');
    const report = await resolveRosterAgainstDatabase({ dbPath:args.db, entries });
    console.log(JSON.stringify({ counts:report.counts, allResolved:report.allResolved, results:report.results }, null, 2));
    if (!report.allResolved) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[prereset-roster-readonly] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    classifyResolved,
    exactIdentityCandidates,
    loadIdentitySnapshot,
    maskPhone,
    normalizeName,
    parseRosterText,
    resolveCanonicalPlayer,
    resolveRosterAgainstDatabase,
};
