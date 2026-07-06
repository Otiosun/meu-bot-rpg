const { normalizeText } = require('../textUtils');
const {
    assertMechanicalTarget,
    formatTargetErrorDetails,
    resolveTargetPlayer,
} = require('./targetResolver');

function normalizeSlug(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function parseKv(text) {
    const kv = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = normalizeText(match[1]).replace(/[^a-z0-9_]+/g, '_');
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) kv[key] = value;
    }
    return kv;
}

async function ensureRewardListSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_reward_lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            name TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_reward_list_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER NOT NULL,
            raw_name TEXT DEFAULT NULL,
            raw_phone TEXT DEFAULT NULL,
            raw_target TEXT DEFAULT NULL,
            player_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            resolution_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_reward_list_entries_list
        ON clover_reward_list_entries (list_id, status, player_id)
    `);
}

async function createRewardList(db, slugInput, { name = null, createdBy = null } = {}) {
    await ensureRewardListSchema(db);
    const slug = normalizeSlug(slugInput);
    if (!slug) return { ok: false, error: 'Nome da lista invalido.' };
    await db.run(
        `INSERT INTO clover_reward_lists (slug, name, created_by, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(slug) DO UPDATE SET
             name = COALESCE(excluded.name, clover_reward_lists.name),
             updated_at = CURRENT_TIMESTAMP`,
        [slug, name || slug, createdBy || null]
    );
    const list = await getRewardList(db, slug);
    return { ok: true, list };
}

async function getRewardList(db, slugInput) {
    await ensureRewardListSchema(db);
    const slug = normalizeSlug(slugInput);
    if (!slug) return null;
    return db.get('SELECT * FROM clover_reward_lists WHERE slug = ?', [slug]);
}

async function addRewardListEntry(db, slugInput, entry = {}, options = {}) {
    await ensureRewardListSchema(db);
    const created = await createRewardList(db, slugInput, { createdBy: options.createdBy });
    if (!created.ok) return created;
    const list = created.list;
    const rawName = String(entry.name || entry.personagem || entry.raw_name || '').trim();
    const rawPhone = String(entry.phone || entry.tel || entry.telefone || entry.raw_phone || '').trim();
    const rawTarget = String(entry.target || entry.raw_target || rawPhone || rawName || '').trim();

    const resolved = await resolveListEntry(db, { rawName, rawPhone, rawTarget });
    await db.run(
        `INSERT INTO clover_reward_list_entries
         (list_id, raw_name, raw_phone, raw_target, player_id, status, resolution_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
            list.id,
            rawName || null,
            rawPhone || null,
            rawTarget || null,
            resolved.playerId || null,
            resolved.status,
            JSON.stringify(resolved),
        ]
    );
    return { ok: resolved.status === 'resolved', list, entry: resolved };
}

async function resolveListEntry(db, { rawName = '', rawPhone = '', rawTarget = '' } = {}) {
    const composite = [
        rawPhone ? `tel=${rawPhone}` : '',
        rawName ? `personagem="${rawName.replace(/"/g, '\\"')}"` : '',
    ].filter(Boolean).join(' ');
    const query = rawPhone || rawTarget || rawName;
    const result = await resolveTargetPlayer(db, null, query, { mechanical: true });
    let resolved = result;

    if ((!result.ok || (rawName && !nameMatches(result.player, rawName))) && rawName && rawPhone) {
        resolved = await resolveTargetPlayer(db, null, rawName, { mechanical: true });
        if (!resolved.ok) resolved = result;
    }

    if (!resolved.ok) {
        return {
            status: 'unresolved',
            rawName,
            rawPhone,
            rawTarget: rawTarget || composite || query,
            playerId: null,
            error: resolved.error || 'Alvo nao resolvido.',
            details: resolved.details || null,
        };
    }

    const guard = assertMechanicalTarget(resolved.player, {
        rawTarget: rawTarget || composite || query,
        source: resolved.source,
    });
    if (!guard.ok) {
        return {
            status: 'refused',
            rawName,
            rawPhone,
            rawTarget: rawTarget || composite || query,
            playerId: null,
            error: guard.error,
            details: guard.details,
        };
    }

    return {
        status: 'resolved',
        rawName,
        rawPhone,
        rawTarget: rawTarget || composite || query,
        playerId: resolved.player.id,
        playerName: resolved.player.personagem_nome || resolved.player.nome || '-',
        source: resolved.source,
        details: resolved.details || null,
    };
}

function nameMatches(player = {}, name = '') {
    const expected = normalizeText(name).replace(/[^a-z0-9]+/g, ' ').trim();
    if (!expected) return true;
    return [player.personagem_nome, player.nome, player.display_name]
        .map((value) => normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim())
        .filter(Boolean)
        .some((value) => value === expected || value.includes(expected) || expected.includes(value));
}

async function listRewardEntries(db, slugInput) {
    await ensureRewardListSchema(db);
    const list = await getRewardList(db, slugInput);
    if (!list) return { ok: false, error: 'Lista nao encontrada.' };
    const entries = await db.all(
        `SELECT *
         FROM clover_reward_list_entries
         WHERE list_id = ?
         ORDER BY id ASC`,
        [list.id]
    );
    return { ok: true, list, entries };
}

async function resolveRewardList(db, slugInput) {
    await ensureRewardListSchema(db);
    const view = await listRewardEntries(db, slugInput);
    if (!view.ok) return view;
    const updated = [];
    for (const row of view.entries) {
        const resolved = await resolveListEntry(db, {
            rawName: row.raw_name || '',
            rawPhone: row.raw_phone || '',
            rawTarget: row.raw_target || '',
        });
        await db.run(
            `UPDATE clover_reward_list_entries
             SET player_id = ?, status = ?, resolution_json = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [resolved.playerId || null, resolved.status, JSON.stringify(resolved), row.id]
        );
        updated.push({ ...row, player_id: resolved.playerId || null, status: resolved.status, resolution_json: JSON.stringify(resolved) });
    }
    return { ok: true, list: view.list, entries: updated };
}

async function getResolvedRewardListTargets(db, slugInput) {
    const resolved = await resolveRewardList(db, slugInput);
    if (!resolved.ok) return resolved;
    const bad = resolved.entries.filter((entry) => entry.status !== 'resolved' || !entry.player_id);
    if (bad.length) {
        return {
            ok: false,
            error: `Lista ${resolved.list.slug} tem ${bad.length} alvo(s) nao resolvido(s).`,
            list: resolved.list,
            entries: resolved.entries,
            bad,
        };
    }
    const seen = new Set();
    const playerIds = [];
    for (const entry of resolved.entries) {
        if (!seen.has(entry.player_id)) {
            seen.add(entry.player_id);
            playerIds.push(entry.player_id);
        }
    }
    return { ok: true, list: resolved.list, entries: resolved.entries, playerIds };
}

function parseImportBlock(text) {
    const lines = String(text || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const entries = [];
    for (const line of lines) {
        if (normalizeText(line).replace(/[^a-z0-9]+/g, '') === 'fim') break;
        const [name, phone] = line.split('|').map((part) => String(part || '').trim());
        if (!name && !phone) continue;
        entries.push({ name, phone, target: line });
    }
    return entries;
}

function parseAddArgs(text) {
    const kv = parseKv(text);
    return {
        name: kv.personagem || kv.nome || kv.name || '',
        phone: kv.tel || kv.telefone || kv.phone || '',
        target: kv.id || kv.alvo || '',
    };
}

function renderEntryLine(entry, index = 0) {
    let data = {};
    try {
        data = entry.resolution_json ? JSON.parse(entry.resolution_json) : {};
    } catch {
        data = {};
    }
    const status = entry.status || data.status || 'pending';
    const label = data.playerName || entry.raw_name || entry.raw_target || entry.raw_phone || '-';
    const id = entry.player_id || data.playerId || '-';
    return `> ${index + 1}. ${label} | ${status} | ${id}`;
}

function renderResolutionProblem(entry, index = 0) {
    let data = {};
    try {
        data = entry.resolution_json ? JSON.parse(entry.resolution_json) : {};
    } catch {
        data = {};
    }
    const details = formatTargetErrorDetails(data.details || {});
    return [
        `*${index + 1}. ${entry.raw_name || entry.raw_target || entry.raw_phone || '-'}*`,
        data.error ? `> ${data.error}` : '> alvo nao resolvido',
        ...details.map((line) => `> ${line.replace(/\*/g, '')}`),
    ].join('\n');
}

module.exports = {
    addRewardListEntry,
    createRewardList,
    ensureRewardListSchema,
    getResolvedRewardListTargets,
    getRewardList,
    listRewardEntries,
    normalizeSlug,
    parseAddArgs,
    parseImportBlock,
    renderEntryLine,
    renderResolutionProblem,
    resolveRewardList,
};
