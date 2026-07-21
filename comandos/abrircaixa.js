'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { runEconomyMutationExclusive } = require('../helpers/clover/economyMutationQueue');
const { BoxServiceError, openBox } = require('../helpers/clover/boxService');

function renderReward(opening) {
    const reward = opening.reward || {};
    let result = 'Recompensa entregue ao inventário.';
    if (reward.type === 'yulls') result = `+${Number(reward.amount).toLocaleString('pt-BR')}¥`;
    else if (reward.type === 'ph') result = `+${reward.amount} PH fora do teto semanal`;
    else if (reward.type === 'title') result = reward.newlyUnlocked
        ? `Título desbloqueado: ${reward.itemName}`
        : `Título já possuído: +${Number(reward.compensationYulls || 0).toLocaleString('pt-BR')}¥ de compensação`;
    else if (reward.type === 'relic') result = `◈ Relíquia exclusiva: ${reward.itemName}`;
    else if (reward.itemName) result = `${reward.itemName} x${reward.quantity || 1}`;

    return [
        reward.type === 'relic'
            ? '*♧┃𝐑𝐄𝐋Í𝐐𝐔𝐈𝐀 𝐃𝐄𝐒𝐏𝐄𝐑𝐓𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*'
            : '*♧┃𝐂𝐀𝐈𝐗𝐀 𝐀𝐁𝐄𝐑𝐓𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Caixa:* ${opening.boxKey === 'rara' ? 'Caixa Rara' : 'Caixa Simples'}`,
        `*Resultado:* ${result}`,
        ...(reward.rerolledFrom ? ['', '> O prêmio de relíquia estava esgotado e foi sorteado novamente entre os demais resultados.'] : []),
        ...(reward.type === 'relic' ? ['', '> Esta relíquia saiu permanentemente do pool global. Você é o único portador registrado.'] : []),
        '',
        '> A caixa foi consumida e a recompensa já foi registrada.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}abrircaixa`,
    aliases: [`${COMMAND_PREFIX}abrir caixa`],
    descricao: 'Abre uma Caixa Simples ou Rara da temporada.',
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
            const opening = await runEconomyMutationExclusive(
                () => openBox(db, idJogador, boxKey, {
                    idempotencyKey: `box:${idChat}:${messageId}`,
                    source: 'bot',
                }),
                { operation: `bot:open-box:${boxKey}` }
            );
            await sendReply({ sock, idChat, m, text: renderReward(opening) });
        } catch (error) {
            if (error instanceof BoxServiceError || ['InventoryServiceError', 'YullsServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
    renderReward,
};
