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
    const phoneHint = result.phoneLast4
        ? `Use seu numero no site. Se ele pedir final, o seu final reconhecido e ${result.phoneLast4}.`
        : 'Nao consegui reconhecer o numero vinculado. Se o login falhar, chame a ADM para revisar seu cadastro.';

    return [
        '♧┃LOGIN DO SITE 𖥔 Clover Multicolor',
        '',
        `*Personagem:* ${playerName(result.player)}`,
        `*Codigo:* ${result.code}`,
        `*Validade:* ${result.ttlMinutes} minutos`,
        '',
        phoneHint,
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
    descricao: 'Gera codigo temporario para login no site Clover.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (String(idChat || '').endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Por seguranca, chama o bot no PV e usa *.#site* por la. Assim seu codigo nao fica exposto no grupo.',
            });
            return;
        }

        const result = await createSiteLoginCode(db, idJogador);
        if (!result.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Nao encontrei seu personagem no banco para gerar login do site.',
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: renderCodeMessage(result),
        });
    },
};
