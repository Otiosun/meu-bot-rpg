const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    formatMention,
    mergePlayerIdentity,
    playerDisplayName,
} = require('../helpers/clover/commandTargetUtils');

function parseKv(text) {
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

function renderUsage() {
    return [
        '*♧┃MESCLAR PLAYER 𖥔 CLOVER MULTICOLOR*',
        '     ── corrigir cadastro espelho ──',
        '',
        '_`─( ✓ )───── Uso`_',
        '',
        `> ${COMMAND_PREFIX}mesclarplayer origem=558599136380@s.whatsapp.net destino=65902615761026@lid motivo="Cadastro espelho"`,
        '',
        '> A origem vira sombra e todo alias dela passa a apontar para o destino canônico.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}mesclarplayer`,
    aliases: [
        `${COMMAND_PREFIX}mesclar`,
        `${COMMAND_PREFIX}mergeplayer`,
        `${COMMAND_PREFIX}unirplayer`,
    ],
    descricao: 'Mescla cadastro espelho em um player canônico.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!isOwner(idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas Owner pode mesclar cadastros.' });
            return;
        }

        const kv = parseKv(body);
        const origin = kv.origem || kv.origin || kv.de || '';
        const destination = kv.destino || kv.destination || kv.para || '';
        const reason = kv.motivo || kv.reason || '';
        if (!origin || !destination) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        try {
            const result = await mergePlayerIdentity(db, {
                origin,
                destination,
                reason,
                actorId: idJogador,
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [result.destination.id],
                text: [
                    '*♧┃PLAYER MESCLADO 𖥔 CLOVER MULTICOLOR*',
                    '     ── identidade canônica atualizada ──',
                    '',
                    '_`─( ✓ )───── Resultado`_',
                    '',
                    `*Origem:* ${playerDisplayName(result.origin, result.origin.id)} (${result.origin.id})`,
                    `*Destino:* ${playerDisplayName(result.destination, result.destination.id)} (${formatMention(result.destination.id)})`,
                    `*Aliases movidos/criados:* ${result.movedAliases}`,
                    result.same ? '> Origem e destino já eram o mesmo cadastro.' : '> A origem agora é cadastro sombra.',
                    '',
                    '_`─( ◆ )───── Segurança`_',
                    '',
                    '> Histórico econômico não foi somado automaticamente, para evitar duplicidade.',
                    '> Recompensas futuras na origem redirecionam para o destino.',
                ].join('\n'),
            });
        } catch (error) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃MESCLAGEM RECUSADA 𖥔 CLOVER MULTICOLOR*',
                    '',
                    `> ${error?.message || String(error)}`,
                ].join('\n'),
            });
        }
    },
};
