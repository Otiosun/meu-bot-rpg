'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getBoxDashboard } = require('../helpers/clover/boxService');

function renderBox(box) {
    return [
        `*${box.name}:* ${box.owned} disponível(is)`,
        ...box.rewards.map((reward) => `> ${reward.chance}% · ${reward.label}`),
    ].join('\n');
}

function renderDashboard(dashboard) {
    return [
        '*♧┃𝐂𝐀𝐈𝐗𝐀𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ── probabilidades públicas ──',
        '',
        ...dashboard.boxes.flatMap((box, index) => [
            ...(index ? [''] : []),
            renderBox(box),
        ]),
        '',
        '*Regras:* cada abertura é independente, sem pity; a caixa é vinculada e consumida ao abrir.',
        `*Abrir:* ${COMMAND_PREFIX}abrircaixa simples ou ${COMMAND_PREFIX}abrircaixa rara`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}caixas`,
    aliases: [`${COMMAND_PREFIX}caixa`],
    descricao: 'Mostra suas caixas e as chances públicas.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderDashboard(await getBoxDashboard(db, idJogador)),
        });
    },
    renderDashboard,
};
