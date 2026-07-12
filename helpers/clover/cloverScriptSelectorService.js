const { isOwner } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const { ensureTargetResolverSchema, getCanonicalPlayer } = require('./targetResolver');
const { ensureTargetResolverTables } = require('./targetResolverSchemaGuard');
const { playerDisplayName } = require('./commandTargetUtils');

const MAX_SELECTOR_TARGETS = 200;

const FILTER_ALIASES = {
    jogo: 'jogo_status',
    game: 'jogo_status',
    jogo_status: 'jogo_status',
    ficha: 'ficha_status',
    profile: 'ficha_status',
    ficha_status: 'ficha_status',
    historia: 'historia_status',
    history: 'historia_status',
    historia_status: 'historia_status',
    aparencia: 'personagem_aparencia_status',
    appearance: 'personagem_aparencia_status',
    personagem_aparencia_status: 'personagem_aparencia_status',
    comunidade: 'community_status',
    community: 'community_status',
    community_status: 'community_status',
    esquadrao: 'esquadrao',
    squad: 'esquadrao',
    lifecycle: 'lifecycle_status',
    ciclo: 'lifecycle_status',
    lifecycle_status: 'lifecycle_status',
    patente: 'patente',
    rank: 'patente',
    reino: 'reino',
    kingdom: 'reino',
    dias_inativo: 'inactive_days',
    diasinativo: 'inactive_days',
    inactive_days: 'inactive_days',
    inativo: 'inactive_days',
    id: 'id',
    player_id: 'id',
    confirmar: 'confirm',
    confirm: 'confirm',
    sombra: 'shadow',
    shadow: 'shadow',
};

const COMMUNITY_ALIASES = {
    dentro: 'in',
    in: 'in',
    ativo: 'in',
    fora: 'out',
    out: 'out',
    saiu: 'out',
    desconhecido: 'unknown',
    unknown: 'unknown',
};

class CloverScriptSelectorError extends Error {
    constructor(message, line = null, code = 'invalid_selector', details = null) {
        super(message);
        this.name = 'CloverScriptSelectorError';
        this.line = line;
        this.code = code;
        this.details = details || null;
    }
}

function normalizeKey(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeValue(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9@._:-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return text;
}

function hasSelectorTargets(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .some((line) => /^\s*(ALVOS\s+ONDE\b|TODOS\b)/i.test(line));
}

function parseFilterExpression(text, lineNumber) {
    const source = String(text || '').trim();
    const filters = [];
    const regex = /([A-Za-zÀ-ÿ0-9_]+)\s*(>=|<=|!=|=|>|<)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    let consumed = '';
    while ((match = regex.exec(source))) {
        const rawKey = normalizeKey(match[1]);
        const key = FILTER_ALIASES[rawKey];
        if (!key) {
            throw new CloverScriptSelectorError(`Filtro desconhecido: ${match[1]}.`, lineNumber, 'unknown_filter');
        }
        const value = stripQuotes(match[3]);
        filters.push({ key, operator: match[2], value, rawKey: match[1] });
        consumed += ` ${match[0]}`;
    }

    const residue = source
        .replace(regex, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (residue) {
        throw new CloverScriptSelectorError(`Trecho de filtro inválido: ${residue}.`, lineNumber, 'invalid_filter_syntax');
    }

    const confirm = filters.find((filter) => filter.key === 'confirm');
    if (!confirm || !['true', 'sim', 'yes', '1'].includes(normalizeKey(confirm.value))) {
        throw new CloverScriptSelectorError(
            'Seletores em massa precisam de confirmar=true na linha ALVOS onde/TODOS.',
            lineNumber,
            'selector_confirmation_required'
        );
    }

    const effective = filters.filter((filter) => filter.key !== 'confirm');
    if (!effective.length) {
        throw new CloverScriptSelectorError('Seletor sem filtro. Informe pelo menos uma condição.', lineNumber, 'empty_selector');
    }
    const shadow = effective.find((filter) => filter.key === 'shadow');
    if (shadow && !['false', 'nao', 'não', '0'].includes(normalizeKey(shadow.value))) {
        throw new CloverScriptSelectorError(
            'Seletores mecânicos não podem incluir cadastros sombra. Use sombra=false ou remova esse filtro.',
            lineNumber,
            'shadow_selector_forbidden'
        );
    }

    return effective;
}

function selectorFromLine(line, lineNumber) {
    const text = String(line || '').trim();
    const where = text.match(/^ALVOS\s+ONDE\s+([\s\S]+)$/i);
    if (where) {
        return {
            kind: 'where',
            raw: text,
            line: lineNumber,
            filters: parseFilterExpression(where[1], lineNumber),
        };
    }
    const all = text.match(/^TODOS\s+([\s\S]+)$/i);
    if (all) {
        return {
            kind: 'all',
            raw: text,
            line: lineNumber,
            filters: parseFilterExpression(all[1], lineNumber),
        };
    }
    return null;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`).catch(() => []);
    return new Set((rows || []).map((row) => row.name));
}

async function loadSelectorPlayers(db) {
    const columns = await tableColumns(db, 'jogadores');
    const desired = [
        'id',
        'nome',
        'display_name',
        'personagem_nome',
        'jogo_status',
        'ficha_status',
        'historia_status',
        'personagem_aparencia_status',
        'esquadrao',
        'lifecycle_status',
        'patente',
        'reino',
        'is_shadow',
        'canonical_player_id',
        'merged_into',
        'identity_status',
    ].filter((column) => columns.has(column));
    if (!desired.includes('id')) throw new CloverScriptSelectorError('Tabela jogadores sem coluna id.', null, 'invalid_player_table');
    const players = await db.all(`SELECT ${desired.join(', ')} FROM jogadores ORDER BY id`);

    const community = new Map();
    if (await tableExists(db, 'clover_antighost_activity')) {
        const activityColumns = await tableColumns(db, 'clover_antighost_activity');
        if (activityColumns.has('player_id')) {
            const selected = ['player_id'];
            if (activityColumns.has('community_status')) selected.push('community_status');
            if (activityColumns.has('last_activity_at')) selected.push('last_activity_at');
            const rows = await db.all(`SELECT ${selected.join(', ')} FROM clover_antighost_activity`);
            for (const row of rows || []) community.set(row.player_id, row);
        }
    }
    return { players: players || [], community };
}

function isEmptyCharacter(value) {
    const normalized = normalizeValue(value);
    return !normalized || ['-', 'nenhum', 'na', 'n a', 'null', 'undefined'].includes(normalized);
}

function parseDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
        ? `${text.replace(' ', 'T')}Z`
        : text;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
}

function compareNumber(actual, operator, expected) {
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
    if (operator === '=') return actual === expected;
    if (operator === '!=') return actual !== expected;
    if (operator === '>=') return actual >= expected;
    if (operator === '<=') return actual <= expected;
    if (operator === '>') return actual > expected;
    if (operator === '<') return actual < expected;
    return false;
}

function compareText(actual, operator, expected) {
    const left = normalizeValue(actual);
    const right = normalizeValue(expected);
    if (operator === '=') return left === right;
    if (operator === '!=') return left !== right;
    return false;
}

function communityValue(value) {
    const normalized = normalizeKey(value);
    return COMMUNITY_ALIASES[normalized] || normalized || 'unknown';
}

function evaluateFilter(row, activity, filter, now) {
    if (filter.key === 'inactive_days') {
        const expected = Number(filter.value);
        const last = parseDate(activity?.last_activity_at);
        if (!last || !Number.isFinite(expected)) return { match: false, reason: 'atividade_desconhecida' };
        const actual = Math.floor((now.getTime() - last.getTime()) / 86400000);
        return { match: compareNumber(actual, filter.operator, expected), reason: `dias_inativo_${filter.operator}_${expected}` };
    }
    if (filter.key === 'community_status') {
        const actual = communityValue(activity?.community_status || 'unknown');
        const expected = communityValue(filter.value);
        return { match: compareText(actual, filter.operator, expected), reason: `comunidade_${expected}` };
    }
    if (filter.key === 'shadow') {
        const actual = Number(row.is_shadow || 0) === 1 ? 'true' : 'false';
        return { match: compareText(actual, filter.operator, normalizeKey(filter.value)), reason: 'sombra' };
    }
    const actual = row[filter.key];
    return { match: compareText(actual, filter.operator, filter.value), reason: `${filter.key}_${filter.operator}_${normalizeKey(filter.value)}` };
}

async function selectPlayers(db, selector, options = {}) {
    await ensureTargetResolverTables(db);
    await ensureTargetResolverSchema(db);
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const { players, community } = await loadSelectorPlayers(db);
    const byId = new Map(players.map((player) => [player.id, player]));
    const matched = [];
    const excluded = new Map();

    function exclude(reason) {
        excluded.set(reason, Number(excluded.get(reason) || 0) + 1);
    }

    for (const rawPlayer of players) {
        if (Number(rawPlayer.is_shadow || 0) === 1) {
            const destination = rawPlayer.merged_into || rawPlayer.canonical_player_id || null;
            if (!destination || !byId.has(destination)) {
                exclude('cadastro_sombra');
                continue;
            }
        }

        let canonical = rawPlayer;
        const canonicalId = rawPlayer.merged_into || rawPlayer.canonical_player_id || rawPlayer.id;
        if (canonicalId !== rawPlayer.id) {
            canonical = byId.get(canonicalId) || null;
            if (!canonical) {
                exclude('canonico_inexistente');
                continue;
            }
        }
        if (Number(canonical.is_shadow || 0) === 1) {
            exclude('cadastro_sombra');
            continue;
        }
        if (isEmptyCharacter(canonical.personagem_nome)) {
            exclude('personagem_ausente');
            continue;
        }
        if (normalizeKey(canonical.identity_status || 'active') === 'merged') {
            exclude('identidade_mesclada');
            continue;
        }

        const activity = community.get(canonical.id) || community.get(rawPlayer.id) || null;
        let accepted = true;
        for (const filter of selector.filters) {
            const result = evaluateFilter(canonical, activity, filter, now);
            if (!result.match) {
                accepted = false;
                exclude(result.reason);
                break;
            }
        }
        if (!accepted) continue;
        matched.push(canonical);
    }

    const unique = [...new Map(matched.map((player) => [player.id, player])).values()];
    if (!unique.length) {
        throw new CloverScriptSelectorError(
            `Seletor da linha ${selector.line} não encontrou nenhum player canônico válido.`,
            selector.line,
            'empty_selector_result',
            { selector: selector.raw, excluded: Object.fromEntries(excluded) }
        );
    }
    if (unique.length > MAX_SELECTOR_TARGETS) {
        throw new CloverScriptSelectorError(
            `Seletor encontrou ${unique.length} players; o máximo seguro é ${MAX_SELECTOR_TARGETS}.`,
            selector.line,
            'selector_limit_exceeded',
            { selector: selector.raw, found: unique.length, limit: MAX_SELECTOR_TARGETS }
        );
    }

    return {
        selector,
        players: unique,
        excluded: Object.fromEntries([...excluded.entries()].sort((a, b) => b[1] - a[1])),
    };
}

function findBlockEnd(lines, targetIndex) {
    let longBlockEnd = null;
    for (let index = targetIndex + 1; index < lines.length; index += 1) {
        const text = String(lines[index] || '').trim();
        const normalized = normalizeKey(text);
        if (longBlockEnd) {
            if (normalized === longBlockEnd) longBlockEnd = null;
            continue;
        }
        if (normalized === 'ficha') {
            longBlockEnd = 'fim_ficha';
            continue;
        }
        if (normalized === 'desc') {
            longBlockEnd = 'fim_desc';
            continue;
        }
        if (normalized === 'fim') return index;
    }
    return -1;
}

function validateSelectorActions(actionLines, lineNumber) {
    const meaningful = actionLines.map((line) => String(line || '').trim()).filter(Boolean);
    if (!meaningful.length) {
        throw new CloverScriptSelectorError('Bloco seletor sem ações.', lineNumber, 'empty_selector_block');
    }
    const protectedAction = meaningful.find((line) => /^(PLAYER\s+(arquivar|reativar)|DESFAZER\b)/i.test(line));
    if (protectedAction) {
        throw new CloverScriptSelectorError(
            'Seletores em massa não aceitam PLAYER arquivar/reativar nem DESFAZER.',
            lineNumber,
            'protected_action_selector_forbidden'
        );
    }
}

function renderSelectorSummary(selections) {
    const lines = [
        '_`─( ⬡ )───── Seletores resolvidos`_',
        '',
    ];
    for (const selection of selections) {
        const sample = selection.players.slice(0, 8).map((player) => playerDisplayName(player, player.id));
        lines.push(`*Linha ${selection.selector.line}:* ${selection.players.length} player(s)`);
        lines.push(`> ${selection.selector.raw}`);
        lines.push(`> Incluídos: ${sample.join(', ')}${selection.players.length > sample.length ? ` e mais ${selection.players.length - sample.length}` : ''}`);
        const excluded = Object.entries(selection.excluded).slice(0, 5);
        if (excluded.length) lines.push(`> Excluídos: ${excluded.map(([reason, total]) => `${reason}=${total}`).join(' · ')}`);
        lines.push('');
    }
    lines.push('> A simulação abaixo usa player_id canônico e foi expandida de forma determinística.');
    return lines.join('\n');
}

async function expandSelectorScript(db, scriptText, options = {}) {
    if (!hasSelectorTargets(scriptText)) {
        return { ok: true, expanded: false, scriptText: String(scriptText || ''), selections: [], summaryText: '' };
    }
    if (!isOwner(options.actorId)) {
        throw new CloverScriptSelectorError('ALVOS onde/TODOS é apenas para Owner.', null, 'permission_denied');
    }

    const lines = String(scriptText || '').replace(/\r\n/g, '\n').split('\n');
    const output = [];
    const selections = [];

    for (let index = 0; index < lines.length; index += 1) {
        const selector = selectorFromLine(lines[index], index + 1);
        if (!selector) {
            output.push(lines[index]);
            continue;
        }

        const endIndex = findBlockEnd(lines, index);
        if (endIndex < 0) {
            throw new CloverScriptSelectorError('Bloco seletor sem FIM.', selector.line, 'missing_fim');
        }
        const actionLines = lines.slice(index + 1, endIndex);
        validateSelectorActions(actionLines, selector.line);
        const selection = await selectPlayers(db, selector, options);
        selections.push(selection);

        output.push(`// seletor original: ${selector.raw}`);
        output.push(`// seletor expandido: ${selection.players.length} player(s) canônico(s)`);
        for (const player of selection.players) {
            output.push(`ALVO id="${player.id}" confirmar=true`);
            output.push(...actionLines);
            output.push('FIM');
            output.push('');
        }
        index = endIndex;
    }

    return {
        ok: true,
        expanded: true,
        originalScriptText: String(scriptText || ''),
        scriptText: output.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        selections,
        summaryText: renderSelectorSummary(selections),
    };
}

module.exports = {
    CloverScriptSelectorError,
    FILTER_ALIASES,
    MAX_SELECTOR_TARGETS,
    expandSelectorScript,
    hasSelectorTargets,
    parseFilterExpression,
    renderSelectorSummary,
    selectPlayers,
    selectorFromLine,
};
