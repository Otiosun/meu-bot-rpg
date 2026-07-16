'use strict';

const DEFAULT_PAGE_SIZE = 8;

function normalizeCompact(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parsePageNumber(value, fallback = 1) {
    const text = normalizeCompact(value);
    if (!text) return fallback;
    const direct = text.match(/^\d{1,3}$/);
    if (direct) return Math.max(1, Number(direct[0]));
    const labeled = text.match(/^(?:pagina|pag|p)\s+(\d{1,3})$/);
    if (labeled) return Math.max(1, Number(labeled[1]));
    return null;
}

function paginateSpells(spells, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const list = Array.isArray(spells) ? spells : [];
    const safePageSize = Math.max(1, Math.min(20, Number(pageSize) || DEFAULT_PAGE_SIZE));
    const totalPages = Math.max(1, Math.ceil(list.length / safePageSize));
    const requestedPage = Math.max(1, Number(page) || 1);
    const valid = requestedPage <= totalPages;
    const start = valid ? (requestedPage - 1) * safePageSize : 0;
    return {
        items: valid ? list.slice(start, start + safePageSize) : [],
        page: requestedPage,
        pageSize: safePageSize,
        start,
        total: list.length,
        totalPages,
        valid,
    };
}

function selectSpellByIndex(spells, query) {
    const text = String(query || '').trim();
    if (!/^\d{1,4}$/.test(text)) return null;
    const index = Number(text);
    const list = Array.isArray(spells) ? spells : [];
    if (index < 1 || index > list.length) {
        return { ok: false, code: 'index_out_of_range', index, total: list.length };
    }
    return { ok: true, spell: list[index - 1], index };
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function formatBlock(value) {
    const text = String(value || '-').trim() || '-';
    return text.split('\n').map((line) => `> ${line.trim() || '-'}`).join('\n');
}

function compactUsage(spell) {
    return [spell?.cost, spell?.reach, spell?.duration]
        .map((value) => String(value || '-').trim() || '-')
        .join(' · ');
}

function buildTargetSuffix(targetMention = '') {
    const mention = String(targetMention || '').trim();
    return mention ? ` ${mention}` : '';
}

function renderGrimoirePage(playerLabel, spells, {
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    prefix = '.#',
    targetMention = '',
} = {}) {
    const pagination = paginateSpells(spells, page, pageSize);
    const targetSuffix = buildTargetSuffix(targetMention);

    if (!pagination.valid) {
        return [
            '*♧┃𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            `> Página ${pagination.page} não existe. Este grimório possui ${pagination.totalPages} página(s).`,
            `> Use: ${prefix}grimorio${targetSuffix} pagina ${pagination.totalPages}`,
        ].join('\n');
    }

    const lines = [
        '*♧┃𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  índice de feitiços aprovados  ──',
        '',
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${playerLabel}`,
        `*𝐅𝐞𝐢𝐭𝐢𝐜̧𝐨𝐬:* ${pagination.total}`,
        `*𝐏𝐚́𝐠𝐢𝐧𝐚:* ${pagination.page}/${pagination.totalPages}`,
        '',
    ];

    if (!pagination.total) {
        lines.push('> Nenhum feitiço aprovado foi salvo ainda.');
        return lines.join('\n');
    }

    lines.push(section('✦', '𝗙𝗲𝗶𝘁𝗶𝗰̧𝗼𝘀'), '');
    pagination.items.forEach((spell, localIndex) => {
        const globalIndex = pagination.start + localIndex + 1;
        lines.push(`*${globalIndex}. ${spell.name}* · ${spell.type} · v${spell.version}`);
    });

    lines.push(
        '',
        section('◆', '𝗔𝗯𝗿𝗶𝗿'),
        '',
        `> ${prefix}feitico${targetSuffix} <número ou nome>`,
    );

    if (pagination.totalPages > 1) {
        const navigation = [];
        if (pagination.page > 1) navigation.push(`${prefix}grimorio${targetSuffix} pagina ${pagination.page - 1}`);
        if (pagination.page < pagination.totalPages) navigation.push(`${prefix}grimorio${targetSuffix} pagina ${pagination.page + 1}`);
        lines.push(`> ${navigation.join('  ·  ')}`);
    }

    return lines.join('\n');
}

function renderSpellCardPlayer(spell) {
    return [
        '*♧┃𝐅𝐄𝐈𝐓𝐈𝐂̧𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  versão aprovada  ──',
        '',
        `*𝐍𝐨𝐦𝐞:* ${spell.name}`,
        `*𝐓𝐢𝐩𝐨:* ${spell.type} · *𝐕𝐞𝐫𝐬𝐚̃𝐨:* v${spell.version}`,
        `*𝐔𝐬𝐨:* ${compactUsage(spell)}`,
        '',
        section('◆', '𝗘𝗳𝗲𝗶𝘁𝗼'),
        '',
        formatBlock(spell.effect),
        '',
        section('◇', '𝗟𝗶𝗺𝗶𝘁𝗲𝘀'),
        '',
        formatBlock(spell.limits),
    ].join('\n');
}

function renderSpellCardTechnical(spell) {
    return [
        '*♧┃𝐅𝐄𝐈𝐓𝐈𝐂̧𝐎 · 𝐕𝐈𝐒𝐀̃𝐎 𝐓𝐄́𝐂𝐍𝐈𝐂𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  registro aprovado pelo ADM  ──',
        '',
        `*𝐍𝐨𝐦𝐞:* ${spell.name}`,
        `*𝐓𝐢𝐩𝐨:* ${spell.type}`,
        `*𝐕𝐞𝐫𝐬𝐚̃𝐨:* v${spell.version}`,
        `*𝐂𝐮𝐬𝐭𝐨:* ${spell.cost}`,
        `*𝐀𝐥𝐜𝐚𝐧𝐜𝐞:* ${spell.reach}`,
        `*𝐃𝐮𝐫𝐚𝐜̧𝐚̃𝐨:* ${spell.duration}`,
        '',
        section('◆', '𝗘𝗳𝗲𝗶𝘁𝗼'),
        '',
        formatBlock(spell.effect),
        '',
        section('◇', '𝗟𝗶𝗺𝗶𝘁𝗲𝘀'),
        '',
        formatBlock(spell.limits),
        '',
        section('■', '𝗡𝗼𝘁𝗮𝘀 𝗔𝗗𝗠'),
        '',
        formatBlock(spell.adm_notes),
    ].join('\n');
}

function renderSpellbookUsage(prefix = '.#') {
    return [
        '*♧┃𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Índice:* ${prefix}grimorio`,
        `*Outra página:* ${prefix}grimorio pagina 2`,
        `*Abrir:* ${prefix}feitico <número ou nome>`,
        '',
        `*Visão técnica:* ${prefix}feitico tecnico <número ou nome>`,
        '',
        '*ADM:*',
        `> ${prefix}addfeitico @player + ficha`,
        `> ${prefix}upfeitico @player + ficha`,
        `> ${prefix}removerfeitico @player Nome do Feitiço`,
    ].join('\n');
}

module.exports = {
    DEFAULT_PAGE_SIZE,
    paginateSpells,
    parsePageNumber,
    renderGrimoirePage,
    renderSpellCardPlayer,
    renderSpellCardTechnical,
    renderSpellbookUsage,
    selectSpellByIndex,
};