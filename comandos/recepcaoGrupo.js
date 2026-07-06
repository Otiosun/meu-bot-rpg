const { COMMAND_PREFIX } = require('../config/bot');
const { sendReaction, sendReply } = require('../helpers/chatReply');
const {
    getGroupReceptionConfig,
    normalizeGroupReceptionType,
    setGroupReception,
} = require('../helpers/groupAccess');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');
const { isConfiguredCloverGroup } = require('../helpers/clover/groupManager');
const { normalizeText } = require('../helpers/textUtils');

function compact(value) {
    return normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
}

function resolveAction(matchedCommand, body) {
    const text = compact(`${matchedCommand || ''} ${body || ''}`);
    if (text.includes('status') || text.includes('ver')) return 'status';
    if (text.includes('desativar') || text.includes('desligar') || text.includes('pausar')) return 'disable';
    if (text.includes('ativar') || text.includes('ligar')) return 'enable';
    return 'status';
}

function resolveReceptionType(matchedCommand, body) {
    const text = compact(`${matchedCommand || ''} ${body || ''}`);
    if (text.includes('off')) return 'off';
    return 'reception';
}

function typeLabel(type) {
    const normalizedType = normalizeGroupReceptionType(type);
    if (normalizedType === 'off') return 'grupo OFF';
    if (normalizedType === 'reception') return 'grupo de recepcao';
    return 'nenhum';
}

function renderStatus(config, isOffGroup) {
    return [
        '♧┃RECEPCAO DO GRUPO 𖥔 CLOVER MULTICOLOR',
        '     ── boas-vindas separadas do bot ativo ──',
        '',
        '_`─( ✓ )───── Status`_',
        '',
        `*Recepcao:* ${config.enabled ? 'ativada' : 'desativada'}`,
        `*Tipo:* ${config.enabled ? typeLabel(config.type) : 'nenhum'}`,
        `*Este grupo e OFF configurado:* ${isOffGroup ? 'sim' : 'nao'}`,
        '',
        '_`─( ■ )───── Comandos`_',
        '',
        `*Recepcao normal:* ${COMMAND_PREFIX}recepcao ativar / desativar`,
        `*Recepcao OFF:* ${COMMAND_PREFIX}recepcao off ativar / desativar`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}recepcao`,
    aliases: [
        `${COMMAND_PREFIX}recepcao`,
        `${COMMAND_PREFIX}boasvindas`,
        `${COMMAND_PREFIX}ativarrecepcao`,
        `${COMMAND_PREFIX}desativarrecepcao`,
        `${COMMAND_PREFIX}statusrecepcao`,
        `${COMMAND_PREFIX}recepcaooff`,
        `${COMMAND_PREFIX}ativarrecepcaooff`,
        `${COMMAND_PREFIX}desativarrecepcaooff`,
        `${COMMAND_PREFIX}statusrecepcaooff`,
    ],
    descricao: 'Ativa ou desativa a recepcao automatica neste grupo.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!idChat?.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Esse comando so pode ser usado dentro de um grupo.*',
            });
            return;
        }

        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Apenas ADM do grupo ou Owner pode mexer na recepcao.*',
            });
            return;
        }

        const action = resolveAction(matchedCommand, body);
        const type = resolveReceptionType(matchedCommand, body);
        const isOffGroup = await isConfiguredCloverGroup(db, 'off', idChat);

        if (action === 'status') {
            const config = await getGroupReceptionConfig(db, idChat);
            await sendReply({ sock, idChat, m, text: renderStatus(config, isOffGroup) });
            return;
        }

        if (type === 'off' && !isOffGroup) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Esse grupo nao e o grupo OFF configurado.*',
                    '',
                    `Use *${COMMAND_PREFIX}setgrupooff* no grupo OFF primeiro, depois use *${COMMAND_PREFIX}recepcao off ativar* la.`,
                ].join('\n'),
            });
            return;
        }

        if (type === 'reception' && isOffGroup && action === 'enable') {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Esse grupo e o OFF configurado.*',
                    '',
                    `Para ligar a mensagem certa dele, use *${COMMAND_PREFIX}recepcao off ativar*.`,
                ].join('\n'),
            });
            return;
        }

        await setGroupReception(db, idChat, type, action === 'enable');
        await sendReaction({
            sock,
            idChat,
            m,
            emoji: action === 'enable' ? '✅' : '☑️',
        });

        const config = await getGroupReceptionConfig(db, idChat);
        await sendReply({ sock, idChat, m, text: renderStatus(config, isOffGroup) });
    },
};
