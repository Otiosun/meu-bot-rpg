const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');

function normalizeAction(value) {
    const text = normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
    if (['ativar', 'ativo', 'reativar', 'liberar'].includes(text)) return 'activate';
    if (['desativar', 'inativo', 'bloquear', 'pausar'].includes(text)) return 'deactivate';
    if (['status', 'ver', 'info'].includes(text)) return 'status';
    return '';
}

function inferActionFromCommand(command) {
    const text = normalizeText(command || '').replace(/[^a-z0-9]+/g, '');
    if (text.includes('ativarplayer') || text.includes('ativarjogador')) return 'activate';
    if (text.includes('desativarplayer') || text.includes('desativarjogador')) return 'deactivate';
    return '';
}

function splitAction(body, matchedCommand) {
    const inferred = inferActionFromCommand(matchedCommand);
    if (inferred) {
        return { action: inferred, rest: String(body || '').trim() };
    }

    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        action: normalizeAction(match?.[1] || ''),
        rest: String(match?.[2] || '').trim(),
    };
}

function renderUsage() {
    return [
        '*♧┃CONTROLE DE PLAYER 𖥔 CLOVER MULTICOLOR*',
        '     ── aliases legados sem mutação automática ──',
        '',
        '_`─( ✓ )───── Uso`_',
        '',
        `> ${COMMAND_PREFIX}ativarplayer @player motivo`,
        `> ${COMMAND_PREFIX}desativarplayer 1234 motivo`,
        `> ${COMMAND_PREFIX}player ativar personagem="Nome do Personagem" motivo="correção manual"`,
        `> ${COMMAND_PREFIX}player desativar tel=8599136380 motivo="pausa manual"`,
    ].join('\n');
}

function renderManualOnly(action) {
    return [
        '*♧┃CONTROLE DE PLAYER BLOQUEADO 𖥔 CLOVER MULTICOLOR*',
        '     ── nenhuma alteração foi executada ──',
        '',
        `A ação legada *${action === 'activate' ? 'ativar' : 'desativar'} player* está bloqueada.`,
        '> Ela misturava acesso, identidade e ciclo de vida sem uma operação canônica equivalente.',
        '> Use o fluxo administrativo específico depois de decidir se a intenção é acesso, archive ou reactivate.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}player`,
    aliases: [
        `${COMMAND_PREFIX}jogador`,
        `${COMMAND_PREFIX}ativarplayer`,
        `${COMMAND_PREFIX}ativarjogador`,
        `${COMMAND_PREFIX}desativarplayer`,
        `${COMMAND_PREFIX}desativarjogador`,
    ],
    descricao: 'Aliases legados de controle de player, mantidos sem mutação automática.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!isOwner(idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ativar ou desativar players manualmente.' });
            return;
        }

        const { action, rest } = splitAction(body, matchedCommand);
        if (!['activate', 'deactivate'].includes(action) || !rest) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: renderManualOnly(action),
        });
    },
};
