const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');
const {
    addRewardListEntry,
    createRewardList,
    getResolvedRewardListTargets,
    listRewardEntries,
    parseAddArgs,
    parseImportBlock,
    renderEntryLine,
    renderResolutionProblem,
    resolveRewardList,
} = require('../helpers/clover/rewardListService');

function compact(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/);
    return {
        action: compact(match?.[1] || ''),
        slug: String(match?.[2] || '').trim(),
        rest: String(match?.[3] || '').trim(),
    };
}

function normalizeAction(action) {
    if (['criar', 'create', 'nova', 'novo'].includes(action)) return 'create';
    if (['add', 'adicionar', 'colocar'].includes(action)) return 'add';
    if (['importar', 'import'].includes(action)) return 'import';
    if (['ver', 'status', 'mostrar'].includes(action)) return 'view';
    if (['resolver', 'resolve'].includes(action)) return 'resolve';
    return null;
}

function renderHelp() {
    return [
        '*♧┃LISTAS DE RECOMPENSA 𖥔 CLOVER MULTICOLOR*',
        '     ── alvos privados e canônicos ──',
        '',
        '_`─( ✓ )───── Comandos`_',
        '',
        `*${COMMAND_PREFIX}lista criar copa-30-bonus*`,
        `*${COMMAND_PREFIX}lista add copa-30-bonus tel=21975832436 personagem="Masaki"*`,
        `*${COMMAND_PREFIX}lista importar copa-30-bonus*`,
        '> Nome | telefone',
        '> FIM',
        `*${COMMAND_PREFIX}lista ver copa-30-bonus*`,
        `*${COMMAND_PREFIX}lista resolver copa-30-bonus*`,
    ].join('\n');
}

function renderSimple(title, lines = []) {
    return [
        `*♧┃${title} 𖥔 CLOVER MULTICOLOR*`,
        '',
        ...lines.filter(Boolean),
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}lista`,
    aliases: [
        `${COMMAND_PREFIX}listas`,
        `${COMMAND_PREFIX}listarecompensa`,
        `${COMMAND_PREFIX}alvos`,
    ],
    descricao: 'Cria listas privadas de alvos canônicos para recompensas.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar listas de recompensa.' });
            return;
        }

        const { action: rawAction, slug, rest } = splitAction(body);
        const action = normalizeAction(rawAction);
        if (!action || !slug) {
            await sendReply({ sock, idChat, m, text: renderHelp() });
            return;
        }

        if (action === 'create') {
            const result = await createRewardList(db, slug, { createdBy: idJogador });
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok
                    ? renderSimple('LISTA CRIADA', [`*Lista:* ${result.list.slug}`, '> Agora adicione ou importe alvos.'])
                    : renderSimple('LISTA RECUSADA', [`> ${result.error}`]),
            });
            return;
        }

        if (action === 'add') {
            const result = await addRewardListEntry(db, slug, parseAddArgs(rest), { createdBy: idJogador });
            await sendReply({
                sock,
                idChat,
                m,
                text: renderSimple(result.ok ? 'ALVO ADICIONADO' : 'ALVO PENDENTE', [
                    `*Lista:* ${result.list?.slug || slug}`,
                    result.entry?.playerId ? `*Player ID:* ${result.entry.playerId}` : null,
                    result.entry?.playerName ? `*Personagem:* ${result.entry.playerName}` : null,
                    result.entry?.error ? `> ${result.entry.error}` : null,
                    !result.ok ? '> Use .#lista resolver para revisar antes de recompensar.' : null,
                ]),
            });
            return;
        }

        if (action === 'import') {
            const entries = parseImportBlock(rest);
            if (!entries.length) {
                await sendReply({ sock, idChat, m, text: renderHelp() });
                return;
            }
            const results = [];
            for (const entry of entries) {
                results.push(await addRewardListEntry(db, slug, entry, { createdBy: idJogador }));
            }
            const ok = results.filter((item) => item.ok).length;
            await sendReply({
                sock,
                idChat,
                m,
                text: renderSimple('LISTA IMPORTADA', [
                    `*Lista:* ${slug}`,
                    `*Resolvidos:* ${ok}/${results.length}`,
                    ok < results.length ? '> Alguns alvos ficaram pendentes. Use resolver/ver.' : '> Tudo resolvido para player_id canônico.',
                ]),
            });
            return;
        }

        if (action === 'view') {
            const view = await listRewardEntries(db, slug);
            if (!view.ok) {
                await sendReply({ sock, idChat, m, text: renderSimple('LISTA', [`> ${view.error}`]) });
                return;
            }
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃LISTA DE RECOMPENSA 𖥔 CLOVER MULTICOLOR*',
                    '     ── alvos salvos ──',
                    '',
                    `*Lista:* ${view.list.slug}`,
                    `*Entradas:* ${view.entries.length}`,
                    '',
                    '_`─( ◆ )───── Alvos`_',
                    '',
                    ...(view.entries.length ? view.entries.slice(0, 30).map(renderEntryLine) : ['> vazia.']),
                ].join('\n'),
            });
            return;
        }

        if (action === 'resolve') {
            const resolved = await resolveRewardList(db, slug);
            if (!resolved.ok) {
                await sendReply({ sock, idChat, m, text: renderSimple('LISTA', [`> ${resolved.error}`]) });
                return;
            }
            const ready = await getResolvedRewardListTargets(db, slug);
            const problems = resolved.entries.filter((entry) => entry.status !== 'resolved' || !entry.player_id);
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃LISTA RESOLVIDA 𖥔 CLOVER MULTICOLOR*',
                    '     ── conferência de identidade ──',
                    '',
                    `*Lista:* ${resolved.list.slug}`,
                    `*Canônicos:* ${ready.ok ? ready.playerIds.length : 0}`,
                    `*Pendentes:* ${problems.length}`,
                    problems.length ? '' : null,
                    problems.length ? '_`─( ! )───── Pendências`_' : null,
                    problems.length ? '' : null,
                    ...problems.slice(0, 8).map(renderResolutionProblem),
                    problems.length > 8 ? `> ...e mais ${problems.length - 8} pendência(s).` : null,
                ].filter(Boolean).join('\n'),
            });
        }
    },
};
