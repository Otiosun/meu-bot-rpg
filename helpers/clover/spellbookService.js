const { normalizeText } = require('../textUtils');
const { isSameUser, normalizeJid } = require('../groupAccess');

const SPELL_TYPES = ['Criação', 'Reforço', 'Suporte', 'Misto'];

const FIELD_ALIASES = {
    nome: 'name',
    feitico: 'name',
    'nome do feitico': 'name',
    versao: 'version',
    'versao atual': 'version',
    tipo: 'type',
    categoria: 'type',
    custo: 'cost',
    gasto: 'cost',
    alcance: 'reach',
    distancia: 'reach',
    duracao: 'duration',
    efeito: 'effect',
    descricao: 'effect',
    'descricao do efeito': 'effect',
    limite: 'limits',
    limites: 'limits',
    fraqueza: 'limits',
    fraquezas: 'limits',
    'notas adm': 'admNotes',
    'nota adm': 'admNotes',
    notas: 'admNotes',
    observacao: 'admNotes',
    observacoes: 'admNotes',
};

function normalizeKey(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeSpellName(value) {
    return normalizeKey(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function cleanFieldLine(line) {
    return String(line || '')
        .replace(/^[>\s*_`-]+/, '')
        .replace(/[*_`]+/g, '')
        .trim();
}

function splitField(line) {
    const clean = cleanFieldLine(line);
    const colonMatch = clean.match(/^([^:：]{2,48})[:：]\s*(.*)$/);
    if (colonMatch) return { label: colonMatch[1], value: colonMatch[2] };

    const dashMatch = clean.match(/^([A-Za-zÀ-ÿ\s]{2,48})\s+-\s+(.*)$/);
    if (dashMatch) return { label: dashMatch[1], value: dashMatch[2] };

    return null;
}

function isDecorativeLine(line) {
    const text = String(line || '').trim();
    if (!text) return true;
    return (
        text.startsWith('♧┃')
        || text.startsWith('──')
        || text.startsWith('_`─(')
        || text.includes('─────')
    );
}

function parseVersion(value) {
    const match = String(value || '').match(/\d+/);
    if (!match) return null;
    const version = Number(match[0]);
    return Number.isInteger(version) && version > 0 ? version : null;
}

function normalizeSpellType(value) {
    const key = normalizeKey(value).replace(/\s+/g, ' ');
    const compact = key.replace(/\s+/g, '');
    if (!key) return null;
    if (key.includes('criacao')) return 'Criação';
    if (key.includes('reforco')) return 'Reforço';
    if (key.includes('suporte')) return 'Suporte';
    if (key.includes('misto') || key.includes('hibrido')) return 'Misto';
    return null;
}

function tidyValue(value) {
    const text = String(value || '').trim();
    if (text === '🔒') return '-';
    return text || '-';
}

function parseSpellSheet(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').trim();
    const fields = {
        name: '',
        version: null,
        type: '',
        cost: '',
        reach: '',
        duration: '',
        effect: '',
        limits: '',
        admNotes: '',
    };

    let currentField = null;
    for (const line of raw.split('\n')) {
        if (isDecorativeLine(line)) {
            currentField = null;
            continue;
        }

        const parsed = splitField(line);
        const fieldName = parsed ? FIELD_ALIASES[normalizeKey(parsed.label)] : null;
        if (fieldName) {
            currentField = fieldName;
            if (fieldName === 'version') {
                fields.version = parseVersion(parsed.value);
            } else {
                fields[fieldName] = parsed.value.trim();
            }
            continue;
        }

        const continuation = cleanFieldLine(line);
        if (currentField && continuation) {
            if (currentField === 'version') {
                fields.version = parseVersion(continuation);
            } else {
                fields[currentField] = `${fields[currentField] ? `${fields[currentField]}\n` : ''}${continuation}`;
            }
        }
    }

    const normalizedType = normalizeSpellType(fields.type);
    const result = {
        name: tidyValue(fields.name),
        normalizedName: normalizeSpellName(fields.name),
        version: fields.version,
        type: normalizedType,
        cost: tidyValue(fields.cost),
        reach: tidyValue(fields.reach),
        duration: tidyValue(fields.duration),
        effect: tidyValue(fields.effect),
        limits: tidyValue(fields.limits),
        admNotes: tidyValue(fields.admNotes),
    };

    const errors = [];
    if (!result.normalizedName || result.name === '-') errors.push('Nome');
    if (!result.type) errors.push(`Tipo (${SPELL_TYPES.join(' / ')})`);
    if (result.cost === '-') errors.push('Custo');
    if (result.reach === '-') errors.push('Alcance');
    if (result.duration === '-') errors.push('Duração');
    if (result.effect === '-') errors.push('Efeito');
    if (result.limits === '-') errors.push('Limites');

    return {
        ok: errors.length === 0,
        sheet: result,
        errors,
    };
}

async function ensureSpellbookSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_spellbook_spells (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            type TEXT NOT NULL,
            cost TEXT DEFAULT '-',
            reach TEXT DEFAULT '-',
            duration TEXT DEFAULT '-',
            effect TEXT NOT NULL,
            limits TEXT DEFAULT '-',
            adm_notes TEXT DEFAULT '-',
            status TEXT NOT NULL DEFAULT 'approved'
                CHECK (status IN ('approved', 'removed')),
            created_by TEXT DEFAULT NULL,
            updated_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            removed_at TEXT DEFAULT NULL,
            UNIQUE (player_id, normalized_name, version)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_spellbook_spells_player
        ON clover_spellbook_spells (player_id, normalized_name, version DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_spell_review_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'called', 'concluded', 'removed', 'cancelled')),
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            called_at TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            closed_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_spell_review_queue_active
        ON clover_spell_review_queue (player_id)
        WHERE status IN ('waiting', 'called')
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_spell_review_queue_status
        ON clover_spell_review_queue (status, requested_at, id)
    `);
}

async function getLatestVersion(db, playerId, normalizedName) {
    await ensureSpellbookSchema(db);
    const row = await db.get(
        `SELECT MAX(version) AS version
         FROM clover_spellbook_spells
         WHERE player_id = ? AND normalized_name = ?`,
        [playerId, normalizedName]
    );
    return Number(row?.version || 0);
}

async function saveSpell(db, playerId, sheet, adminId, options = {}) {
    await ensureSpellbookSchema(db);
    const latestVersion = await getLatestVersion(db, playerId, sheet.normalizedName);
    const version = options.nextVersion ? latestVersion + 1 : (sheet.version || 1);

    if (!options.nextVersion && !sheet.version && latestVersion > 0) {
        return {
            ok: false,
            code: 'already_exists',
            latestVersion,
        };
    }

    const duplicate = await db.get(
        `SELECT id FROM clover_spellbook_spells
         WHERE player_id = ? AND normalized_name = ? AND version = ?`,
        [playerId, sheet.normalizedName, version]
    );
    if (duplicate) {
        return {
            ok: false,
            code: 'version_exists',
            latestVersion,
        };
    }

    const result = await db.run(
        `INSERT INTO clover_spellbook_spells
         (player_id, name, normalized_name, version, type, cost, reach, duration,
          effect, limits, adm_notes, status, created_by, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, CURRENT_TIMESTAMP)`,
        [
            playerId,
            sheet.name,
            sheet.normalizedName,
            version,
            sheet.type,
            sheet.cost,
            sheet.reach,
            sheet.duration,
            sheet.effect,
            sheet.limits,
            sheet.admNotes,
            adminId,
            adminId,
        ]
    );

    const spell = await db.get(
        'SELECT * FROM clover_spellbook_spells WHERE id = ?',
        [result.lastID]
    );

    return {
        ok: true,
        spell,
        latestVersion,
        mode: options.nextVersion ? 'updated' : 'created',
    };
}

async function removeSpell(db, playerId, query, adminId) {
    await ensureSpellbookSchema(db);
    const found = await findSpell(db, playerId, query);
    if (!found.ok) return found;

    await db.run(
        `UPDATE clover_spellbook_spells
         SET status = 'removed',
             removed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = ?
         WHERE player_id = ? AND normalized_name = ? AND status = 'approved'`,
        [adminId, playerId, found.spell.normalized_name]
    );

    return { ok: true, spell: found.spell };
}

async function listApprovedSpells(db, playerId) {
    await ensureSpellbookSchema(db);
    return db.all(
        `SELECT s.*
         FROM clover_spellbook_spells s
         JOIN (
            SELECT normalized_name, MAX(version) AS version
            FROM clover_spellbook_spells
            WHERE player_id = ? AND status = 'approved' AND removed_at IS NULL
            GROUP BY normalized_name
         ) latest
           ON latest.normalized_name = s.normalized_name
          AND latest.version = s.version
         WHERE s.player_id = ? AND s.status = 'approved' AND s.removed_at IS NULL
         ORDER BY s.name COLLATE NOCASE`,
        [playerId, playerId]
    );
}

async function findSpell(db, playerId, query) {
    await ensureSpellbookSchema(db);
    const normalizedQuery = normalizeSpellName(query);
    if (!normalizedQuery) return { ok: false, code: 'missing_query' };

    const exact = await db.get(
        `SELECT *
         FROM clover_spellbook_spells
         WHERE player_id = ?
           AND normalized_name = ?
           AND status = 'approved'
           AND removed_at IS NULL
         ORDER BY version DESC
         LIMIT 1`,
        [playerId, normalizedQuery]
    );
    if (exact) return { ok: true, spell: exact };

    const spells = await listApprovedSpells(db, playerId);
    const matches = spells.filter((spell) => (
        spell.normalized_name.includes(normalizedQuery)
        || normalizedQuery.includes(spell.normalized_name)
        || normalizeKey(spell.name).includes(normalizeKey(query))
    ));

    if (matches.length === 1) return { ok: true, spell: matches[0] };
    if (matches.length > 1) return { ok: false, code: 'ambiguous', matches };
    return { ok: false, code: 'not_found' };
}

async function getActiveQueueEntry(db, playerId) {
    await ensureSpellbookSchema(db);
    return db.get(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE player_id = ? AND status IN ('waiting', 'called')
         ORDER BY id DESC
         LIMIT 1`,
        [playerId]
    );
}

async function getQueuePosition(db, entry) {
    if (!entry || entry.status !== 'waiting') return null;
    const row = await db.get(
        `SELECT COUNT(*) AS count
         FROM clover_spell_review_queue
         WHERE status = 'waiting'
           AND (requested_at < ? OR (requested_at = ? AND id < ?))`,
        [entry.requested_at, entry.requested_at, entry.id]
    );
    return Number(row?.count || 0) + 1;
}

async function enterQueue(db, playerId) {
    await ensureSpellbookSchema(db);
    const active = await getActiveQueueEntry(db, playerId);
    if (active) {
        return {
            ok: false,
            code: 'already_active',
            entry: active,
            position: await getQueuePosition(db, active),
        };
    }

    const result = await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES (?, 'waiting')`,
        [playerId]
    );
    const entry = await db.get(
        'SELECT * FROM clover_spell_review_queue WHERE id = ?',
        [result.lastID]
    );
    return {
        ok: true,
        entry,
        position: await getQueuePosition(db, entry),
    };
}

async function cancelQueueEntry(db, playerId, closedBy, reason = null) {
    return closeQueueEntry(db, playerId, 'cancelled', closedBy, reason);
}

async function listActiveQueue(db) {
    await ensureSpellbookSchema(db);
    return db.all(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE status IN ('called', 'waiting')
         ORDER BY CASE status WHEN 'called' THEN 0 ELSE 1 END, requested_at, id`
    );
}

async function callNextQueueEntry(db, adminId, options = {}) {
    await ensureSpellbookSchema(db);
    const called = await db.get(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE status = 'called'
         ORDER BY called_at, id
         LIMIT 1`
    );
    if (called) return { ok: false, code: 'already_called', entry: called };

    const excludedPlayerId = options.excludePlayerId || null;
    const next = await db.get(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE status = 'waiting'
           AND (? IS NULL OR player_id != ?)
         ORDER BY requested_at, id
         LIMIT 1`,
        [excludedPlayerId, excludedPlayerId]
    );
    if (!next) return { ok: false, code: 'empty' };

    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'called',
             called_at = CURRENT_TIMESTAMP,
             closed_by = ?
         WHERE id = ?`,
        [adminId, next.id]
    );

    return {
        ok: true,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [next.id]),
    };
}

async function requeueActiveQueueEntry(db, playerId, closedBy, reason = null) {
    await ensureSpellbookSchema(db);
    const entry = await getActiveQueueEntry(db, playerId);
    if (!entry) return { ok: false, code: 'not_active' };

    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'waiting',
             requested_at = CURRENT_TIMESTAMP,
             called_at = NULL,
             closed_at = NULL,
             closed_by = ?,
             reason = ?
         WHERE id = ?`,
        [closedBy, reason || null, entry.id]
    );

    return {
        ok: true,
        previousStatus: entry.status,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entry.id]),
    };
}

async function resetSpellReviewQueue(db, closedBy, reason = 'resetado pelo dono') {
    await ensureSpellbookSchema(db);
    const entries = await listActiveQueue(db);

    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'cancelled',
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?
         WHERE status IN ('waiting', 'called')`,
        [closedBy, reason]
    );

    return {
        ok: true,
        cancelled: entries.length,
        called: entries.filter((entry) => entry.status === 'called').length,
        waiting: entries.filter((entry) => entry.status === 'waiting').length,
    };
}

async function findCalledQueueEntryForCandidates(db, candidates) {
    await ensureSpellbookSchema(db);
    const normalizedCandidates = [...new Set((candidates || [])
        .map((candidate) => normalizeJid(candidate))
        .filter(Boolean))];
    if (!normalizedCandidates.length) return null;

    const rows = await db.all(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE status = 'called'
         ORDER BY called_at, id`
    );

    return rows.find((entry) => normalizedCandidates.some((candidate) => (
        isSameUser(entry.player_id, candidate)
        || normalizeJid(entry.player_id) === candidate
    ))) || null;
}

async function closeQueueEntry(db, playerId, status, closedBy, reason = null) {
    await ensureSpellbookSchema(db);
    const entry = await getActiveQueueEntry(db, playerId);
    if (!entry) return { ok: false, code: 'not_active' };

    await db.run(
        `UPDATE clover_spell_review_queue
         SET status = ?,
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?
         WHERE id = ?`,
        [status, closedBy, reason || null, entry.id]
    );

    return {
        ok: true,
        entry: await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [entry.id]),
    };
}

function formatBlock(value) {
    const text = String(value || '-').trim() || '-';
    return text.split('\n').map((line) => `> ${line.trim() || '-'}`).join('\n');
}

function renderSpellSheetTemplate() {
    return [
        '♧┃FICHA DE FEITIÇO 𖥔 CLOVER MULTICOLOR',
        '     ── avaliação rápida do grimório ──',
        '',
        '_`─( ✓ )───── Identificação`_',
        '',
        '*Nome do feitiço:*',
        '> ',
        '*Tipo:*',
        '> Criação / Reforço / Suporte / Misto',
        '*Versão:*',
        '> v1',
        '',
        '_`─( ✦ )───── Uso`_',
        '',
        '*Custo:*',
        '> 🔒',
        '*Alcance:*',
        '> 🔒',
        '*Duração:*',
        '> 🔒',
        '',
        '_`─( ◆ )───── Efeito`_',
        '',
        '*Descrição:*',
        '> ',
        '',
        '_`─( ◇ )───── Travas`_',
        '',
        '*Limites:*',
        '> 🔒',
        '*Notas ADM:*',
        '> 🔒',
    ].join('\n');
}

function renderSpellUsage(prefix = '.#') {
    return [
        '♧┃FEITIÇOS 𖥔 CLOVER MULTICOLOR',
        '',
        `*Ver ficha modelo:* ${prefix}fichafeitico`,
        `*Ver grimório:* ${prefix}grimorio`,
        `*Ver feitiço:* ${prefix}feitico Nome do Feitiço`,
        '',
        '*ADM:*',
        `> ${prefix}addfeitico @player`,
        '> Nome: Mão de Lama',
        '> Tipo: Criação',
        '> Custo: 80 mana',
        '> Alcance: curto',
        '> Duração: 1 turno',
        '> Efeito: ...',
        '> Limites: ...',
        '',
        `*Atualizar versão:* ${prefix}upfeitico @player + ficha`,
        `*Remover:* ${prefix}removerfeitico @player Nome do Feitiço`,
    ].join('\n');
}

function renderSpellCard(spell, title = 'FEITIÇO DO GRIMÓRIO') {
    return [
        `♧┃${title} 𖥔 CLOVER MULTICOLOR`,
        '     ── versão salva pelo ADM ──',
        '',
        '_`─( ✦ )───── Identificação`_',
        '',
        `*Nome:* ${spell.name}`,
        `*Versão:* v${spell.version}`,
        `*Tipo:* ${spell.type}`,
        `*Custo:* ${spell.cost}`,
        `*Alcance:* ${spell.reach}`,
        `*Duração:* ${spell.duration}`,
        '',
        '_`─( ◆ )───── Efeito`_',
        '',
        formatBlock(spell.effect),
        '',
        '_`─( ◇ )───── Limites`_',
        '',
        formatBlock(spell.limits),
        '',
        '_`─( ■ )───── Notas ADM`_',
        '',
        formatBlock(spell.adm_notes),
    ].join('\n');
}

function renderGrimoire(playerLabel, spells) {
    if (!spells.length) {
        return [
            '♧┃GRIMÓRIO DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
            '',
            `*Personagem:* ${playerLabel}`,
            '',
            'Nenhum feitiço aprovado salvo ainda.',
        ].join('\n');
    }

    return [
        '♧┃GRIMÓRIO DE FEITIÇOS 𖥔 CLOVER MULTICOLOR',
        '',
        `*Personagem:* ${playerLabel}`,
        `*Total:* ${spells.length}`,
        '',
        ...spells.map((spell, index) => [
            `*${index + 1}. ${spell.name}* (v${spell.version})`,
            `> Tipo: ${spell.type}`,
            `> Custo: ${spell.cost} | Alcance: ${spell.reach} | Duração: ${spell.duration}`,
        ].join('\n')),
        '',
        'Use *.#feitico Nome do Feitiço* para abrir a ficha completa.',
    ].join('\n');
}

module.exports = {
    SPELL_TYPES,
    callNextQueueEntry,
    cancelQueueEntry,
    closeQueueEntry,
    enterQueue,
    ensureSpellbookSchema,
    findSpell,
    findCalledQueueEntryForCandidates,
    getActiveQueueEntry,
    getQueuePosition,
    listActiveQueue,
    listApprovedSpells,
    normalizeSpellName,
    parseSpellSheet,
    requeueActiveQueueEntry,
    removeSpell,
    resetSpellReviewQueue,
    renderGrimoire,
    renderSpellCard,
    renderSpellSheetTemplate,
    renderSpellUsage,
    saveSpell,
};
