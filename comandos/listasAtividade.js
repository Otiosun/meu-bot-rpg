const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');
const { ensureAntiGhostSchema } = require('../helpers/clover/antiGhostService');

const DAY = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 50;

function norm(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const text = String(value).trim();
    if (!text) return null;

    const direct = new Date(text);
    if (!Number.isNaN(direct.getTime())) return direct;

    const sqliteLike = new Date(text.replace(' ', 'T'));
    return Number.isNaN(sqliteLike.getTime()) ? null : sqliteLike;
}

function shortDate(value) {
    const text = String(value || '').trim();
    return text ? text.replace('T', ' ').slice(0, 16) : '-';
}

function daysFrom(value) {
    const date = parseDate(value);
    if (!date) return 999;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / DAY));
}

function latest(values) {
    let best = null;
    let bestTime = -Infinity;

    for (const value of values || []) {
        const date = parseDate(value);
        if (!date) continue;

        if (date.getTime() > bestTime) {
            bestTime = date.getTime();
            best = value;
        }
    }

    return best;
}

function nameOf(row) {
    return String(row.personagem_nome || row.display_name || row.nome || row.id || '-').trim();
}

function mentionOf(id) {
    return '@' + String(id || '').split('@')[0];
}

function communityLabel(value) {
    if (value === 'member') return 'dentro';
    if (value === 'out') return 'fora';
    return 'desconhecida';
}

function noticeLabel(value) {
    return ({
        light_3: 'lembrete 3d',
        checklist_5: 'checklist 5d',
        official_7: 'aviso 7d',
        strong_10: 'aviso 10d',
        candidate_14: 'análise 14d',
        exempt: 'pausa',
    })[value] || value || '-';
}

function joinedAt(row) {
    return row.jogo_liberado_at
        || row.historia_aprovada_at
        || row.historia_status_updated_at
        || row.ultima_recepcao_em
        || null;
}

function lastStrong(row) {
    return latest([
        row.last_activity_at,
        row.last_on_message_at,
        row.last_command_at,
        row.last_evaluation_at,
    ]) || joinedAt(row);
}

function parseOptions(body, matchedCommand) {
    const command = norm(String(matchedCommand || '').replace(COMMAND_PREFIX, ''));
    const options = {
        mode: ['fora', 'foracomunidade', 'comunidadefora'].includes(command) ? 'fora' : 'inativos',
        minDays: 0,
        limit: 30,
        community: 'all',
    };

    if (options.mode === 'fora') options.community = 'out';

    const tokens = String(body || '').split(/\s+/).filter(Boolean);

    for (let i = 0; i < tokens.length; i += 1) {
        const token = norm(tokens[i]);

        if (/^\d+$/.test(token)) {
            options.minDays = Math.max(0, Math.min(999, Number(token)));
            continue;
        }

        if (['limite', 'limit', 'max'].includes(token) && /^\d+$/.test(tokens[i + 1] || '')) {
            options.limit = Math.max(1, Math.min(MAX_LIMIT, Number(tokens[i + 1])));
            i += 1;
            continue;
        }

        if (['fora', 'out', 'off', 'ausente', 'ausentes'].includes(token)) {
            options.community = 'out';
            continue;
        }

        if (['dentro', 'member', 'membro', 'membros'].includes(token)) {
            options.community = 'member';
            continue;
        }

        if (['unknown', 'desconhecido', 'desconhecida', 'pendente'].includes(token)) {
            options.community = 'unknown';
            continue;
        }

        if (['todos', 'all', 'geral'].includes(token)) {
            options.community = 'all';
        }
    }

    if (options.mode === 'fora') options.community = 'out';
    return options;
}

async function fetchRows(db) {
    await ensureAntiGhostSchema(db);

    return db.all(
        `SELECT j.*,
                a.last_on_message_at,
                a.last_off_message_at,
                a.last_command_at,
                a.last_evaluation_at,
                a.last_activity_at,
                a.community_status,
                a.last_community_seen_at,
                a.last_notice_level,
                a.last_notice_at,
                a.candidate_at,
                a.exempt_until,
                a.exempt_reason
         FROM jogadores j
         LEFT JOIN clover_antighost_activity a ON a.player_id = j.id
         WHERE j.jogo_status = 'liberado'`
    );
}

function toItem(row) {
    const last = lastStrong(row);

    return {
        id: row.id,
        name: nameOf(row),
        community: row.community_status || 'unknown',
        joined: joinedAt(row),
        last,
        days: daysFrom(last),
        notice: row.last_notice_level || null,
    };
}

function sortItems(a, b) {
    if (b.days !== a.days) return b.days - a.days;

    const aj = parseDate(a.joined)?.getTime() || Number.MAX_SAFE_INTEGER;
    const bj = parseDate(b.joined)?.getTime() || Number.MAX_SAFE_INTEGER;
    if (aj !== bj) return aj - bj;

    return a.name.localeCompare(b.name, 'pt-BR');
}

async function getItems(db, options) {
    const rows = await fetchRows(db);

    return rows
        .map(toItem)
        .filter((item) => options.community === 'all' || item.community === options.community)
        .filter((item) => item.days >= options.minDays)
        .sort(sortItems)
        .slice(0, options.limit);
}

function renderItem(item, index) {
    const notice = item.notice ? ' · ' + noticeLabel(item.notice) : '';
    const joined = item.joined ? ' · entrou ' + shortDate(item.joined) : '';

    return [
        `${index + 1}. *${item.name}*`,
        `> ${mentionOf(item.id)} · ${item.days}d sem atividade forte`,
        `> comunidade ${communityLabel(item.community)}${notice}`,
        `> última ${shortDate(item.last)}${joined}`,
    ].join('\n');
}

function renderList(items, options) {
    const title = options.mode === 'fora'
        ? '*♧┃FORA DA COMUNIDADE 𖥔 CLOVER MULTICOLOR*'
        : '*♧┃RANKING DE INATIVIDADE 𖥔 CLOVER MULTICOLOR*';

    const sub = options.mode === 'fora'
        ? '     ── players fora do grupo ──'
        : '     ── mais parados primeiro ──';

    const lines = [
        title,
        sub,
        '',
        '_`─( ◆ )───── Filtro`_',
        `*Dias mínimos:* ${options.minDays}`,
        `*Comunidade:* ${options.community === 'all' ? 'todos' : communityLabel(options.community)}`,
        `*Mostrando:* ${items.length}`,
        '',
        '_`─( ! )───── Lista`_',
    ];

    if (!items.length) {
        lines.push('> Ninguém encontrado nesse filtro.');
    } else {
        items.forEach((item, index) => {
            if (index) lines.push('');
            lines.push(renderItem(item, index));
        });
    }

    lines.push(
        '',
        '_`─( ✓ )───── Uso`_',
        `> ${COMMAND_PREFIX}antighost sincronizarcomunidade`,
        `> ${COMMAND_PREFIX}inativos 7`,
        `> ${COMMAND_PREFIX}inativos fora`,
        `> ${COMMAND_PREFIX}fora`
    );

    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}inativos`,
    aliases: [
        `${COMMAND_PREFIX}ghosts`,
        `${COMMAND_PREFIX}rankingghost`,
        `${COMMAND_PREFIX}rankingghosts`,
        `${COMMAND_PREFIX}foracomunidade`,
        `${COMMAND_PREFIX}comunidadefora`,
        `${COMMAND_PREFIX}fora`,
    ],
    descricao: 'Mostra ranking de inatividade e players fora da comunidade.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar esse comando.' });
            return;
        }

        const options = parseOptions(body, matchedCommand);
        const items = await getItems(db, options);

        await sendReply({
            sock,
            idChat,
            m,
            mentions: items.map((item) => item.id).filter(Boolean),
            text: renderList(items, options),
        });
    },
};
