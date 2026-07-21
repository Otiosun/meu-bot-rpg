'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { runEconomyMutationExclusive } = require('../helpers/clover/economyMutationQueue');
const { getBoxDashboard } = require('../helpers/clover/boxService');

function renderBox(box) {
    return [
        `*${box.name}:* ${box.owned} disponível(is)`,
        ...box.rewards.map((reward) => `> ${String(reward.chance).replace('.', ',')}% · ${reward.label}`),
    ].join('\n');
}

function renderRelics(relicState) {
    const header = `*Relíquias da Temporada:* ${relicState.claimed}/${relicState.total} encontradas`;
    const lines = relicState.relics.map((relic) => relic.claimed
        ? `> ◈ ${relic.name} — *${relic.owner?.characterName || 'portador registrado'}*`
        : `> ◇ ${relic.name} — disponível`);
    return [header, ...lines].join('\n');
}

function renderDashboard(dashboard) {
    return [
        '*♧┃𝐂𝐀𝐈𝐗𝐀𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ── probabilidades e relíquias vivas ──',
        '',
        ...dashboard.boxes.flatMap((box, index) => [
            ...(index ? [''] : []),
            renderBox(box),
        ]),
        '',
        renderRelics(dashboard.relics),
        '',
        '*Regras:* cada abertura é independente, sem pity; a caixa é vinculada e consumida ao abrir.',
        '> Cada relíquia admite um único portador global. Quando todas forem encontradas, a chance rara é sorteada novamente entre os demais prêmios.',
        `*Abrir:* ${COMMAND_PREFIX}abrircaixa simples ou ${COMMAND_PREFIX}abrircaixa rara`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}caixas`,
    aliases: [`${COMMAND_PREFIX}caixa`, `${COMMAND_PREFIX}reliquias`, `${COMMAND_PREFIX}relíquias`],
    descricao: 'Mostra caixas, chances públicas e portadores das relíquias da temporada.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const dashboard = await runEconomyMutationExclusive(
            () => getBoxDashboard(db, idJogador),
            { operation: 'bot:box-dashboard' }
        );
        await sendReply({ sock, idChat, m, text: renderDashboard(dashboard) });
    },
    renderDashboard,
    renderRelics,
};
