const { normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    formatMention,
    playerDisplayName,
    resolveTargetPlayer,
} = require('./commandTargetUtils');
const {
    applySimulation,
    createSimulation,
} = require('./cloverScriptService');

const RAID_STATUSES = new Set(['rascunho', 'aberta', 'fechada', 'avaliacao', 'simulada', 'aplicada', 'cancelada']);
const PARTICIPANT_STATUSES = new Set(['inscrito', 'espera', 'presente', 'ausente', 'desistiu', 'removido']);

function normalizeKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1);
    }
    return text;
}

function tokenize(line) {
    return [...String(line || '').matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)]
        .map((match) => stripQuotes(match[0]));
}

function parseKv(text) {
    const kv = {};
    const regex = /([A-Za-zÀ-ÿ0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        kv[normalizeKey(match[1])] = stripQuotes(match[2]);
    }
    return kv;
}

function normalizeRaidCode(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serialize(value) {
    return JSON.stringify(value || {});
}

async function ensureRaidSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'rascunho',
            slots INTEGER DEFAULT NULL,
            event_date TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            simulation_code TEXT DEFAULT NULL,
            applied_run_code TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'inscrito',
            tags_json TEXT DEFAULT '[]',
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (raid_id, player_id)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            target_kind TEXT NOT NULL DEFAULT 'base',
            player_id TEXT DEFAULT NULL,
            reward_text TEXT NOT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function getRaidByCode(db, code) {
    await ensureRaidSchema(db);
    return db.get('SELECT * FROM clover_raids WHERE code = ?', [normalizeRaidCode(code)]);
}

async function getRaidView(db, code) {
    const raid = await getRaidByCode(db, code);
    if (!raid) return null;
    const participants = await db.all(
        `SELECT p.*, j.personagem_nome, j.display_name, j.nome
         FROM clover_raid_participants p
         LEFT JOIN jogadores j ON j.id = p.player_id
         WHERE p.raid_id = ?
         ORDER BY p.id ASC`,
        [raid.id]
    );
    const rewards = await db.all(
        'SELECT * FROM clover_raid_rewards WHERE raid_id = ? ORDER BY id ASC',
        [raid.id]
    );
    return { raid, participants, rewards };
}

async function createRaid(db, { code, name, slots = null, eventDate = null, createdBy = null, metadata = {} }) {
    await ensureRaidSchema(db);
    const normalizedCode = normalizeRaidCode(code);
    if (!normalizedCode) return { ok: false, error: 'Informe codigo= para a raid.' };
    const raidName = String(name || normalizedCode).trim();
    const existing = await getRaidByCode(db, normalizedCode);
    if (existing) return { ok: false, error: 'Já existe uma raid com esse código.', raid: existing };
    const result = await db.run(
        `INSERT INTO clover_raids
         (code, name, status, slots, event_date, created_by, created_at, updated_at, metadata_json)
         VALUES (?, ?, 'rascunho', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [normalizedCode, raidName, slots ? Number(slots) : null, eventDate || null, createdBy, serialize(metadata)]
    );
    return { ok: true, raid: await db.get('SELECT * FROM clover_raids WHERE id = ?', [result.lastID]) };
}

async function updateRaidStatus(db, code, status) {
    await ensureRaidSchema(db);
    const normalized = normalizeKey(status);
    if (!RAID_STATUSES.has(normalized)) return { ok: false, error: 'Status de raid inválido.' };
    const raid = await getRaidByCode(db, code);
    if (!raid) return { ok: false, error: 'Raid não encontrada.' };
    await db.run(
        'UPDATE clover_raids SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [normalized, raid.id]
    );
    return { ok: true, raid: await getRaidByCode(db, code) };
}

function makeTargetResolver(mentions = []) {
    let mentionIndex = 0;
    return async function resolve(db, token) {
        const text = String(token || '').trim();
        if (!text) return null;
        if (text.startsWith('@')) {
            const digits = text.replace(/\D/g, '');
            if (digits.length >= 4) {
                const result = await resolveTargetPlayer(db, null, digits, { mechanical: true });
                if (!result.ok) throw new Error(result.error || `Player não encontrado: ${text}`);
                return result.player;
            }
            const mentioned = mentions[mentionIndex];
            if (mentioned) {
                mentionIndex += 1;
                const result = await resolveTargetPlayer(db, normalizeJid(mentioned), '', { mechanical: true });
                if (!result.ok) throw new Error(result.error || `Player nÃ£o encontrado: ${text}`);
                return result.player;
            }
        }
        const kv = parseKv(text);
        const identifier = kv.tel || kv.id || kv.nome || text;
        const result = await resolveTargetPlayer(db, null, identifier, { mechanical: true });
        if (!result.ok) throw new Error(result.error || `Player não encontrado: ${text}`);
        return result.player;
    };
}

async function addParticipants(db, raidCode, tokens, { mentions = [], status = 'inscrito' } = {}) {
    await ensureRaidSchema(db);
    const raid = await getRaidByCode(db, raidCode);
    if (!raid) return { ok: false, error: 'Raid não encontrada.' };
    const normalizedStatus = normalizeKey(status);
    if (!PARTICIPANT_STATUSES.has(normalizedStatus)) return { ok: false, error: 'Status de participante inválido.' };
    const resolve = makeTargetResolver(mentions);
    const added = [];
    for (const token of tokens) {
        const player = await resolve(db, token);
        if (!player?.id) continue;
        await db.run(
            `INSERT INTO clover_raid_participants (raid_id, player_id, status, joined_at, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(raid_id, player_id) DO UPDATE SET
                 status = excluded.status,
                 updated_at = CURRENT_TIMESTAMP`,
            [raid.id, player.id, normalizedStatus]
        );
        added.push(player);
    }
    return { ok: true, raid, added };
}

async function removeParticipant(db, raidCode, token, options = {}) {
    const raid = await getRaidByCode(db, raidCode);
    if (!raid) return { ok: false, error: 'Raid não encontrada.' };
    const resolve = makeTargetResolver(options.mentions || []);
    const player = await resolve(db, token);
    await db.run(
        `UPDATE clover_raid_participants
         SET status = 'removido', updated_at = CURRENT_TIMESTAMP
         WHERE raid_id = ? AND player_id = ?`,
        [raid.id, player.id]
    );
    return { ok: true, raid, player };
}

async function markParticipants(db, raidCode, tokens, status, options = {}) {
    const raid = await getRaidByCode(db, raidCode);
    if (!raid) return { ok: false, error: 'Raid não encontrada.' };
    const normalizedStatus = normalizeKey(status);
    if (!PARTICIPANT_STATUSES.has(normalizedStatus)) return { ok: false, error: 'Status de participante inválido.' };
    let playerIds = [];
    if (tokens.length === 1 && normalizeKey(tokens[0]) === 'todos') {
        const rows = await db.all(
            `SELECT player_id FROM clover_raid_participants
             WHERE raid_id = ? AND status NOT IN ('removido', 'desistiu')`,
            [raid.id]
        );
        playerIds = rows.map((row) => row.player_id);
    } else {
        const resolve = makeTargetResolver(options.mentions || []);
        for (const token of tokens) {
            const player = await resolve(db, token);
            playerIds.push(player.id);
        }
    }
    for (const playerId of playerIds) {
        await db.run(
            `UPDATE clover_raid_participants
             SET status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE raid_id = ? AND player_id = ?`,
            [normalizedStatus, raid.id, playerId]
        );
    }
    return { ok: true, raid, count: playerIds.length, status: normalizedStatus };
}

async function setRaidRewards(db, raidCode, rewards, createdBy) {
    const raid = await getRaidByCode(db, raidCode);
    if (!raid) return { ok: false, error: 'Raid não encontrada.' };
    await db.run('DELETE FROM clover_raid_rewards WHERE raid_id = ?', [raid.id]);
    for (const reward of rewards) {
        await db.run(
            `INSERT INTO clover_raid_rewards
             (raid_id, target_kind, player_id, reward_text, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [raid.id, reward.targetKind, reward.playerId || null, reward.text, createdBy]
        );
    }
    return { ok: true, raid, count: rewards.length };
}

function meaningfulLines(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw) => ({ raw, text: raw.trim() }))
        .filter((item) => item.text && !item.text.startsWith('//'));
}

async function parseRaidLongForm(db, text, { mentions = [], createdBy = null } = {}) {
    const lines = meaningfulLines(text);
    const rewards = [];
    const participants = [];
    const resolve = makeTargetResolver(mentions);
    let index = 0;
    while (index < lines.length) {
        const tokens = tokenize(lines[index].text);
        const head = normalizeKey(tokens[0]);
        if (head === 'participantes') {
            index += 1;
            while (index < lines.length && normalizeKey(lines[index].text) !== 'fim_participantes') {
                for (const token of tokenize(lines[index].text)) {
                    const player = await resolve(db, token);
                    participants.push(`id="${player.id}"`);
                }
                index += 1;
            }
            index += 1;
            continue;
        }
        if (head === 'recompensa') {
            const targetKind = normalizeKey(tokens[1] || 'base');
            const rewardLines = [];
            index += 1;
            while (index < lines.length && normalizeKey(lines[index].text) !== 'fim_recompensa') {
                rewardLines.push(lines[index].raw);
                index += 1;
            }
            rewards.push({ targetKind, playerId: null, text: rewardLines.join('\n').trim(), createdBy });
            index += 1;
            continue;
        }
        if (head === 'mvp' || head === 'destaque') {
            const player = await resolve(db, tokens[1]);
            const rewardLines = [];
            index += 1;
            const end = head === 'mvp' ? 'fim_mvp' : 'fim_destaque';
            while (index < lines.length && normalizeKey(lines[index].text) !== end) {
                rewardLines.push(lines[index].raw);
                index += 1;
            }
            rewards.push({ targetKind: head, playerId: player.id, text: rewardLines.join('\n').trim(), createdBy });
            index += 1;
            continue;
        }
        index += 1;
    }
    return { participants, rewards };
}

function participantActive(status) {
    return !['removido', 'ausente', 'desistiu'].includes(normalizeKey(status));
}

async function generateRaidScript(db, raidCode) {
    const view = await getRaidView(db, raidCode);
    if (!view) return { ok: false, error: 'Raid não encontrada.' };
    const { raid, participants, rewards } = view;
    const active = participants.filter((item) => participantActive(item.status));
    const lines = [
        `LOTE id="raid-${raid.code}" nome="${raid.name.replace(/"/g, "'")}" modo=rigido${raid.event_date ? ` data=${raid.event_date}` : ''}`,
        '',
    ];
    for (const reward of rewards) {
        if (!reward.reward_text) continue;
        if (reward.target_kind === 'base') {
            if (!active.length) continue;
            lines.push(`ALVOS ${active.map((item) => `id="${item.player_id}"`).join(' ')}`);
            lines.push(reward.reward_text);
            lines.push('FIM');
            lines.push('');
            continue;
        }
        if (reward.player_id) {
            lines.push(`ALVO id="${reward.player_id}"`);
            lines.push(reward.reward_text);
            lines.push('FIM');
            lines.push('');
        }
    }
    return { ok: true, raid, script: lines.join('\n').trim() };
}

async function simulateRaidRewards(db, raidCode, options = {}) {
    const generated = await generateRaidScript(db, raidCode);
    if (!generated.ok) return generated;
    if (!generated.script.includes('ALVO')) return { ok: false, error: 'Raid não tem recompensas/participantes para simular.' };
    const simulation = await createSimulation(db, generated.script, {
        actorId: options.actorId,
        chatId: options.chatId,
        mentions: [],
        source: `raid:${raidCode}`,
    });
    await db.run(
        `UPDATE clover_raids
         SET status = 'simulada', simulation_code = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [simulation.code, generated.raid.id]
    );
    return { ok: true, ...simulation, raid: generated.raid, script: generated.script };
}

async function applyRaidRewards(db, raidCode, options = {}) {
    const raid = await getRaidByCode(db, raidCode);
    if (!raid) return { ok: false, error: 'Raid não encontrada.' };
    const code = raid.simulation_code;
    if (!code) return { ok: false, error: 'Simule a raid antes de aplicar.' };
    const applied = await applySimulation(db, {
        code,
        actorId: options.actorId,
        chatId: options.chatId,
        sock: options.sock,
    });
    if (applied.ok) {
        await db.run(
            `UPDATE clover_raids
             SET status = 'aplicada', applied_run_code = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [code, raid.id]
        );
    }
    return applied;
}

function renderRaidView(view) {
    if (!view) return '*♧┃RAID 𖥔 CLOVER MULTICOLOR*\n\n> Raid não encontrada.';
    const { raid, participants, rewards } = view;
    const active = participants.filter((item) => participantActive(item.status));
    return [
        '*♧┃RAID 𖥔 CLOVER MULTICOLOR*',
        '     ── lobby de evento ──',
        '',
        '_`─( ✓ )───── Dados`_',
        '',
        `*Código:* ${raid.code}`,
        `*Nome:* ${raid.name}`,
        `*Status:* ${raid.status}`,
        `*Data:* ${raid.event_date || '-'}`,
        `*Vagas:* ${raid.slots || 'sem limite'}`,
        '',
        '_`─( ◆ )───── Participantes`_',
        '',
        `*Ativos:* ${active.length}`,
        `*Total:* ${participants.length}`,
        ...participants.slice(0, 12).map((item, index) => (
            `*${index + 1}. ${playerDisplayName(item, item.player_id)}* (${formatMention(item.player_id)})\n> ${item.status}`
        )),
        participants.length > 12 ? `> ...e mais ${participants.length - 12}.` : null,
        '',
        '_`─( ◇ )───── Recompensas`_',
        '',
        rewards.length ? `*Blocos:* ${rewards.length}` : '> Nenhuma recompensa registrada.',
        raid.simulation_code ? `*Simulação:* ${raid.simulation_code}` : null,
    ].filter(Boolean).join('\n');
}

function renderRaidCreated(result, view = null) {
    const raid = result.raid;
    return [
        '*♧┃RAID CRIADA 𖥔 CLOVER MULTICOLOR*',
        '     ── lobby registrado ──',
        '',
        `*Código:* ${raid.code}`,
        `*Nome:* ${raid.name}`,
        `*Status:* ${raid.status}`,
        `*Vagas:* ${raid.slots || 'sem limite'}`,
        view ? `*Participantes:* ${view.participants.length}` : null,
        view ? `*Recompensas:* ${view.rewards.length}` : null,
    ].filter(Boolean).join('\n');
}

module.exports = {
    addParticipants,
    applyRaidRewards,
    createRaid,
    ensureRaidSchema,
    generateRaidScript,
    getRaidByCode,
    getRaidView,
    markParticipants,
    parseKv,
    parseRaidLongForm,
    removeParticipant,
    renderRaidCreated,
    renderRaidView,
    setRaidRewards,
    simulateRaidRewards,
    tokenize,
    updateRaidStatus,
};
