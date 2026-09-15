const crypto = require('crypto');

const { COMMAND_PREFIX } = require('../../config/bot');
const {
    ensureCloverInventorySchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverSquadSchema,
} = require('../../database');
const { isOwner, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    assertMechanicalTarget,
    formatMention,
    getPlayerById,
    playerDisplayName,
    resolveTargetPlayer,
} = require('./commandTargetUtils');
const { getResolvedRewardListTargets } = require('./rewardListService');
const { formatStars, formatYulls, normalizeSquadKey } = require('./cavalierService');
const { adminAdjustYulls } = require('./yullsService');
const { applyAttributeUpgrade, getCharacterStats } = require('./characterStats');
const {
    addPh,
    adminAdjustPh,
    getPhSummary,
} = require('./phService');
const { parseSpellSheet, removeSpell, saveSpell } = require('./spellbookService');
const { setHexagonSide } = require('./hexagonService');
const { buyNode } = require('./skillTreeService');
const { getTree, normalizeKey } = require('./treeLoader');
const {
    createReturnBonus,
    removePlayerForAntiGhost,
    resetPlayerActivity,
    setExemption,
} = require('./antiGhostService');
const {
    ensureCharacterBonusSchema,
    getCustomCharacterBonuses,
} = require('./characterBonusService');
const {
    ensureSquad,
    syncSquadGroupDescription,
    updateSquadPhrase,
} = require('./squadService');
const { resolvePlayerSquadMembership } = require('./squadMembershipReadService');

const RUN_STATUS = {
    SIMULATED: 'simulated',
    APPLIED: 'applied',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};

const SAFE_PERSON_FIELDS = new Set([
    'personagem_nome',
    'personagem_idade',
    'personagem_genero',
    'reino',
    'classe',
    'familia',
    'raca',
    'grimorio',
    'magia',
    'esquadrao',
    'patente',
    'gancho_narrativo',
]);

const TRAIT_FIELDS = new Set([
    'aptidao_comum',
    'marca_comum',
    'aptidao_rara',
    'marca_rara',
    'anomalia',
    'gancho_narrativo',
]);

const STATUS_FIELDS = {
    jogo: 'jogo_status',
    historia: 'historia_status',
    aparencia: 'personagem_aparencia_status',
    ficha: 'ficha_status',
};

const MODALITY_BY_SOURCE = {
    autonarrada: { key: 'missao_auto_narrada', label: 'Missão Auto-Narrada', weekly: true },
    auto_narrada: { key: 'missao_auto_narrada', label: 'Missão Auto-Narrada', weekly: true },
    missao_auto_narrada: { key: 'missao_auto_narrada', label: 'Missão Auto-Narrada', weekly: true },
    spin_off: { key: 'spin_off', label: 'Spin-Off', bypassWeekly: true },
    spinoff: { key: 'spin_off', label: 'Spin-Off', bypassWeekly: true },
    missao_desenvolvimento: { key: 'missao_desenvolvimento', label: 'Missão de Desenvolvimento', bypassWeekly: true },
    desenvolvimento: { key: 'missao_desenvolvimento', label: 'Missão de Desenvolvimento', bypassWeekly: true },
    treino_solo: { key: 'treino_solo', label: 'Treino Solo', weekly: true },
    treino_duo: { key: 'treino_duo', label: 'Treino Duo', weekly: true },
    cena_interativa: { key: 'cena_interativa', label: 'Cena Interativa', weekly: true },
    cena_vinculo: { key: 'cena_vinculo', label: 'Cena de Vínculo', weekly: true },
    cena_consequencia: { key: 'cena_consequencia', label: 'Cena de Consequência', weekly: true },
    diario: { key: 'diario', label: 'Diário', weekly: true },
    evento: { key: 'evento', label: 'Evento', bypassWeekly: true },
    retorno: { key: 'retorno', label: 'Retorno', bypassWeekly: true },
    outro: { key: 'outro', label: 'Outro', weekly: true },
};

const WEEKLY_COMMON_PH_LIMIT = 30;

class CloverScriptError extends Error {
    constructor(message, line = null, code = 'invalid_script', details = null) {
        super(message);
        this.name = 'CloverScriptError';
        this.line = line;
        this.code = code;
        this.details = details || null;
    }
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function nowSqlite() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function parseDateInput(value, fallback = null) {
    const text = String(value || '').trim();
    if (!text) return fallback;
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return null;
    const date = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4] || 12),
        Number(match[5] || 0),
        Number(match[6] || 0),
        0
    );
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getWeekStart(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    return start;
}

function toSqliteDate(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return nowSqlite();
    return value.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeWord(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeSource(value) {
    return normalizeWord(value || 'outro') || 'outro';
}

function normalizeSearch(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeStatusValue(value) {
    return normalizeWord(value).replace(/_/g, ' ');
}

function parseIntStrict(value, line, label) {
    const text = String(value || '').trim();
    if (!/^[+-]?\d+$/.test(text)) {
        throw new CloverScriptError(`${label} precisa ser número inteiro.`, line);
    }
    return Number(text);
}

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return text;
}

function tokenize(line) {
    return [...String(line || '').matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)]
        .map((match) => stripQuotes(match[0]));
}

function parseKv(line) {
    const kv = {};
    const regex = /([A-Za-zÀ-ÿ0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(line))) {
        kv[normalizeWord(match[1])] = stripQuotes(match[2]);
    }
    return kv;
}

function positionalAfterCommandOp(line) {
    const text = String(line || '').trim();
    const withoutCommand = text.replace(/^\S+\s+\S+\s*/, '').trim();
    if (!withoutCommand) return '';
    const firstKv = withoutCommand.search(/\b[A-Za-z0-9_]+=/);
    const positional = firstKv >= 0 ? withoutCommand.slice(0, firstKv) : withoutCommand;
    return stripQuotes(positional.trim());
}

function hasTrue(value) {
    const normalized = normalizeWord(value);
    return ['true', 'sim', 'yes', '1', 'confirmar'].includes(normalized);
}

function removeCommandPrefix(text) {
    const raw = String(text || '').trim();
    const firstLineBreak = raw.indexOf('\n');
    if (firstLineBreak < 0) return '';
    return raw.slice(firstLineBreak + 1).trim();
}

function hashScript(scriptText) {
    return crypto.createHash('sha256').update(String(scriptText || ''), 'utf8').digest('hex');
}

function generateCode() {
    return `CS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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

async function ensureCloverScriptSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_script_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            batch_id TEXT DEFAULT NULL,
            batch_name TEXT DEFAULT NULL,
            mode TEXT DEFAULT 'rigido',
            script_hash TEXT NOT NULL,
            script_text TEXT NOT NULL,
            plan_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'simulated',
            created_by TEXT DEFAULT NULL,
            applied_by TEXT DEFAULT NULL,
            chat_id TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            applied_at TEXT DEFAULT NULL,
            error TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_script_runs_status
        ON clover_script_runs (status, created_by, chat_id, created_at DESC)
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_script_runs_batch_applied
        ON clover_script_runs (batch_id)
        WHERE status = 'applied' AND batch_id IS NOT NULL
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_script_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            player_id TEXT DEFAULT NULL,
            action_type TEXT NOT NULL,
            summary TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT DEFAULT NULL,
            before_json TEXT DEFAULT NULL,
            after_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

function meaningfulLines(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw, index) => ({ raw, text: raw.trim(), line: index + 1 }))
        .filter((item) => item.text && !item.text.startsWith('//'));
}

function parseHeader(line) {
    const kv = parseKv(line.text);
    return {
        id: kv.id || null,
        name: kv.nome || kv.name || null,
        mode: normalizeWord(kv.modo || kv.mode || 'rigido') || 'rigido',
        dateText: kv.data || kv.date || null,
        confirm: hasTrue(kv.confirmar || kv.confirm),
    };
}

function parseTargetToken(token, state) {
    const text = String(token || '').trim();
    if (!text) return null;
    const kv = parseKv(text);
    if (kv.tel) return { kind: 'identifier', value: kv.tel, raw: text };
    if (kv.id) return { kind: 'identifier', value: kv.id, raw: text };
    if (kv.nome) return { kind: 'name', value: kv.nome, raw: text, requiresConfirm: true };
    if (normalizeWord(text) === 'resposta') return { kind: 'quote', value: 'resposta', raw: text };
    if (text.startsWith('@')) {
        const digits = text.replace(/\D/g, '');
        if (digits.length >= 4) return { kind: 'identifier', value: digits, raw: text };
        const mentioned = state.mentions[state.mentionIndex];
        if (mentioned) {
            state.mentionIndex += 1;
            return { kind: 'jid', value: normalizeJid(mentioned), raw: text };
        }
        return { kind: 'identifier', value: text.replace(/^@/, ''), raw: text };
    }
    return { kind: 'identifier', value: text, raw: text };
}

function parseTargets(line, state) {
    const tokens = tokenize(line.text);
    const keyword = normalizeWord(tokens[0]);
    if (!['alvo', 'alvos', 'todos'].includes(keyword)) {
        throw new CloverScriptError('Bloco precisa começar com ALVO, ALVOS ou TODOS.', line.line);
    }
    const lineKv = parseKv(line.text);
    if (keyword === 'todos') {
        const gameStatus = normalizeStatusValue(lineKv.jogo || lineKv.game || 'liberado') || 'liberado';
        if (gameStatus !== 'liberado') {
            throw new CloverScriptError('TODOS aceita apenas jogo=liberado por enquanto.', line.line, 'invalid_global_target', { target: line.text });
        }
        return [{
            kind: 'all',
            filter: { gameStatus },
            raw: line.text,
            line: line.line,
        }];
    }
    const listName = lineKv.lista || lineKv.list || null;
    if (listName) {
        return [{
            kind: 'list',
            value: listName,
            raw: line.text,
            line: line.line,
        }];
    }
    const compositePhone = lineKv.tel || lineKv.telefone || lineKv.phone || null;
    const compositeId = lineKv.id || null;
    const compositeName = lineKv.personagem || lineKv.nome || lineKv.name || null;
    if (keyword === 'alvo' && (compositePhone || compositeId || compositeName)) {
        return [{
            kind: 'composite',
            value: compositePhone || compositeId || compositeName,
            phone: compositePhone,
            id: compositeId,
            name: compositeName,
            raw: line.text,
            line: line.line,
        }];
    }

    const targets = tokens.slice(1).map((token) => {
        const target = parseTargetToken(token, state);
        return target ? { ...target, line: line.line } : null;
    }).filter(Boolean);
    if (!targets.length) {
        throw new CloverScriptError('ALVO sem player.', line.line);
    }
    return targets;
}

function collectLongBlock(lines, index, startWord, endWord) {
    const start = lines[index];
    if (!start || normalizeWord(start.text) !== normalizeWord(startWord)) return null;
    const collected = [];
    let cursor = index + 1;
    while (cursor < lines.length && normalizeWord(lines[cursor].text) !== normalizeWord(endWord)) {
        collected.push(lines[cursor].raw);
        cursor += 1;
    }
    if (cursor >= lines.length) {
        throw new CloverScriptError(`Bloco ${startWord} sem ${endWord}.`, start.line);
    }
    return {
        text: collected.join('\n').trim(),
        nextIndex: cursor + 1,
    };
}

function parsePhAction(line, header) {
    const tokens = tokenize(line.text);
    const op = tokens[1];
    if (!op) throw new CloverScriptError('PH precisa de valor. Exemplo: PH +30 ...', line.line);
    const kv = parseKv(line.text);
    if (normalizeWord(op) === 'set') {
        return { type: 'ph_set', kv, line: line.line, dangerous: true };
    }
    const amount = parseIntStrict(op, line.line, 'PH');
    if (amount === 0) throw new CloverScriptError('PH não pode ser zero.', line.line);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('PH precisa de motivo="...".', line.line);
    return {
        type: 'ph',
        amount,
        source: normalizeSource(kv.fonte || kv.source || 'outro'),
        cap: normalizeWord(kv.teto || kv.cap || ''),
        dateText: kv.data || kv.date || header.dateText || null,
        reason,
        line: line.line,
    };
}

function parseYullsAction(line) {
    const tokens = tokenize(line.text);
    const op = tokens[1];
    const kv = parseKv(line.text);
    if (!op) throw new CloverScriptError('YULLS precisa de valor.', line.line);
    if (normalizeWord(op) === 'set') {
        const value = parseIntStrict(tokens[2], line.line, 'YULLS set');
        return { type: 'yulls_set', value, reason: kv.motivo || kv.reason || '', line: line.line, dangerous: true };
    }
    const amount = parseIntStrict(op, line.line, 'YULLS');
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('YULLS precisa de motivo="...".', line.line);
    return { type: 'yulls', amount, reason, line: line.line };
}

function parseStarsAction(line) {
    const tokens = tokenize(line.text);
    const amount = parseIntStrict(tokens[1], line.line, 'ESTRELAS');
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('ESTRELAS precisa de motivo="...".', line.line);
    return {
        type: 'stars',
        amount,
        target: normalizeWord(kv.alvo || 'player'),
        squadName: kv.esquadrao || kv.squad || null,
        reason,
        line: line.line,
    };
}

function parseItemAction(lines, index) {
    const line = lines[index];
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    if (!['dar', 'adicionar', 'add', 'remover', 'tirar', 'set'].includes(op)) {
        throw new CloverScriptError('ITEM precisa de ação: dar, remover ou set.', line.line);
    }
    const kv = parseKv(line.text);
    const name = kv.nome || kv.name;
    if (!name) throw new CloverScriptError('ITEM precisa de nome="...".', line.line);
    const quantity = kv.qtd || kv.quantidade || kv.qty || 1;
    const qty = parseIntStrict(quantity, line.line, 'Quantidade do item');
    if (qty <= 0) throw new CloverScriptError('Quantidade do item precisa ser maior que zero.', line.line);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('ITEM precisa de motivo="...".', line.line);
    let desc = kv.desc || kv.descricao || '';
    let nextIndex = index + 1;
    const block = collectLongBlock(lines, nextIndex, 'DESC', 'FIM_DESC');
    if (block) {
        desc = block.text;
        nextIndex = block.nextIndex;
    }
    return {
        action: {
            type: 'item',
            op: ['remover', 'tirar'].includes(op) ? 'remove' : (op === 'set' ? 'set' : 'add'),
            name,
            quantity: qty,
            kind: kv.tipo || kv.kind || 'narrativo',
            description: desc,
            reason,
            line: line.line,
        },
        nextIndex,
    };
}

function parseSpellAction(lines, index) {
    const line = lines[index];
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);
    if (!['adicionar', 'add', 'atualizar', 'update', 'upar', 'remover', 'tirar'].includes(op)) {
        throw new CloverScriptError('FEITICO precisa de ação: adicionar, atualizar ou remover.', line.line);
    }
    if (['remover', 'tirar'].includes(op)) {
        const name = kv.nome || kv.name || tokens.slice(2).filter((token) => !token.includes('=')).join(' ');
        if (!name) throw new CloverScriptError('FEITICO remover precisa de nome="...".', line.line);
        return {
            action: { type: 'spell', op: 'remove', name, reason: kv.motivo || kv.reason || 'Removido por CloverScript', line: line.line },
            nextIndex: index + 1,
        };
    }
    const block = collectLongBlock(lines, index + 1, 'FICHA', 'FIM_FICHA');
    if (!block) throw new CloverScriptError('FEITICO adicionar/atualizar precisa de FICHA/FIM_FICHA.', line.line);
    return {
        action: {
            type: 'spell',
            op: ['atualizar', 'update', 'upar'].includes(op) ? 'update' : 'add',
            sheetText: block.text,
            line: line.line,
        },
        nextIndex: block.nextIndex,
    };
}

function parseHexagonAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const side = tokens[2];
    if (!side) throw new CloverScriptError('HEXAGONO precisa de lado.', line.line);
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('HEXAGONO precisa de motivo="...".', line.line);
    if (op === 'set') {
        return { type: 'hexagon', op: 'set', side, value: parseIntStrict(tokens[3], line.line, 'Hexágono'), reason, line: line.line };
    }
    if (op === 'add') {
        return { type: 'hexagon', op: 'add', side, delta: parseIntStrict(tokens[3], line.line, 'Hexágono add'), reason, line: line.line };
    }
    throw new CloverScriptError('HEXAGONO aceita set ou add.', line.line);
}

function parseTreeAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const tree = normalizeWord(tokens[2]);
    const node = tokens[3];
    const kv = parseKv(line.text);
    if (!tree || !node) throw new CloverScriptError('ARVORE precisa de árvore e nó.', line.line);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('ARVORE precisa de motivo="...".', line.line);
    if (!['comprar', 'buy', 'conceder', 'dar', 'remover'].includes(op)) {
        throw new CloverScriptError('ARVORE aceita comprar, conceder ou remover.', line.line);
    }
    return {
        type: 'tree',
        op: ['conceder', 'dar'].includes(op) ? 'grant' : (op === 'remover' ? 'remove' : 'buy'),
        tree,
        node,
        reason,
        confirm: hasTrue(kv.confirmar || kv.confirm),
        line: line.line,
        dangerous: op === 'remover',
    };
}

function parseReturnAction(line) {
    const tokens = tokenize(line.text);
    const sub = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);
    if (sub !== 'bonus') throw new CloverScriptError('RETORNO aceita apenas: RETORNO bonus ...', line.line);
    const ph = parseIntStrict(kv.ph, line.line, 'RETORNO ph');
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('RETORNO precisa de motivo="...".', line.line);
    return {
        type: 'return_bonus',
        ph,
        prazo: kv.prazo || kv.deadline || '72h',
        reason,
        line: line.line,
    };
}

function parseBonusAction(lines, index) {
    const line = lines[index];
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);
    if (!['adicionar', 'add', 'criar', 'remover', 'tirar'].includes(op)) {
        throw new CloverScriptError('BONUS aceita adicionar ou remover.', line.line);
    }
    const name = kv.nome || kv.name || positionalAfterCommandOp(line.text);
    if (!name) throw new CloverScriptError('BONUS precisa de nome="...".', line.line);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('BONUS precisa de motivo="...".', line.line);

    if (['remover', 'tirar'].includes(op)) {
        return {
            action: { type: 'bonus', op: 'remove', name, reason, line: line.line },
            nextIndex: index + 1,
        };
    }

    let description = kv.desc || kv.descricao || '';
    let nextIndex = index + 1;
    const block = collectLongBlock(lines, nextIndex, 'DESC', 'FIM_DESC');
    if (block) {
        description = block.text;
        nextIndex = block.nextIndex;
    }

    return {
        action: {
            type: 'bonus',
            op: 'add',
            name,
            bonusType: kv.tipo || kv.type || 'narrativo',
            value: kv.valor || kv.value || '',
            description,
            prazo: kv.prazo || kv.deadline || null,
            reason,
            confirm: hasTrue(kv.confirmar || kv.confirm),
            line: line.line,
        },
        nextIndex,
    };
}

function parseSquadAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('ESQUADRAO precisa de motivo="...".', line.line);

    if (op === 'set' || op === 'definir') {
        const name = kv.nome || kv.name || kv.esquadrao || kv.squad || positionalAfterCommandOp(line.text);
        if (!name) throw new CloverScriptError('ESQUADRAO set precisa do nome do esquadrão.', line.line);
        return { type: 'squad', op: 'set', name, reason, line: line.line };
    }
    if (op === 'limpar' || op === 'remover') {
        return { type: 'squad', op: 'clear', reason, line: line.line };
    }
    if (op === 'estrelas' || op === 'estrela') {
        const amount = parseIntStrict(tokens[2], line.line, 'ESQUADRAO estrelas');
        if (!amount) throw new CloverScriptError('ESQUADRAO estrelas não pode ser zero.', line.line);
        return {
            type: 'squad',
            op: 'stars',
            amount,
            name: kv.nome || kv.name || kv.esquadrao || kv.squad || null,
            reason,
            line: line.line,
        };
    }
    if (op === 'frase') {
        const name = kv.nome || kv.name || kv.esquadrao || kv.squad || null;
        const text = kv.texto || kv.frase || kv.text || '';
        if (!name) throw new CloverScriptError('ESQUADRAO frase precisa de nome="...".', line.line);
        if (!text) throw new CloverScriptError('ESQUADRAO frase precisa de texto="...".', line.line);
        return { type: 'squad', op: 'phrase', name, text, reason, line: line.line };
    }

    throw new CloverScriptError('ESQUADRAO aceita set, limpar, estrelas ou frase.', line.line);
}

function parseAntiGhostAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || tokens.slice(2).filter((token) => !token.includes('=')).join(' ') || 'CloverScript';
    if (op === 'resetar' || op === 'reset') return { type: 'antighost', op: 'reset', reason, line: line.line };
    if (op === 'pular' || op === 'pausar') return { type: 'antighost', op: 'skip', days: parseDurationDays(kv.prazo || kv.dias || tokens[2] || '30d'), reason, line: line.line };
    if (op === 'remover') return { type: 'antighost', op: 'remove', reason, confirm: hasTrue(kv.confirmar || kv.confirm), dangerous: true, line: line.line };
    throw new CloverScriptError('ANTIGHOST aceita resetar, pular ou remover.', line.line);
}

function parseAttributeAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const attr = tokens[2];
    const value = parseIntStrict(tokens[3], line.line, 'ATRIBUTO');
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('ATRIBUTO precisa de motivo="...".', line.line);
    if (!['add', 'set'].includes(op)) throw new CloverScriptError('ATRIBUTO aceita add ou set.', line.line);
    return { type: 'attribute', op, attr, value, reason, line: line.line, dangerous: op === 'set' };
}

function parseTraitAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);
    if (op === 'limpar') {
        const field = normalizeWord(tokens[2]);
        return { type: 'trait', op: 'clear', field, reason: kv.motivo || kv.reason || 'Limpo por CloverScript', line: line.line, dangerous: true };
    }
    if (op !== 'set') throw new CloverScriptError('TRACO aceita set ou limpar.', line.line);
    const fieldToken = tokens[2] || '';
    const [rawField, inlineValue] = fieldToken.includes('=') ? fieldToken.split(/=(.+)/) : [fieldToken, null];
    const field = normalizeWord(rawField);
    const value = inlineValue || kv[field] || tokens.slice(3).filter((token) => !token.includes('=')).join(' ');
    const reason = kv.motivo || kv.reason || '';
    if (!field || !value) throw new CloverScriptError('TRACO set precisa de campo e valor.', line.line);
    if (!reason || reason.length < 3) throw new CloverScriptError('TRACO precisa de motivo="...".', line.line);
    return { type: 'trait', op: 'set', field, value, reason, line: line.line };
}

function parseStatusAction(line) {
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('STATUS precisa de motivo="...".', line.line);
    const changes = Object.entries(kv)
        .filter(([key]) => !['motivo', 'reason'].includes(key))
        .map(([field, value]) => ({ field, value }));
    if (!changes.length) throw new CloverScriptError('STATUS precisa de campo=value.', line.line);
    return { type: 'status', changes, reason, line: line.line };
}

function parsePersonAction(line) {
    const tokens = tokenize(line.text);
    const op = normalizeWord(tokens[1]);
    if (op !== 'set') throw new CloverScriptError('PERSONAGEM aceita apenas set.', line.line);
    const kv = parseKv(line.text);
    const reason = kv.motivo || kv.reason || '';
    if (!reason || reason.length < 3) throw new CloverScriptError('PERSONAGEM precisa de motivo="...".', line.line);
    const changes = Object.entries(kv)
        .filter(([key]) => !['motivo', 'reason'].includes(key))
        .map(([field, value]) => ({ field, value }));
    if (!changes.length) throw new CloverScriptError('PERSONAGEM set precisa de campo=value.', line.line);
    return { type: 'person', changes, reason, line: line.line };
}

function parseAction(lines, index, header) {
    const line = lines[index];
    const word = normalizeWord(tokenize(line.text)[0]);
    if (word === 'ph') return { action: parsePhAction(line, header), nextIndex: index + 1 };
    if (word === 'yulls' || word === 'yull') return { action: parseYullsAction(line), nextIndex: index + 1 };
    if (word === 'estrelas' || word === 'estrela') return { action: parseStarsAction(line), nextIndex: index + 1 };
    if (word === 'item') return parseItemAction(lines, index);
    if (word === 'feitico' || word === 'feitiço') return parseSpellAction(lines, index);
    if (word === 'hexagono' || word === 'hexágono') return { action: parseHexagonAction(line), nextIndex: index + 1 };
    if (word === 'arvore' || word === 'árvore') return { action: parseTreeAction(line), nextIndex: index + 1 };
    if (word === 'retorno') return { action: parseReturnAction(line), nextIndex: index + 1 };
    if (word === 'bonus' || word === 'bônus') return parseBonusAction(lines, index);
    if (word === 'esquadrao' || word === 'esquadrão') return { action: parseSquadAction(line), nextIndex: index + 1 };
    if (word === 'antighost' || word === 'anti_ghost') return { action: parseAntiGhostAction(line), nextIndex: index + 1 };
    if (word === 'atributo') return { action: parseAttributeAction(line), nextIndex: index + 1 };
    if (word === 'traco' || word === 'traço') return { action: parseTraitAction(line), nextIndex: index + 1 };
    if (word === 'status') return { action: parseStatusAction(line), nextIndex: index + 1 };
    if (word === 'personagem') return { action: parsePersonAction(line), nextIndex: index + 1 };
    throw new CloverScriptError(`Ação desconhecida: ${tokenize(line.text)[0]}.`, line.line);
}

function parseScript(scriptText, options = {}) {
    const lines = meaningfulLines(scriptText);
    if (!lines.length) throw new CloverScriptError('Script vazio.');

    const state = {
        mentions: options.mentions || [],
        mentionIndex: 0,
    };

    let index = 0;
    let header = {
        id: null,
        name: null,
        mode: 'rigido',
        dateText: null,
        confirm: false,
    };

    if (normalizeWord(tokenize(lines[index].text)[0]) === 'lote') {
        header = { ...header, ...parseHeader(lines[index]) };
        index += 1;
    }

    if (!['rigido', 'parcial', 'auditoria'].includes(header.mode)) {
        throw new CloverScriptError('Modo inválido. Use modo=rigido, modo=parcial ou modo=auditoria.');
    }
    if (header.mode === 'parcial') {
        throw new CloverScriptError('modo=parcial ainda não está ativo. Use modo=rigido por enquanto.');
    }

    const blocks = [];
    while (index < lines.length) {
        const first = normalizeWord(tokenize(lines[index].text)[0]);
        if (!['alvo', 'alvos', 'todos'].includes(first)) {
            throw new CloverScriptError('Esperava ALVO, ALVOS ou TODOS.', lines[index].line);
        }
        const targets = parseTargets(lines[index], state);
        index += 1;
        const actions = [];
        while (index < lines.length && normalizeWord(lines[index].text) !== 'fim') {
            const parsed = parseAction(lines, index, header);
            actions.push(parsed.action);
            index = parsed.nextIndex;
        }
        if (index >= lines.length) throw new CloverScriptError('Bloco sem FIM.', lines[index - 1]?.line || null);
        if (!actions.length) throw new CloverScriptError('Bloco sem ações.', lines[index].line);
        blocks.push({ targets, actions });
        index += 1;
    }

    return { header, blocks };
}

function playerNameMatches(player = {}, expectedName = '') {
    const expected = normalizeSearch(expectedName);
    if (!expected) return false;
    return [player.personagem_nome, player.nome, player.display_name]
        .map(normalizeSearch)
        .filter(Boolean)
        .some((value) => value === expected || value.includes(expected) || expected.includes(value));
}

function playerLooksIncomplete(player = {}) {
    const name = String(player.personagem_nome || '').trim();
    const status = normalizeWord(player.jogo_status || '');
    return !name || ['-', '.'].includes(name) || status !== 'liberado';
}

async function resolveCompositeTarget(db, target, options = {}) {
    const identifier = target.id || target.phone || target.value;
    const byIdentifier = identifier
        ? await resolveTargetPlayer(db, null, identifier, options).catch((error) => ({ ok: false, error: error?.message || String(error) }))
        : { ok: false };
    const byName = target.name
        ? await resolveTargetPlayer(db, null, target.name, options).catch((error) => ({ ok: false, error: error?.message || String(error) }))
        : { ok: false };

    const identifierPlayer = byIdentifier.ok ? byIdentifier.player : null;
    const namePlayer = byName.ok ? byName.player : null;

    if (target.name && identifierPlayer && playerNameMatches(identifierPlayer, target.name)) {
        return { ...identifierPlayer, __targetSource: byIdentifier.source || 'composite', __rawTarget: target.raw || target.value || identifier };
    }
    if (target.name && namePlayer && (!identifierPlayer || playerLooksIncomplete(identifierPlayer))) {
        return { ...namePlayer, __targetSource: byName.source || 'composite_name', __rawTarget: target.raw || target.name };
    }
    if (!target.name && identifierPlayer) return { ...identifierPlayer, __targetSource: byIdentifier.source || 'composite', __rawTarget: target.raw || identifier };
    if (target.name && identifierPlayer && !playerNameMatches(identifierPlayer, target.name)) {
        throw new CloverScriptError(
            `Alvo composto inseguro: telefone/id encontrou ${playerDisplayName(identifierPlayer, identifierPlayer.id)}, mas o personagem informado foi "${target.name}".`,
            null,
            'unsafe_composite_target',
            { target: target.raw || target.value || target.name || identifier }
        );
    }
    if (namePlayer) return { ...namePlayer, __targetSource: byName.source || 'composite_name', __rawTarget: target.raw || target.name };

    throw new CloverScriptError(
        byIdentifier.error || byName.error || `Alvo nao encontrado: ${target.raw}.`,
        null,
        'target_not_found',
        { target: target.raw || target.value || identifier }
    );
}

async function resolveTargets(db, parsed, options = {}) {
    const blocks = [];
    for (const block of parsed.blocks) {
        const targets = [];
        for (const target of block.targets) {
            let resolved = null;
            if (target.kind === 'jid') {
                const result = await resolveTargetPlayer(db, target.value, '', options);
                if (!result.ok) {
                    throw new CloverScriptError(result.error || `Alvo nao encontrado: ${target.raw}.`, target.line || null, 'target_not_found', { target: target.raw || target.value, ...(result.details || {}) });
                }
                resolved = { ...result.player, __targetSource: result.source, __rawTarget: target.raw || target.value };
            } else if (target.kind === 'composite') {
                resolved = await resolveCompositeTarget(db, target, options);
            } else if (target.kind === 'all') {
                if (!isOwner(options.actorId)) {
                    throw new CloverScriptError('TODOS é apenas para owner.', target.line || null, 'permission_denied', {
                        target: target.raw || 'TODOS',
                        reason: 'owner_only',
                    });
                }

                const gameStatus = target.filter?.gameStatus || 'liberado';
                const rows = await db.all(
                    "SELECT * FROM jogadores WHERE LOWER(COALESCE(jogo_status, '')) = LOWER(?)",
                    [gameStatus]
                );

                if (!rows.length) {
                    throw new CloverScriptError(
                        'TODOS jogo=liberado não encontrou nenhum player liberado.',
                        target.line || null,
                        'empty_global_target',
                        {
                            target: target.raw || 'TODOS jogo=liberado',
                            reason: 'zero_targets',
                        }
                    );
                }

                for (const player of rows) {
                    targets.push({
                        ...player,
                        __targetSource: 'todos',
                        __rawTarget: target.raw || `TODOS jogo=${gameStatus}`,
                    });
                }
                continue;
            } else if (target.kind === 'list') {
                const list = await getResolvedRewardListTargets(db, target.value);
                if (!list.ok) {
                    const firstBad = list.bad?.[0] || null;
                    throw new CloverScriptError(
                        list.error || `Lista nao resolvida: ${target.value}.`,
                        target.line || null,
                        'target_list_not_resolved',
                        {
                            target: target.raw || target.value,
                            rawTarget: target.raw || target.value,
                            source: 'lista',
                            foundPlayer: null,
                            reason: 'list_unresolved',
                            suggestion: `Use .#lista resolver ${target.value} e corrija as pendencias antes de simular.`,
                            bad: firstBad,
                        }
                    );
                }
                if (!Array.isArray(list.playerIds) || list.playerIds.length === 0) {
                    throw new CloverScriptError(
                        `Lista vazia ou sem canônicos: ${target.value}.`,
                        target.line || null,
                        'empty_target_list',
                        {
                            target: target.raw || target.value,
                            rawTarget: target.raw || target.value,
                            source: 'lista',
                            reason: 'zero_targets',
                            suggestion: `Use .#lista importar ${target.value} e depois .#lista resolver ${target.value}.`,
                        }
                    );
                }

                for (const playerId of list.playerIds) {
                    const result = await resolveTargetPlayer(db, playerId, '', { ...options, mechanical: true });
                    if (!result.ok) {
                        throw new CloverScriptError(result.error || `Alvo da lista nao encontrado: ${playerId}.`, target.line || null, 'target_not_found', { target: playerId, ...(result.details || {}) });
                    }
                    targets.push({ ...result.player, __targetSource: 'lista', __rawTarget: `${target.value}:${playerId}` });
                }
                continue;
            } else if (target.kind === 'quote') {
                const replyTarget = options.quotedParticipant || options.replyParticipant || null;
                if (!replyTarget) {
                    throw new CloverScriptError('ALVO resposta precisa de uma resposta real.', target.line || null, 'missing_reply_target', { target: target.raw || target.value || 'resposta' });
                }
                const result = await resolveTargetPlayer(db, replyTarget, '', {
                    ...options,
                    quotedParticipant: replyTarget,
                });
                if (!result.ok) {
                    throw new CloverScriptError(result.error || 'ALVO resposta nao encontrado.', target.line || null, 'target_not_found', { target: target.raw || target.value || replyTarget, ...(result.details || {}) });
                }
                resolved = { ...result.player, __targetSource: 'resposta', __rawTarget: target.raw || replyTarget };
            } else {
                const result = await resolveTargetPlayer(db, null, target.value, options);
                if (!result.ok) {
                    throw new CloverScriptError(result.error || `Alvo nao encontrado: ${target.raw}.`, target.line || null, 'target_not_found', { target: target.raw || target.value, ...(result.details || {}) });
                }
                resolved = { ...result.player, __targetSource: result.source, __rawTarget: target.raw || target.value };
            }
            targets.push(resolved);
        }
        blocks.push({ targets, actions: block.actions });
    }
    return { header: parsed.header, blocks };
}

function actionRequiresCharacter(action) {
    return [
        'ph',
        'ph_set',
        'yulls',
        'yulls_set',
        'stars',
        'item',
        'spell',
        'hexagon',
        'tree',
        'return_bonus',
        'bonus',
        'squad',
        'attribute',
        'trait',
        'status',
        'person',
    ].includes(action.type);
}

function actionNeedsOwner(action) {
    if (action.dangerous) return true;
    if (action.type === 'tree' && ['grant', 'remove'].includes(action.op)) return true;
    if (action.type === 'yulls_set' || action.type === 'ph_set') return true;
    if (action.type === 'antighost' && action.op === 'remove') return true;
    return false;
}

function validatePermissions(plan, actorId) {
    const owner = isOwner(actorId);
    for (const block of plan.blocks) {
        for (const action of block.actions) {
            if (actionNeedsOwner(action) && !owner) {
                throw new CloverScriptError(`Ação ${action.type} é apenas para owner.`, action.line, 'permission_denied');
            }
            if (actionNeedsOwner(action) && !action.confirm && !plan.header.confirm) {
                throw new CloverScriptError(`Ação perigosa na linha ${action.line} precisa de confirmar=true.`, action.line, 'missing_confirm');
            }
        }
    }
}

function validateMechanicalTargets(plan) {
    for (const block of plan.blocks) {
        for (const target of block.targets) {
            for (const action of block.actions) {
                if (!actionRequiresCharacter(action)) continue;
                const guard = assertMechanicalTarget(target, {
                    rawTarget: target.__rawTarget || target.id,
                    source: target.__targetSource || 'cloverscript',
                });
                if (!guard.ok) {
                    throw new CloverScriptError(
                        guard.error,
                        action.line || null,
                        'mechanical_target_without_character',
                        {
                            target: target.__rawTarget || target.id,
                            ...guard.details,
                        }
                    );
                }
            }
        }
    }
}

async function buildPlan(db, scriptText, options = {}) {
    const parsed = parseScript(scriptText, options);
    const plan = await resolveTargets(db, parsed, options);
    validateMechanicalTargets(plan);
    validatePermissions(plan, options.actorId);
    return plan;
}

function describeAction(action) {
    if (action.type === 'ph') return `PH ${action.amount > 0 ? '+' : ''}${action.amount} (${action.source}, teto=${action.cap || 'auto'})`;
    if (action.type === 'yulls') return `Yulls ${action.amount > 0 ? '+' : ''}${action.amount}`;
    if (action.type === 'yulls_set') return `Yulls = ${action.value}`;
    if (action.type === 'stars') return `Estrelas ${action.amount > 0 ? '+' : ''}${action.amount}${action.target === 'esquadrao' ? ' no esquadrão' : ''}`;
    if (action.type === 'item') return `Item ${action.op}: ${action.name} x${action.quantity}`;
    if (action.type === 'spell') return action.op === 'remove' ? `Remover feitiço: ${action.name}` : `${action.op === 'update' ? 'Atualizar' : 'Adicionar'} feitiço`;
    if (action.type === 'hexagon') return `Hexágono ${action.op}: ${action.side}`;
    if (action.type === 'tree') return `Árvore ${action.op}: ${action.tree}/${action.node}`;
    if (action.type === 'return_bonus') return `Bônus de retorno: +${action.ph} PH`;
    if (action.type === 'bonus') return action.op === 'remove' ? `Remover bônus: ${action.name}` : `Bônus ${action.name}`;
    if (action.type === 'squad') {
        if (action.op === 'set') return `Esquadrão = ${action.name}`;
        if (action.op === 'clear') return 'Esquadrão limpo';
        if (action.op === 'stars') return `Esquadrão estrelas ${action.amount > 0 ? '+' : ''}${action.amount}`;
        if (action.op === 'phrase') return `Esquadrão frase: ${action.name}`;
    }
    if (action.type === 'antighost') return `Anti-ghost: ${action.op}`;
    if (action.type === 'attribute') return `Atributo ${action.op}: ${action.attr} ${action.value > 0 ? '+' : ''}${action.value}`;
    if (action.type === 'trait') return `Traço ${action.op}: ${action.field}`;
    if (action.type === 'status') return `Status: ${action.changes.map((item) => `${item.field}=${item.value}`).join(', ')}`;
    if (action.type === 'person') return `Personagem: ${action.changes.map((item) => item.field).join(', ')}`;
    return action.type;
}

function flattenPlan(plan) {
    const items = [];
    for (const block of plan.blocks) {
        for (const target of block.targets) {
            for (const action of block.actions) {
                items.push({ target, action });
            }
        }
    }
    return items;
}

function valueText(value) {
    if (value === null || value === undefined || value === '') return '-';
    return String(value);
}

async function previewAction(db, target, action, previewState = null) {
    const label = playerDisplayName(target, target.id);
    if (action.type === 'ph') {
        let phState = previewState?.ph?.get(target.id) || null;
        if (!phState) {
            const ph = await getPhSummary(db, target.id).catch(() => null);
            phState = {
                available: Number(ph?.phAvailable || 0),
                accumulated: Number(ph?.phAccumulated || 0),
            };
            if (previewState?.ph) previewState.ph.set(target.id, phState);
        }

        const beforeAvailable = Number(phState.available || 0);
        const beforeAccumulated = Number(phState.accumulated || 0);
        const afterAvailable = beforeAvailable + Number(action.amount || 0);
        const afterAccumulated = beforeAccumulated + Number(action.amount || 0);

        if (previewState?.ph) {
            phState.available = afterAvailable;
            phState.accumulated = afterAccumulated;
        }

        return `${label}: PH disp. ${beforeAvailable} -> ${afterAvailable}; acum. ${beforeAccumulated} -> ${afterAccumulated}`;
    }
    if (action.type === 'yulls' || action.type === 'yulls_set') {
        const player = await getPlayerById(db, target.id);
        const before = Number(player?.dinheiro || 0);
        const after = action.type === 'yulls_set' ? Number(action.value || 0) : before + Number(action.amount || 0);
        return `${label}: Yulls ${before} -> ${after}`;
    }
    if (action.type === 'stars') {
        const player = await getPlayerById(db, target.id);
        const before = Number(player?.estrelas || 0);
        const after = before + Number(action.amount || 0);
        return `${label}: estrelas ${before} -> ${after}`;
    }
    if (action.type === 'squad') {
        const player = await getPlayerById(db, target.id);
        if (action.op === 'set') return `${label}: esquadrão ${valueText(player?.esquadrao)} -> ${action.name}`;
        if (action.op === 'clear') return `${label}: esquadrão ${valueText(player?.esquadrao)} -> -`;
        if (action.op === 'stars') {
            const squadName = action.name || player?.esquadrao;
            const squad = squadName ? await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [normalizeSquadKey(squadName)]).catch(() => null) : null;
            const before = Number(squad?.current_stars || 0);
            return `${valueText(squadName)}: estrelas do esquadrão ${before} -> ${before + Number(action.amount || 0)}`;
        }
    }
    if (action.type === 'bonus') {
        const active = await getCustomCharacterBonuses(db, target.id).catch(() => []);
        const exists = active.find((row) => normalizeSearch(row.name) === normalizeSearch(action.name));
        return `${label}: bônus ${action.name} ${exists ? 'ativo' : 'ausente'} -> ${action.op === 'remove' ? 'removido' : 'ativo'}`;
    }
    if (action.type === 'trait') {
        const player = await getPlayerById(db, target.id);
        const field = action.field === 'gancho' ? 'gancho_narrativo' : action.field;
        return `${label}: ${field} ${valueText(player?.[field])} -> ${action.op === 'clear' ? '-' : action.value}`;
    }
    if (action.type === 'person') {
        const player = await getPlayerById(db, target.id);
        const changes = action.changes.slice(0, 3).map((item) => {
            const field = normalizeWord(item.field);
            return `${field} ${valueText(player?.[field])} -> ${item.value}`;
        });
        return `${label}: ${changes.join('; ')}`;
    }
    if (action.type === 'status') {
        const player = await getPlayerById(db, target.id);
        const changes = action.changes.slice(0, 3).map((item) => {
            const field = STATUS_FIELDS[normalizeWord(item.field)] || normalizeWord(item.field);
            return `${field} ${valueText(player?.[field])} -> ${normalizeStatusValue(item.value)}`;
        });
        return `${label}: ${changes.join('; ')}`;
    }
    return `${label}: ${describeAction(action)}`;
}

async function buildSimulationPreview(db, plan, limit = 12) {
    const lines = [];
    const flat = flattenPlan(plan);
    const previewState = { ph: new Map() };
    for (const item of flat.slice(0, limit)) {
        const line = await previewAction(db, item.target, item.action, previewState).catch(() => `${playerDisplayName(item.target, item.target.id)}: ${describeAction(item.action)}`);
        lines.push(`> ${line}`);
    }
    if (flat.length > limit) lines.push(`> ...e mais ${flat.length - limit} ação(ões).`);
    return lines;
}

function renderPlanSummary(plan, limit = 8) {
    const grouped = new Map();
    for (const { target, action } of flattenPlan(plan)) {
        const key = target.id;
        if (!grouped.has(key)) grouped.set(key, { target, actions: [] });
        grouped.get(key).actions.push(describeAction(action));
    }
    const lines = [];
    let shown = 0;
    for (const item of grouped.values()) {
        if (shown >= limit) break;
        lines.push(`*${playerDisplayName(item.target, item.target.id)}* (${formatMention(item.target.id)})`);
        lines.push(`> ${item.actions.slice(0, 5).join('; ')}`);
        if (item.actions.length > 5) lines.push(`> +${item.actions.length - 5} ações`);
        shown += 1;
    }
    const remaining = grouped.size - shown;
    if (remaining > 0) lines.push(`> ...e mais ${remaining} alvo(s).`);
    return lines;
}

async function hasAppliedBatch(db, batchId) {
    if (!batchId) return false;
    const row = await db.get(
        'SELECT id, code FROM clover_script_runs WHERE batch_id = ? AND status = ?',
        [batchId, RUN_STATUS.APPLIED]
    );
    return row || null;
}

async function createSimulation(db, scriptText, options = {}) {
    await ensureCloverScriptSchema(db);
    const plan = await buildPlan(db, scriptText, options);
    const duplicate = await hasAppliedBatch(db, plan.header.id);
    if (duplicate && !plan.header.confirm) {
        throw new CloverScriptError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }
    const preview = await buildSimulationPreview(db, plan);
    const code = generateCode();
    const result = await db.run(
        `INSERT INTO clover_script_runs
         (code, batch_id, batch_name, mode, script_hash, script_text, plan_json, status, created_by, chat_id, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            code,
            plan.header.id,
            plan.header.name,
            plan.header.mode,
            hashScript(scriptText),
            scriptText,
            serialize(plan),
            RUN_STATUS.SIMULATED,
            options.actorId || null,
            options.chatId || null,
            serialize({ source: options.source || 'cloverscript' }),
        ]
    );
    return {
        ok: true,
        runId: result.lastID,
        code,
        plan,
        text: renderSimulation({ code, plan, preview }),
    };
}

async function getSimulation(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureCloverScriptSchema(db);
    if (code) {
        return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [String(code).trim().toUpperCase()]);
    }
    return db.get(
        `SELECT *
         FROM clover_script_runs
         WHERE status = ?
           AND created_by = ?
           AND chat_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [RUN_STATUS.SIMULATED, actorId || null, chatId || null]
    );
}

function renderSimulation({ code, plan, preview = null }) {
    const totalActions = flattenPlan(plan).length;
    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── nada foi aplicado ainda ──',
        '',
        '_`─( ✓ )───── Resumo`_',
        '',
        `*Código:* ${code}`,
        `*Modo:* ${plan.header.mode}`,
        plan.header.id ? `*Lote:* ${plan.header.id}` : null,
        `*Ações:* ${totalActions}`,
        '',
        '_`─( ◆ )───── Prévia`_',
        '',
        ...(preview?.length ? preview : renderPlanSummary(plan)),
        '',
        `Use *${COMMAND_PREFIX}clover aplicar codigo=${code}* para confirmar.`,
    ].filter(Boolean).join('\n');
}

function renderApplyResult({ run, results, failed }) {
    const success = results.filter((item) => item.ok).length;
    const errors = results.filter((item) => !item.ok);
    return [
        failed
            ? '*♧┃CLOVERSCRIPT COM ERRO 𖥔 CLOVER MULTICOLOR*'
            : '*♧┃CLOVERSCRIPT APLICADO 𖥔 CLOVER MULTICOLOR*',
        failed
            ? '     ── confira o relatório abaixo ──'
            : '     ── alterações registradas ──',
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Código:* ${run.code}`,
        `*Aplicadas:* ${success}`,
        errors.length ? `*Falhas:* ${errors.length}` : '*Falhas:* 0',
        '',
        '_`─( ◆ )───── Resumo`_',
        '',
        ...results.slice(0, 10).map((item) => (
            item.ok
                ? `> ${item.summary}`
                : `> ERRO: ${item.error}`
        )),
        results.length > 10 ? `> ...e mais ${results.length - 10} ação(ões).` : null,
    ].filter(Boolean).join('\n');
}

function parseDurationDays(value) {
    const text = String(value || '').trim().toLowerCase();
    const match = text.match(/^(\d+)([hd])?$/);
    if (!match) return 30;
    const amount = Number(match[1]);
    return match[2] === 'h' ? Math.max(1, Math.ceil(amount / 24)) : amount;
}

function parseDurationHours(value) {
    const text = String(value || '').trim().toLowerCase();
    const match = text.match(/^(\d+)([hd])?$/);
    if (!match) return 72;
    const amount = Number(match[1]);
    return match[2] === 'd' ? amount * 24 : amount;
}

async function getWeeklyCommonPh(db, playerId, weekKey) {
    await ensureCloverQuickEvaluationsSchema(db);
    const row = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND COALESCE(bypass_weekly_limit, 0) = 0
           AND COALESCE(json_extract(metadata_json, '$.voided_by_correction'), 0) != 1
           AND COALESCE(json_extract(rewards_json, '$.cap'), '') != 'anulado'`,
        [playerId, weekKey]
    );
    return Number(row?.total || 0);
}

async function insertEvaluationMirror(db, { runId, actionIndex, playerId, chatId, actorId, action, amount, eventDate }) {
    await ensureCloverQuickEvaluationsSchema(db);
    const source = normalizeSource(action.source);
    const modality = MODALITY_BY_SOURCE[source] || MODALITY_BY_SOURCE.outro;
    const cap = action.cap || (modality.bypassWeekly ? 'fora' : 'semanal');
    const bypassWeekly = cap !== 'semanal' ? 1 : 0;
    const weekKey = formatDateKey(getWeekStart(eventDate));
    const messageKey = `cloverscript:${runId}:${actionIndex}:${playerId}`;
    const rewards = { ph: amount, source, cap };
    await db.run(
        `INSERT OR IGNORE INTO clover_quick_evaluations
         (message_key, quoted_message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          ph_amount, yulls_amount, stars_amount, inventory_text, week_key, bypass_weekly_limit,
          rewards_json, created_at, metadata_json)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, ?)`,
        [
            messageKey,
            chatId || 'cloverscript',
            playerId,
            actorId || null,
            modality.key,
            modality.label,
            amount,
            weekKey,
            bypassWeekly,
            serialize(rewards),
            toSqliteDate(eventDate),
            serialize({ cloverscript_run_id: runId, source }),
        ]
    );
    const row = await db.get(
        'SELECT id FROM clover_quick_evaluations WHERE message_key = ?',
        [messageKey]
    );
    return row?.id || null;
}

async function validatePhCap(db, playerId, action, amount, eventDate) {
    if (amount <= 0) return;
    const source = normalizeSource(action.source);
    const modality = MODALITY_BY_SOURCE[source] || MODALITY_BY_SOURCE.outro;
    const cap = action.cap || (modality.bypassWeekly ? 'fora' : 'semanal');
    if (cap !== 'semanal') return;
    const weekKey = formatDateKey(getWeekStart(eventDate));
    const current = await getWeeklyCommonPh(db, playerId, weekKey);
    if (current + amount > WEEKLY_COMMON_PH_LIMIT) {
        throw new Error(`limite semanal excedido (${current}/${WEEKLY_COMMON_PH_LIMIT} PH comuns)`);
    }
}

async function applyPhAction(db, ctx) {
    const { target, action, run, index } = ctx;
    const eventDate = parseDateInput(action.dateText, new Date());
    if (!eventDate) throw new Error('data inválida no PH');
    await validatePhCap(db, target.id, action, action.amount, eventDate);
    const metadata = {
        cloverscript_run_id: run.id,
        cloverscript_code: run.code,
        source: action.source,
        cap: action.cap || null,
        event_date: formatDateKey(eventDate),
    };
    const relatedId = `cloverscript:${run.id}:${index}:${target.id}`;
    const result = action.amount > 0
        ? await addPh(
            db,
            target.id,
            action.amount,
            `cloverscript:${action.source}`,
            action.reason,
            ctx.actorId,
            metadata,
            relatedId
        )
        : await adminAdjustPh(
            db,
            target.id,
            action.amount,
            action.reason,
            ctx.actorId,
            {
                source: `cloverscript:${action.source}`,
                relatedId,
                affectAccumulated: true,
                metadata: {
                    ...metadata,
                    correction_scope: 'available_and_accumulated',
                },
            }
        );
    if (action.amount > 0) {
        await insertEvaluationMirror(db, {
            runId: run.id,
            actionIndex: index,
            playerId: target.id,
            chatId: run.chat_id,
            actorId: ctx.actorId,
            action,
            amount: action.amount,
            eventDate,
        });
    }
    return {
        summary: `${playerDisplayName(target, target.id)}: PH ${action.amount > 0 ? '+' : ''}${action.amount} (disp. ${result.before.phAvailable} -> ${result.after.phAvailable}; acum. ${result.before.phAccumulated} -> ${result.after.phAccumulated})`,
        before: result.before,
        after: result.after,
    };
}

async function applyYullsAction(db, { target, action, actorId, run, index }) {
    const player = await getPlayerById(db, target.id);
    const before = Number(player?.dinheiro || 0);
    const requestedNext = action.type === 'yulls_set'
        ? Number(action.value)
        : before + Number(action.amount || 0);
    if (requestedNext < 0) throw new Error('Yulls não podem ficar negativos');

    const amount = requestedNext - before;
    let next = before;
    if (amount !== 0) {
        const mutation = await adminAdjustYulls(
            db,
            target.id,
            amount,
            action.reason || (action.type === 'yulls_set'
                ? 'CloverScript: definição de saldo'
                : 'CloverScript: ajuste de Yulls'),
            actorId,
            {
                source: 'cloverscript',
                relatedId: `cloverscript:${run.id}`,
                idempotencyKey: `yulls:cloverscript:${run.id}:${index}:${target.id}`,
                metadata: {
                    run_id: run.id,
                    action_index: index,
                    action_type: action.type,
                },
            }
        );
        next = mutation.balanceAfter;
    }

    return {
        summary: `${playerDisplayName(target, target.id)}: Yulls ${formatYulls(before)} -> ${formatYulls(next)}`,
        before: { yulls: before },
        after: { yulls: next },
    };
}

async function applyStarsAction(db, { target, action, actorId, run }) {
    const player = await getPlayerById(db, target.id);
    const amount = Number(action.amount || 0);
    if (action.target === 'esquadrao') {
        await ensureCloverSquadSchema(db);
        const membership = action.squadName ? null : await resolvePlayerSquadMembership(db, target.id);
        const squadName = action.squadName || (membership?.ok ? membership.squadName : null);
        if (!squadName || squadName === '-') throw new Error('player sem esquadrão para receber estrelas de esquadrão');
        const squadKey = normalizeSquadKey(squadName);
        await db.run(
            `INSERT INTO clover_squads (squad_key, name, historical_stars, current_stars, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(squad_key) DO UPDATE SET
                 historical_stars = clover_squads.historical_stars + excluded.historical_stars,
                 current_stars = clover_squads.current_stars + excluded.current_stars,
                 updated_at = CURRENT_TIMESTAMP`,
            [squadKey, squadName, amount, amount]
        );
        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at, metadata_json)
             VALUES (?, ?, ?, 'ganho', 'cloverscript', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [squadKey, target.id, amount, action.reason, actorId, serialize({ cloverscript_run_id: run.id })]
        );
        return {
            summary: `${squadName}: estrelas ${amount > 0 ? '+' : ''}${amount}`,
            before: null,
            after: { squad: squadName, amount },
        };
    }
    const before = Number(player?.estrelas || 0);
    const next = before + amount;
    if (next < 0) throw new Error('estrelas não podem ficar negativas');
    await db.run('UPDATE jogadores SET estrelas = ? WHERE id = ?', [next, target.id]);
    return {
        summary: `${playerDisplayName(target, target.id)}: estrelas ${formatStars(before)} -> ${formatStars(next)}`,
        before: { stars: before },
        after: { stars: next },
    };
}

async function applyItemAction(db, { target, action, actorId, run }) {
    await ensureCloverInventorySchema(db);
    if (action.op === 'add') {
        const result = await db.run(
            `INSERT INTO clover_inventory_items
             (player_id, item_name, description, quantity, kind, source, related_id, created_by, created_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, 'cloverscript', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                target.id,
                action.name,
                action.description || null,
                action.quantity,
                action.kind || 'narrativo',
                `cloverscript:${run.id}`,
                actorId,
                serialize({ reason: action.reason, cloverscript_run_id: run.id }),
            ]
        );
        return {
            summary: `${playerDisplayName(target, target.id)}: item ${action.name} x${action.quantity}`,
            before: null,
            after: { itemId: result.lastID },
        };
    }
    if (action.op === 'remove') {
        const row = await db.get(
            `SELECT * FROM clover_inventory_items
             WHERE player_id = ? AND LOWER(item_name) = LOWER(?)
             ORDER BY id DESC LIMIT 1`,
            [target.id, action.name]
        );
        if (!row) throw new Error('item não encontrado');
        if (Number(row.quantity || 1) > action.quantity) {
            await db.run('UPDATE clover_inventory_items SET quantity = quantity - ? WHERE id = ?', [action.quantity, row.id]);
        } else {
            await db.run('DELETE FROM clover_inventory_items WHERE id = ?', [row.id]);
        }
        return {
            summary: `${playerDisplayName(target, target.id)}: item removido ${action.name} x${action.quantity}`,
            before: row,
            after: null,
        };
    }
    throw new Error('ITEM set ainda não foi implementado com segurança');
}

async function applySpellAction(db, { target, action, actorId }) {
    if (action.op === 'remove') {
        const result = await removeSpell(db, target.id, action.name, actorId);
        if (!result.ok) throw new Error('feitiço não encontrado');
        return {
            summary: `${playerDisplayName(target, target.id)}: feitiço removido ${result.spell.name}`,
            before: result.spell,
            after: null,
        };
    }
    const parsed = parseSpellSheet(action.sheetText);
    if (!parsed.ok) throw new Error(`ficha de feitiço incompleta: ${parsed.errors.join(', ')}`);
    const result = await saveSpell(db, target.id, parsed.sheet, actorId, { nextVersion: action.op === 'update' });
    if (!result.ok) throw new Error(result.code || 'não consegui salvar feitiço');
    return {
        summary: `${playerDisplayName(target, target.id)}: feitiço ${action.op === 'update' ? 'atualizado' : 'adicionado'} ${result.spell.name} v${result.spell.version}`,
        before: null,
        after: result.spell,
    };
}

async function applyHexagonAction(db, { target, action, actorId }) {
    let value = action.value;
    if (action.op === 'add') {
        const current = await db.get('SELECT * FROM clover_mana_hexagon WHERE player_id = ?', [target.id]);
        const sideKey = normalizeWord(action.side);
        value = Number(current?.[sideKey] || 1) + Number(action.delta || 0);
    }
    const result = await setHexagonSide(db, target.id, action.side, value, actorId, action.reason);
    return {
        summary: `${playerDisplayName(target, target.id)}: Hexágono ${result.sideLabel} ${result.oldValue} -> ${result.newValue}`,
        before: result.before,
        after: result.after,
    };
}

async function grantTreeNode(db, { target, action, actorId, run }) {
    const tree = getTree(action.tree);
    if (!tree) throw new Error('árvore não encontrada');
    const nodeId = normalizeKey(action.node).replace(/\s+/g, '_');
    const node = tree.nodesById[nodeId] || tree.nodes.find((item) => normalizeKey(item.name) === normalizeKey(action.node));
    if (!node) throw new Error('nó não encontrado');
    const insert = await db.run(
        `INSERT OR IGNORE INTO clover_skill_nodes
         (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'cloverscript_grant', ?)`,
        [target.id, tree.id, node.id, actorId, serialize({ reason: action.reason, cloverscript_run_id: run.id })]
    );
    if (!insert.changes) throw new Error('player já possui esse nó');
    return {
        summary: `${playerDisplayName(target, target.id)}: nó concedido ${tree.name || tree.id}/${node.name}`,
        before: null,
        after: { tree: tree.id, node: node.id },
    };
}

async function applyTreeAction(db, ctx) {
    const { target, action, actorId } = ctx;
    if (action.op === 'buy') {
        const result = await buyNode(db, target.id, action.tree, action.node, actorId, {
            source: 'cloverscript_purchase',
            metadata: { reason: action.reason, cloverscript_run_id: ctx.run.id },
        });
        if (!result.ok) throw new Error(result.reason || 'nó não disponível');
        return {
            summary: `${playerDisplayName(target, target.id)}: comprou ${result.tree.name || result.tree.id}/${result.node.name} (${result.cost} PH)`,
            before: null,
            after: { tree: result.tree.id, node: result.node.id, cost: result.cost },
        };
    }
    if (action.op === 'grant') return grantTreeNode(db, ctx);
    throw new Error('ARVORE remover recusado por segurança nesta versão');
}

async function applyReturnBonusAction(db, { target, action, actorId }) {
    const hours = parseDurationHours(action.prazo);
    const result = await createReturnBonus({
        db,
        playerId: target.id,
        amount: action.ph,
        hours,
        createdBy: actorId,
        reason: action.reason,
    });
    if (!result.ok) throw new Error(result.code || 'não consegui criar bônus de retorno');
    return {
        summary: `${playerDisplayName(target, target.id)}: bônus de retorno +${action.ph} PH (${hours}h)`,
        before: null,
        after: result.bonus,
    };
}

function addHoursDate(hours) {
    const date = new Date();
    date.setHours(date.getHours() + Number(hours || 0));
    return toSqliteDate(date);
}

async function applyBonusAction(db, { target, action, actorId, run }) {
    await ensureCharacterBonusSchema(db);
    const activeRows = await getCustomCharacterBonuses(db, target.id);
    const current = activeRows.find((row) => normalizeSearch(row.name) === normalizeSearch(action.name)) || null;

    if (action.op === 'remove') {
        if (!current) throw new Error('bônus ativo não encontrado');
        await db.run(
            `UPDATE clover_character_bonuses
             SET status = 'removido',
                 reason = ?,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ?
             WHERE id = ?`,
            [
                action.reason,
                serialize({ cloverscript_run_id: run.id, removed_by: actorId }),
                current.id,
            ]
        );
        return {
            summary: `${playerDisplayName(target, target.id)}: bônus removido ${current.name}`,
            before: current,
            after: null,
        };
    }

    if (current && !action.confirm) {
        throw new Error(`bônus ativo já existe: ${current.name}. Use confirmar=true para substituir`);
    }

    if (current) {
        await db.run(
            `UPDATE clover_character_bonuses
             SET status = 'substituido',
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ?
             WHERE id = ?`,
            [serialize({ cloverscript_run_id: run.id, replaced_by: actorId }), current.id]
        );
    }

    const expiresAt = action.prazo ? addHoursDate(parseDurationHours(action.prazo)) : null;
    const insert = await db.run(
        `INSERT INTO clover_character_bonuses
         (player_id, name, type, value, description, status, source, reason, expires_at, created_by, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'ativo', 'cloverscript', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [
            target.id,
            action.name,
            action.bonusType || 'narrativo',
            action.value || null,
            action.description || null,
            action.reason,
            expiresAt,
            actorId,
            serialize({ cloverscript_run_id: run.id, replaced_bonus_id: current?.id || null }),
        ]
    );
    const row = await db.get('SELECT * FROM clover_character_bonuses WHERE id = ?', [insert.lastID]);
    return {
        summary: `${playerDisplayName(target, target.id)}: bônus ${current ? 'substituído' : 'adicionado'} ${action.name}`,
        before: current,
        after: row,
    };
}

async function applySquadAction(db, { target, action, actorId, run }) {
    await ensureCloverSquadSchema(db);
    const player = await getPlayerById(db, target.id);

    if (action.op === 'set') {
        const before = player?.esquadrao || '-';
        const squad = await ensureSquad(db, action.name);
        if (!squad) throw new Error('esquadrão inválido');
        await db.run('UPDATE jogadores SET esquadrao = ? WHERE id = ?', [squad.name, target.id]);
        return {
            summary: `${playerDisplayName(target, target.id)}: esquadrão ${before || '-'} -> ${squad.name}`,
            before: { squad: before },
            after: { squad: squad.name, squadKey: squad.key },
        };
    }

    if (action.op === 'clear') {
        const before = player?.esquadrao || '-';
        await db.run("UPDATE jogadores SET esquadrao = '-' WHERE id = ?", [target.id]);
        return {
            summary: `${playerDisplayName(target, target.id)}: esquadrão ${before || '-'} -> -`,
            before: { squad: before },
            after: { squad: '-', squadKey: normalizeSquadKey(before) },
        };
    }

    if (action.op === 'stars') {
        const membership = action.name ? null : await resolvePlayerSquadMembership(db, target.id);
        const squadName = action.name || (membership?.ok ? membership.squadName : null);
        if (!squadName || squadName === '-') throw new Error('sem esquadrão para receber estrelas');
        const squad = await ensureSquad(db, squadName);
        const before = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [squad.key]);
        await db.run(
            `INSERT INTO clover_squads (squad_key, name, historical_stars, current_stars, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(squad_key) DO UPDATE SET
                 historical_stars = clover_squads.historical_stars + excluded.historical_stars,
                 current_stars = clover_squads.current_stars + excluded.current_stars,
                 updated_at = CURRENT_TIMESTAMP`,
            [squad.key, squad.name, action.amount, action.amount]
        );
        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at, metadata_json)
             VALUES (?, ?, ?, ?, 'cloverscript', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                squad.key,
                target.id,
                action.amount,
                action.amount > 0 ? 'ganho' : 'perda',
                action.reason,
                actorId,
                serialize({ cloverscript_run_id: run.id, direct_squad_action: true }),
            ]
        );
        const after = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [squad.key]);
        return {
            summary: `${squad.name}: estrelas ${Number(before?.current_stars || 0)} -> ${Number(after?.current_stars || 0)}`,
            before,
            after: { ...after, squadKey: squad.key },
        };
    }

    if (action.op === 'phrase') {
        const squad = await ensureSquad(db, action.name);
        const before = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [squad.key]);
        const after = await updateSquadPhrase(db, squad.key, action.text);
        return {
            summary: `${squad.name}: frase atualizada`,
            before,
            after: { ...after, squadKey: squad.key },
        };
    }

    throw new Error('ação de esquadrão inválida');
}

async function applyAntiGhostAction(db, ctx) {
    const { sock, target, action, actorId } = ctx;
    if (action.op === 'reset') {
        await resetPlayerActivity(db, target.id, action.reason);
        return { summary: `${playerDisplayName(target, target.id)}: anti-ghost resetado`, before: null, after: null };
    }
    if (action.op === 'skip') {
        await setExemption(db, target.id, action.days || 30, action.reason);
        return { summary: `${playerDisplayName(target, target.id)}: anti-ghost pausado por ${action.days || 30}d`, before: null, after: null };
    }
    if (action.op === 'remove') {
        const result = await removePlayerForAntiGhost({ sock, db, player: target, moderatorId: actorId, reason: action.reason });
        if (!result.ok) throw new Error(result.reason || 'não consegui remover');
        return { summary: `${playerDisplayName(target, target.id)}: removido por anti-ghost`, before: null, after: result };
    }
    throw new Error('ação anti-ghost inválida');
}

async function applyAttributeAction(db, { target, action }) {
    if (action.op === 'set') throw new Error('ATRIBUTO set recusado por segurança nesta versão; use add');
    const key = normalizeWord(action.attr);
    const increments = { [key]: action.value };
    const result = await applyAttributeUpgrade(db, target.id, increments);
    if (!result.ok) throw new Error(result.validation?.errors?.join(', ') || result.reason || 'atributo inválido');
    return {
        summary: `${playerDisplayName(target, target.id)}: atributo ${key} ${action.value > 0 ? '+' : ''}${action.value}`,
        before: null,
        after: result.values,
    };
}

async function applyTraitAction(db, { target, action }) {
    const field = action.field === 'gancho' ? 'gancho_narrativo' : action.field;
    if (!TRAIT_FIELDS.has(field)) throw new Error('campo de traço não permitido');
    const before = await getPlayerById(db, target.id);
    const value = action.op === 'clear' ? '-' : action.value;
    await db.run(`UPDATE jogadores SET ${field} = ? WHERE id = ?`, [value, target.id]);
    return {
        summary: `${playerDisplayName(target, target.id)}: ${field} -> ${value}`,
        before: { [field]: before?.[field] },
        after: { [field]: value },
    };
}

async function applyStatusAction(db, { target, action }) {
    const before = await getPlayerById(db, target.id);
    const assignments = [];
    const values = [];
    const after = {};
    for (const change of action.changes) {
        const field = STATUS_FIELDS[normalizeWord(change.field)];
        if (!field) throw new Error(`status não permitido: ${change.field}`);
        assignments.push(`${field} = ?`);
        values.push(normalizeStatusValue(change.value));
        after[field] = normalizeStatusValue(change.value);
    }
    values.push(target.id);
    await db.run(`UPDATE jogadores SET ${assignments.join(', ')} WHERE id = ?`, values);
    return {
        summary: `${playerDisplayName(target, target.id)}: status atualizado`,
        before,
        after,
    };
}

async function applyPersonAction(db, { target, action }) {
    const before = await getPlayerById(db, target.id);
    const assignments = [];
    const values = [];
    const after = {};
    for (const change of action.changes) {
        const field = normalizeWord(change.field);
        if (!SAFE_PERSON_FIELDS.has(field)) throw new Error(`campo de personagem não permitido: ${field}`);
        assignments.push(`${field} = ?`);
        values.push(change.value);
        after[field] = change.value;
    }
    values.push(target.id);
    await db.run(`UPDATE jogadores SET ${assignments.join(', ')} WHERE id = ?`, values);
    return {
        summary: `${playerDisplayName(target, target.id)}: personagem atualizado`,
        before,
        after,
    };
}

function isActiveSquadPlayer(player = {}) {
    const ficha = normalizeText(player.ficha_status || '');
    const jogo = normalizeText(player.jogo_status || '');
    const name = String(player.personagem_nome || '').trim();
    return ['aprovada', 'confirmada'].includes(ficha)
        && jogo === 'liberado'
        && name
        && !['-', '.'].includes(name);
}

async function syncCloverScriptSquadStarsForRun(db, runId, actorId = null) {
    await ensureCloverScriptSchema(db);
    await ensureCloverSquadSchema(db);

    const actionRows = await db.all(
        `SELECT id, player_id, summary, before_json, after_json
         FROM clover_script_actions
         WHERE run_id = ?
           AND action_type = 'stars'
           AND status = 'applied'
         ORDER BY id ASC`,
        [runId]
    );

    const synced = [];
    const skipped = [];

    for (const actionRow of actionRows) {
        const before = safeJsonParse(actionRow.before_json, {});
        const after = safeJsonParse(actionRow.after_json, {});
        if (!Object.prototype.hasOwnProperty.call(before, 'stars')
            || !Object.prototype.hasOwnProperty.call(after, 'stars')) {
            skipped.push({ actionId: actionRow.id, reason: 'not_individual_stars' });
            continue;
        }

        const amount = Number(after.stars || 0) - Number(before.stars || 0);
        if (!amount) {
            skipped.push({ actionId: actionRow.id, reason: 'zero_amount' });
            continue;
        }

        const player = await getPlayerById(db, actionRow.player_id);
        if (!player || !isActiveSquadPlayer(player)) {
            skipped.push({ actionId: actionRow.id, playerId: actionRow.player_id, reason: 'inactive_player' });
            continue;
        }

        const membership = await resolvePlayerSquadMembership(db, player.id);
        const squadName = membership.ok ? membership.squadName : null;
        const squadKey = membership.ok ? membership.squadKey : null;
        if (!squadKey) {
            skipped.push({ actionId: actionRow.id, playerId: actionRow.player_id, reason: 'missing_squad' });
            continue;
        }

        const duplicate = await db.get(
            `SELECT id
             FROM clover_squad_star_ledger
             WHERE source = 'cloverscript'
               AND player_id = ?
               AND metadata_json LIKE ?
             LIMIT 1`,
            [actionRow.player_id, `%"cloverscript_action_id":${actionRow.id}%`]
        );
        if (duplicate) {
            skipped.push({ actionId: actionRow.id, playerId: actionRow.player_id, reason: 'already_synced' });
            continue;
        }

        await db.run(
            `INSERT INTO clover_squads
             (squad_key, name, historical_stars, current_stars, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(squad_key) DO UPDATE SET
                 name = CASE
                     WHEN clover_squads.name IS NULL OR clover_squads.name = '' THEN excluded.name
                     ELSE clover_squads.name
                 END,
                 historical_stars = clover_squads.historical_stars + excluded.historical_stars,
                 current_stars = clover_squads.current_stars + excluded.current_stars,
                 updated_at = CURRENT_TIMESTAMP`,
            [squadKey, squadName, amount, amount]
        );

        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at, metadata_json)
             VALUES (?, ?, ?, ?, 'cloverscript', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                squadKey,
                actionRow.player_id,
                amount,
                amount > 0 ? 'ganho' : 'perda',
                actionRow.summary || 'Estrelas individuais por CloverScript',
                actorId,
                serialize({
                    cloverscript_run_id: runId,
                    cloverscript_action_id: actionRow.id,
                    sync: 'individual_stars_to_squad',
                }),
            ]
        );

        synced.push({
            actionId: actionRow.id,
            playerId: actionRow.player_id,
            squadKey,
            squadName,
            amount,
        });
    }

    return {
        ok: true,
        runId,
        synced,
        skipped,
    };
}

async function applyOneAction(db, ctx) {
    if (ctx.action.type === 'ph') return applyPhAction(db, ctx);
    if (ctx.action.type === 'yulls' || ctx.action.type === 'yulls_set') return applyYullsAction(db, ctx);
    if (ctx.action.type === 'stars') return applyStarsAction(db, ctx);
    if (ctx.action.type === 'item') return applyItemAction(db, ctx);
    if (ctx.action.type === 'spell') return applySpellAction(db, ctx);
    if (ctx.action.type === 'hexagon') return applyHexagonAction(db, ctx);
    if (ctx.action.type === 'tree') return applyTreeAction(db, ctx);
    if (ctx.action.type === 'return_bonus') return applyReturnBonusAction(db, ctx);
    if (ctx.action.type === 'bonus') return applyBonusAction(db, ctx);
    if (ctx.action.type === 'squad') return applySquadAction(db, ctx);
    if (ctx.action.type === 'antighost') return applyAntiGhostAction(db, ctx);
    if (ctx.action.type === 'attribute') return applyAttributeAction(db, ctx);
    if (ctx.action.type === 'trait') return applyTraitAction(db, ctx);
    if (ctx.action.type === 'status') return applyStatusAction(db, ctx);
    if (ctx.action.type === 'person') return applyPersonAction(db, ctx);
    throw new Error(`ação não implementada: ${ctx.action.type}`);
}

async function applySimulation(db, { code = null, actorId, chatId, sock = null } = {}) {
    await ensureCloverScriptSchema(db);
    const run = await getSimulation(db, { code, actorId, chatId });
    if (!run) throw new CloverScriptError('Não encontrei simulação pendente.', null, 'missing_simulation');
    if (run.status !== RUN_STATUS.SIMULATED) {
        throw new CloverScriptError('Essa simulação não está pendente.', null, 'invalid_status');
    }

    const plan = safeJsonParse(run.plan_json, null);
    if (!plan) throw new CloverScriptError('Plano salvo está inválido.', null, 'invalid_plan');
    const duplicate = await hasAppliedBatch(db, plan.header?.id);
    if (duplicate && duplicate.id !== run.id && !plan.header?.confirm) {
        throw new CloverScriptError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }

    const flat = flattenPlan(plan);
    const results = [];
    let failed = false;
    for (let index = 0; index < flat.length; index += 1) {
        const item = flat[index];
        try {
            const applied = await applyOneAction(db, {
                ...item,
                db,
                sock,
                actorId,
                run,
                index: index + 1,
            });
            results.push({ ok: true, ...applied });
            await db.run(
                `INSERT INTO clover_script_actions
                 (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
                 VALUES (?, ?, ?, ?, 'applied', ?, ?, CURRENT_TIMESTAMP)`,
                [run.id, item.target.id, item.action.type, applied.summary, serialize(applied.before), serialize(applied.after)]
            );
        } catch (error) {
            failed = true;
            const message = error?.message || String(error);
            results.push({ ok: false, error: message, summary: describeAction(item.action) });
            await db.run(
                `INSERT INTO clover_script_actions
                 (run_id, player_id, action_type, summary, status, error, created_at)
                 VALUES (?, ?, ?, ?, 'failed', ?, CURRENT_TIMESTAMP)`,
                [run.id, item.target.id, item.action.type, describeAction(item.action), message]
            );
            if (plan.header?.mode === 'rigido') break;
        }
    }

    let squadStarSync = null;
    try {
        squadStarSync = await syncCloverScriptSquadStarsForRun(db, run.id, actorId);
        if (squadStarSync.synced.length) {
            results.push({
                ok: true,
                summary: `Esquadroes: ${squadStarSync.synced.length} movimentacao(oes) de estrelas sincronizada(s).`,
            });
        }
    } catch (error) {
        failed = true;
        results.push({
            ok: false,
            error: error?.message || String(error),
            summary: 'Sincronizacao de estrelas dos esquadroes',
        });
    }

    const affectedSquads = new Set();
    for (const item of results) {
        if (item?.after?.squadKey) affectedSquads.add(item.after.squadKey);
        if (item?.before?.squadKey) affectedSquads.add(item.before.squadKey);
    }
    for (const synced of squadStarSync?.synced || []) {
        if (synced.squadKey) affectedSquads.add(synced.squadKey);
    }
    if (sock && affectedSquads.size) {
        let syncedCount = 0;
        for (const squadKey of affectedSquads) {
            const sync = await syncSquadGroupDescription({ sock, db, squadKey }).catch((error) => ({ ok: false, error }));
            if (sync?.ok) syncedCount += 1;
        }
        results.push({
            ok: true,
            summary: `Esquadroes: ${syncedCount}/${affectedSquads.size} descricao(oes) sincronizada(s).`,
        });
    }

    await db.run(
        `UPDATE clover_script_runs
         SET status = ?, applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = ?
         WHERE id = ?`,
        [failed ? RUN_STATUS.FAILED : RUN_STATUS.APPLIED, actorId || null, failed ? 'falha durante aplicação' : null, run.id]
    );

    return {
        ok: !failed,
        run,
        plan,
        results,
        squadStarSync,
        text: renderApplyResult({ run, results, failed }),
    };
}

async function cancelSimulation(db, { actorId, chatId } = {}) {
    await ensureCloverScriptSchema(db);
    const run = await getSimulation(db, { actorId, chatId });
    if (!run) return { ok: false };
    await db.run(
        'UPDATE clover_script_runs SET status = ?, error = ? WHERE id = ?',
        [RUN_STATUS.CANCELLED, 'cancelado pelo usuário', run.id]
    );
    return { ok: true, run };
}

async function getScriptHistory(db, { playerId = null, limit = 10 } = {}) {
    await ensureCloverScriptSchema(db);
    if (playerId) {
        return db.all(
            `SELECT a.*, r.code, r.batch_id, r.created_at AS run_created_at
             FROM clover_script_actions a
             JOIN clover_script_runs r ON r.id = a.run_id
             WHERE a.player_id = ?
             ORDER BY a.id DESC
             LIMIT ?`,
            [playerId, Math.max(1, Math.min(30, Number(limit) || 10))]
        );
    }
    return db.all(
        `SELECT *
         FROM clover_script_runs
         ORDER BY id DESC
         LIMIT ?`,
        [Math.max(1, Math.min(30, Number(limit) || 10))]
    );
}

function renderHistory(rows) {
    if (!rows.length) {
        return '*♧┃HISTÓRICO CLOVER 𖥔 CLOVER MULTICOLOR*\n\n> Nenhum registro encontrado.';
    }
    return [
        '*♧┃HISTÓRICO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── últimos registros ──',
        '',
        ...rows.map((row) => (
            row.action_type
                ? `*${row.code || '-'}* · ${row.action_type}\n> ${row.summary || row.status || '-'}`
                : `*${row.code}* · ${row.status}\n> ${row.batch_id || row.batch_name || 'sem lote'}`
        )),
    ].join('\n');
}

function renderCloverScriptResources() {
    const active = [
        'ALVO/ALVOS por @menção, número, id, nome e alvo composto tel=1234 personagem="Nome".',
        'ALVOS lista="codigo-da-lista" usando listas privadas resolvidas para player_id canonico.',
        'ALVO resposta dentro do script.',
        'PH +N concede progresso; PH -N corrige saldo e progresso acumulado sem apagar o ledger.',
        'YULLS +N/-N e YULLS set.',
        'ESTRELAS +N/-N individuais; sincroniza estrelas do esquadrão quando o player está liberado.',
        'ITEM adicionar/remover.',
        'FEITIÇO adicionar/atualizar/remover com FICHA/FIM_FICHA.',
        'HEXÁGONO set/add.',
        'ÁRVORE comprar/conceder.',
        'RETORNO bônus.',
        'BONUS adicionar/remover, salvo no personagem, no .#bonus e na API.',
        'ESQUADRÃO set/limpar/estrelas/frase.',
        'ATRIBUTO add.',
        'TRAÇO set/limpar.',
        'STATUS campo=value.',
        'PERSONAGEM set campo=value.',
        'ANTIGHOST resetar/pular/remover.',
    ];

    const inactive = [
        'ITEM set.',
        'ÁRVORE remover.',
        'ATRIBUTO set.',
        'modo=parcial completo por transação de bloco.',
        'Executar sem simulação prévia.',
        'SQL, JavaScript, eval ou comandos fora da lista oficial.',
    ];

    return [
        '*♧┃RECURSOS CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*',
        '     ── ações reconhecidas pelo executor atual ──',
        '',
        '_`─( ✓ )───── Ativo`_',
        '',
        ...active.map((item) => `> ${item}`),
        '',
        '_`─( ! )───── Inativo / recusado`_',
        '',
        ...inactive.map((item) => `> ${item}`),
        '',
        '_`─( ? )───── Regra`_',
        '',
        '> Comando desconhecido continua recusado.',
        '> Se o alvo ficar ambíguo, o bot recusa antes de aplicar.',
    ].join('\n');
}

module.exports = {
    CloverScriptError,
    applySimulation,
    buildPlan,
    cancelSimulation,
    createSimulation,
    ensureCloverScriptSchema,
    getScriptHistory,
    parseScript,
    previewAction,
    renderCloverScriptResources,
    renderHistory,
    renderSimulation,
    syncCloverScriptSquadStarsForRun,
};
