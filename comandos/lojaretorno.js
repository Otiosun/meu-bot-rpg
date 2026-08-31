'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    createReturnShopLoginCode,
} = require('../helpers/clover/returnPointShopAuthService');
const { ReturnPointShopGateError } = require('../helpers/clover/returnPointShopGateService');
const { getPublicSiteUrl } = require('../helpers/clover/sitePublicUrl');

function playerName(player = {}) {
    const name = String(player.personagem_nome || player.nome || player.display_name || '').trim();
    return name && name !== '-' ? name : 'seu personagem';
}

function returnShopUrl() {
    return String(process.env.CLOVER_RETURN_SHOP_PUBLIC_URL || '').trim() || getPublicSiteUrl();
}

function renderCodeMessage(result) {
    return [
        '♧┃LOGIN DA LOJA DE RETORNO',
        '',
        `*Personagem:* ${playerName(result.player)}`,
        `*Código:* ${result.code}`,
        `*Validade:* ${result.ttlMinutes} minutos`,
        '',
        'Use no login exclusivo da Loja de Retorno com o número completo deste WhatsApp (DDI + DDD).',
        'Esse código funciona uma única vez. O acesso gerado só vale para a Loja de Retorno.',
        '',
        returnShopUrl(),
    ].join('\n');
}

function errorMessage(error, result) {
    const code = error?.code || result?.reason;
    if (code === 'return_shop_closed') return 'A Loja de Retorno ainda não foi liberada.';
    if (code === 'return_shop_not_eligible') return 'Seu cadastro não está no grupo autorizado para a Loja de Retorno.';
    if (code === 'missing_phone') return 'Não consegui reconhecer o número vinculado ao seu cadastro. Chame a ADM para revisar seu registro.';
    if (code === 'missing_player') return 'Não encontrei seu cadastro no banco para gerar acesso à Loja de Retorno.';
    return 'Não consegui gerar seu acesso à Loja de Retorno agora. Tente novamente ou chame a ADM.';
}

module.exports = {
    nome: `${COMMAND_PREFIX}lojaretorno`,
    aliases: [
        `${COMMAND_PREFIX}loja`,
        `${COMMAND_PREFIX}shopretorno`,
        `${COMMAND_PREFIX}loja retorno`,
    ],
    descricao: 'Gera código temporário e exclusivo para a Loja de Retorno.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (String(idChat || '').endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Por segurança, chama o bot no PV e usa *.#loja*. O código de acesso não deve aparecer no grupo.',
            });
            return;
        }

        try {
            const result = await createReturnShopLoginCode(db, idJogador);
            if (!result.ok) {
                await sendReply({ sock, idChat, m, text:errorMessage(null, result) });
                return;
            }
            await sendReply({ sock, idChat, m, text:renderCodeMessage(result) });
        } catch (error) {
            if (error instanceof ReturnPointShopGateError || error?.code) {
                await sendReply({ sock, idChat, m, text:errorMessage(error) });
                return;
            }
            throw error;
        }
    },
    renderCodeMessage,
    returnShopUrl,
};
