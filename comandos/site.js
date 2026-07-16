'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { createSiteLoginCode } = require('../helpers/clover/siteAuthService');

function playerName(player = {}) {
    const name = String(player.personagem_nome || player.nome || player.display_name || '').trim();
    return name && name !== '-' ? name : 'seu personagem';
}

function siteUrl() {
    return process.env.CLOVER_SITE_PUBLIC_URL || 'https://black-clover-multicolor.lovable.app/';
}

function renderCodeMessage(result) {
    return [
        '♧┃LOGIN DO SITE 𖥔 Clover Multicolor',
        '',
        `*Personagem:* ${playerName(result.player)}`,
        `*Código:* ${result.code}`,
        `*Validade:* ${result.ttlMinutes} minutos`,
        '',
        'No site, informe o número completo deste WhatsApp, com DDI e DDD.',
        'O código funciona uma única vez e uma nova entrada encerra a sessão anterior.',
        '',
        siteUrl(),
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}site`,
    aliases: [
        `${COMMAND_PREFIX}login`,
        `${COMMAND_PREFIX}loginsite`,
        `${COMMAND_PREFIX}codigosite`,
        `${COMMAND_PREFIX}codigo site`,
    ],
    descricao: 'Gera código temporário para login no site Clover.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (String(idChat || '').endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Por segurança, chama o bot no PV e usa *.#site* por lá. Assim seu código não fica exposto no grupo.',
            });
            return;
        }

        const result = await createSiteLoginCode(db, idJogador);
        if (!result.ok) {
            const text = result.reason === 'missing_phone'
                ? 'Não consegui reconhecer o número vinculado ao seu cadastro. Chame a ADM para revisar seu registro antes de entrar no site.'
                : 'Não encontrei seu personagem no banco para gerar login do site.';
            await sendReply({ sock, idChat, m, text });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: renderCodeMessage(result),
        });
    },
    renderCodeMessage,
};
