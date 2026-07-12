const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const { diagnoseDatabaseIntegrity } = require('../helpers/clover/databaseIntegrityService');

const SECTION_LABELS = {
    players: 'Players e status',
    identity: 'Identidade e duplicidades',
    aliases: 'Aliases e vínculos',
    queue: 'Fila de feitiços',
    orphan_records: 'Registros órfãos',
    squads: 'Esquadrões',
    community: 'Comunidade',
};

const SECTION_ALIASES = {
    player: 'players',
    players: 'players',
    jogador: 'players',
    jogadores: 'players',
    status: 'players',
    identidade: 'identity',
    identity: 'identity',
    duplicidade: 'identity',
    duplicidades: 'identity',
    alias: 'aliases',
    aliases: 'aliases',
    vinculo: 'aliases',
    vinculos: 'aliases',
    fila: 'queue',
    queue: 'queue',
    orfao: 'orphan_records',
    orfaos: 'orphan_records',
    registros: 'orphan_records',
    esquadrao: 'squads',
    esquadroes: 'squads',
    squad: 'squads',
    comunidade: 'community',
    community: 'community',
};

function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function parseOptions(body) {
    const text = String(body || '').trim();
    const normalized = normalizeText(text);
    const complete = /(^|\s)(completo|detalhes|detalhado)(\s|$)/i.test(normalized);
    const sectionMatch = text.match(/(?:secao|seção)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
    const looseSection = !sectionMatch
        ? normalized.split(/\s+/).map(compact).find((token) => SECTION_ALIASES[token])
        : null;
    const rawSection = sectionMatch?.[1] || sectionMatch?.[2] || sectionMatch?.[3] || looseSection || '';
    const section = SECTION_ALIASES[compact(rawSection)] || null;

    return {
        complete,
        section,
        sampleLimit: complete ? 12 : 5,
        renderLimit: complete ? 10 : 3,
    };
}

function severityIcon(severity) {
    if (severity === 'critical') return '!';
    if (severity === 'warning') return '△';
    return '·';
}

function renderIssue(issue) {
    const suffix = issue.count > 1 ? ` (${issue.count} registros)` : '';
    const samples = issue.data?.samples?.length
        ? `\n  Amostras: ${issue.data.samples.map((item) => `${item.playerId}×${item.count}`).join(' | ')}`
        : '';
    return `> ${severityIcon(issue.severity)} ${issue.message}${suffix}${samples}`;
}

function renderSection(section, issues, limit) {
    const label = SECTION_LABELS[section] || section;
    const visible = issues.slice(0, limit);
    const hidden = Math.max(0, issues.length - visible.length);

    return [
        `_\`─( ◆ )───── ${label}\`_`,
        '',
        ...visible.map(renderIssue),
        hidden ? `> ...e mais ${hidden} problema(s) nesta seção.` : null,
    ].filter(Boolean);
}

function renderHelp() {
    return [
        '♧┃INTEGRIDADE DO BANCO 𖥔 CLOVER MULTICOLOR',
        '     ── diagnóstico somente leitura ──',
        '',
        `> ${COMMAND_PREFIX}diagnosticarbanco`,
        `> ${COMMAND_PREFIX}diagnosticarbanco completo`,
        `> ${COMMAND_PREFIX}diagnosticarbanco secao=identidade`,
        `> ${COMMAND_PREFIX}diagnosticarbanco secao=fila`,
        '',
        'Seções: players, identidade, aliases, fila, órfãos, esquadrões e comunidade.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}diagnosticarbanco`,
    aliases: [
        `${COMMAND_PREFIX}integridade`,
        `${COMMAND_PREFIX}integridadebanco`,
        `${COMMAND_PREFIX}diagnosticobanco`,
        `${COMMAND_PREFIX}diagnósticobanco`,
    ],
    descricao: 'Owner: gera relatório somente leitura sobre inconsistências do banco Clover.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!isOwner(idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode consultar a integridade completa do banco.' });
            return;
        }

        const options = parseOptions(body);
        if (compact(body) === 'ajuda' || compact(body) === 'help') {
            await sendReply({ sock, idChat, m, text: renderHelp() });
            return;
        }

        const report = await diagnoseDatabaseIntegrity(db, { sampleLimit: options.sampleLimit });
        const selectedIssues = options.section
            ? report.issues.filter((issue) => issue.section === options.section)
            : report.issues;
        const sections = options.section
            ? [options.section]
            : Object.keys(SECTION_LABELS).filter((section) => selectedIssues.some((issue) => issue.section === section));

        const bodyLines = [];
        for (const section of sections) {
            const issues = selectedIssues.filter((issue) => issue.section === section);
            if (!issues.length) continue;
            if (bodyLines.length) bodyLines.push('');
            bodyLines.push(...renderSection(section, issues, options.renderLimit));
        }

        const sectionSummary = options.section
            ? report.summary.bySection[options.section] || { total: 0, critical: 0, warning: 0 }
            : report.summary;

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '♧┃INTEGRIDADE DO BANCO 𖥔 CLOVER MULTICOLOR',
                '     ── nenhuma alteração foi aplicada ──',
                '',
                `*Players lidos:* ${report.players}`,
                `*Tabelas lidas:* ${report.tables}`,
                options.section ? `*Seção:* ${SECTION_LABELS[options.section] || options.section}` : null,
                `*Problemas:* ${sectionSummary.total || 0}`,
                `*Críticos:* ${sectionSummary.critical || 0}`,
                `*Avisos:* ${sectionSummary.warning || 0}`,
                '',
                bodyLines.length ? bodyLines.join('\n') : '> Nenhum problema encontrado neste recorte.',
                '',
                '_`─( ✓ )───── Segurança`_',
                '',
                '> Relatório somente leitura.',
                '> Nenhuma linha foi corrigida, removida ou atualizada.',
                options.complete ? null : `> Para mais amostras: *${COMMAND_PREFIX}diagnosticarbanco completo*`,
            ].filter(Boolean).join('\n'),
        });
    },
};
