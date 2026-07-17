'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { BoxServiceError, openBox } = require('../helpers/clover/boxService');

function renderReward(opening) {
    const reward = opening.reward || {};
    let result = 'Recompensa entregue ao inventário.';
    if (reward.type === 'yulls') result = `+${Number(reward.amount).toLocaleString('pt-BR')}¥`;
    else if (reward.type === 'ph') result = `+${reward.amount} PH fora do teto semanal`;
    else if (reward.type === 'title') result = reward.newlyUnlocked
        ? `Título desbloqueado: ${reward.itemName}`
        : `Título recebido novamente: ${reward.itemName}`;
    else if (reward.itemName) result = `${reward.itemName} x${reward.quantity || 1}`;

    return [
        '*♧┃𝐂𝐀𝐈𝐗𝐀 𝐀𝐁𝐄𝐑𝐓𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Caixa:* ${opening.boxKey === 'rara' ? 'Caixa Rara' : 'Caixa Simples'}`,
        `*Resultado:* ${result}`,
        '',
        '> A caixa foi consumida e a recompensa já foi registrada.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}abrircaixa`,
    aliases: [`${COMMAND_PREFIX}abrir caixa`],
    descricao: 'Abre uma Caixa Simples ou Rara da Economia V1.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const boxKey = String(body || '').trim().toLowerCase();
        if (!['simples', 'rara'].includes(boxKey)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `Use *${COMMAND_PREFIX}abrircaixa simples* ou *${COMMAND_PREFIX}abrircaixa rara*.`,
            });
            return;
        }
        try {
            const messageId = m?.key?.id || `${Date.now()}`;
            const opening = await openBox(db, idJogador, boxKey, {
                idempotencyKey: `box:${idChat}:${messageId}`,
                source: 'bot',
            });
            await sendReply({ sock, idChat, m, text: renderReward(opening) });
        } catch (error) {
            if (error instanceof BoxServiceError && error.code === 'box_not_owned') {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
    renderReward,
};
