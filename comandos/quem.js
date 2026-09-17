const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    canManagePlayer,
    describeTargetSource,
    findPlayersByIdentifier,
    formatMention,
    getQuotedParticipant,
    listPlayerTargetAliases,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');


function parseKeyValues(text) {
    const kv = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = String(match[1] || '').toLowerCase().trim();
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) kv[key] = value;
    }
    return kv;
}

function renderCandidates(candidates, limit = 3) {
    if (!candidates?.length) return '> nenhum candidato provável.';

    return candidates.slice(0, limit).map((item) => {
        const player = item.player || {};
        return [
            `> ${playerDisplayName(player, player.id || '-')}`,
            `  - ${player.id || '-'}`,
            `  - fonte: ${describeTargetSource(item.source)}`,
        ].join('\n');
    }).join('\n');
}

function renderAliases(aliases) {
    if (!aliases?.length) return ['> sem aliases vinculados.'];

    return aliases.slice(0, 6).map((alias) => {
        const key = String(alias.alias_key || '').replace(/^jid:/, '@').replace(/^phone:/, '');
        return `> ${alias.alias_label || key}  [${alias.alias_kind || 'manual'}]`;
    });
}

module.exports = {
    nome: `${COMMAND_PREFIX}quem`,
    aliases: [
        `${COMMAND_PREFIX}diagnostico`,
        `${COMMAND_PREFIX}diagnóstico`,
        `${COMMAND_PREFIX}resolve`,
    ],
    descricao: 'Mostra como o bot está resolvendo um alvo e quais vínculos ele enxergou.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar esse comando.' });
            return;
        }

        const { targetId, targetText } = resolveTargetAndRest(body, m);
        const resolved = await resolveTargetPlayer(db, targetId, targetText, {
            quotedParticipant: getQuotedParticipant(m),
        });

        if (!resolved.ok) {
            const query = String(targetText || targetId || '').trim();
            const candidates = query ? await findPlayersByIdentifier(db, query) : [];
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃QUEM 𖥔 CLOVER MULTICOLOR*',
                    '     ── diagnóstico de alvo ──',
                    '',
                    '_`─( ! )───── Resultado`_',
                    '',
                    `> ${resolved.error || 'Alvo não encontrado.'}`,
                    '',
                    '_`─( ◆ )───── Candidatos`_',
                    '',
                    renderCandidates(candidates),
                ].join('\n'),
            });
            return;
        }

        const player = resolved.player;
        const rawPlayer = resolved.rawPlayer || player;
        const redirectedFrom = resolved.redirectedFrom || (rawPlayer.id !== player.id ? rawPlayer.id : null);
        const redirectReason = resolved.redirectReason || (redirectedFrom ? 'merged_shadow' : null);
        const originalSource = resolved.originalSource || resolved.source;
        const aliases = await listPlayerTargetAliases(db, player.id);
        const fallback = formatMention(player.id);

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [player.id],
            text: [
                '*♧┃QUEM 𖥔 CLOVER MULTICOLOR*',
                '     ── diagnóstico de cadastro ──',
                '',
                '_`─( ✓ )───── Alvo`_',
                '',
                `*Entrada:* ${targetText || targetId || fallback}`,
                `*Fonte:* ${describeTargetSource(resolved.source)}`,
                originalSource && originalSource !== resolved.source ? `*Fonte original:* ${describeTargetSource(originalSource)}` : null,
                redirectedFrom ? `*Redirecionou:* ${redirectedFrom} -> ${player.id}` : null,
                redirectReason ? `*Motivo:* ${redirectReason}` : null,
                '',
                '_`─( ◆ )───── Cadastro encontrado`_',
                '',
                `*Player ID:* ${rawPlayer.id || '-'}`,
                `*Sombra:* ${rawPlayer.is_shadow ? 'sim' : 'não'}`,
                `*Mesclado em:* ${rawPlayer.merged_into || '-'}`,
                `*Personagem:* ${rawPlayer.personagem_nome || '-'}`,
                `*Nome:* ${rawPlayer.nome || rawPlayer.display_name || '-'}`,
                '',
                '_`─( ◆ )───── Registro`_',
                '',
                `*Player ID:* ${player.id || '-'}`,
                `*Canônico:* ${resolved.canonicalPlayerId || player.id || '-'}`,
                `*Sombra:* ${player.is_shadow ? 'sim' : 'não'}`,
                `*Mesclado em:* ${player.merged_into || '-'}`,
                `*Personagem:* ${player.personagem_nome || '-'}`,
                `*Nome:* ${player.nome || player.display_name || '-'}`,
                `*Vínculo principal:* ${fallback}`,
                `*Aliases vinculados:* ${aliases.length}`,
                '',
                '_`─( ◇ )───── Aliases`_',
                '',
                ...renderAliases(aliases),
            ].join('\n'),
        });
    },
};
