const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    canManagePlayer,
    formatMention,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { removePlayerForAntiGhost } = require('../helpers/clover/antiGhostService');

async function resolveTarget({ db, body, m }) {
    const targetData = resolveTargetAndRest(body, m);
    if (targetData.source === 'none') {
        return { ok: false, error: 'Informe o player que será removido.' };
    }
    const resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText);
    return { ...resolved, rest: targetData.rest || '' };
}

function renderResult(target, result) {
    if (!result.ok) {
        return [
            '*♧┃ANTI-GHOST RECUSADO 𖥔 CLOVER MULTICOLOR*',
            '     ── nada destrutivo foi executado ──',
            '',
            `*Player:* ${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`,
            `> ${result.error || 'Não consegui concluir o arquivamento.'}`,
        ].join('\n');
    }

    return [
        '*♧┃ANTI-GHOST 𖥔 CLOVER MULTICOLOR*',
        '     ── player arquivado com segurança ──',
        '',
        `*Player:* ${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`,
        `*Evento de ciclo:* ${result.lifecycleCode || '-'}`,
        `*Comunidade:* ${result.community?.ok ? 'removido' : `não confirmado: ${result.community?.reason || 'grupo ausente'}`}`,
        '*Dados preservados:* sim',
        '',
        '> Cadastro, personagem, PH, inventário, grimório e histórico não foram apagados.',
        '> O player pode ser reativado depois pelo fluxo protegido.',
        result.warnings?.length ? '' : null,
        result.warnings?.length ? '_`─( ! )───── Avisos externos`_' : null,
        ...(result.warnings || []).map((warning) => `> ${warning}`),
    ].filter(Boolean).join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}antighost remover`,
    aliases: [
        `${COMMAND_PREFIX}anti remover`,
        `${COMMAND_PREFIX}ghost remover`,
        `${COMMAND_PREFIX}antighost removermanual`,
        `${COMMAND_PREFIX}anti removermanual`,
        `${COMMAND_PREFIX}antighost banir`,
        `${COMMAND_PREFIX}anti banir`,
        `${COMMAND_PREFIX}antighost apagar`,
        `${COMMAND_PREFIX}anti apagar`,
    ],
    descricao: 'Arquiva player do anti-ghost sem apagar cadastro ou progresso.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar esse comando.' });
            return;
        }

        const target = await resolveTarget({ db, body, m });
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error || 'Player não encontrado.' });
            return;
        }

        const result = await removePlayerForAntiGhost({
            sock,
            db,
            player: target.player,
            moderatorId: idJogador,
            reason: target.rest || 'remoção manual anti-ghost',
        });

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [target.player.id],
            text: renderResult(target, result),
        });
    },
};
