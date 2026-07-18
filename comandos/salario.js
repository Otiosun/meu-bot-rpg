'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getSalaryDashboard } = require('../helpers/clover/economyService');

function statusLine(entry) {
    if (entry.paid) return `Pago · ${Number(entry.amount).toLocaleString('pt-BR')}¥`;
    if (entry.eligible) return `Elegível · ${Number(entry.amount).toLocaleString('pt-BR')}¥`;
    return 'Sem serviço elegível registrado';
}

module.exports = {
    nome: `${COMMAND_PREFIX}salario`,
    aliases: [`${COMMAND_PREFIX}salário`],
    descricao: 'Mostra elegibilidade e pagamento semanal de Cavaleiro Mágico.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const dashboard = await getSalaryDashboard(db, idJogador);
        await sendReply({
            sock, idChat, m,
            text: [
                '*♧┃𝐒𝐀𝐋𝐀́𝐑𝐈𝐎 𝐃𝐄 𝐂𝐀𝐕𝐀𝐋𝐄𝐈𝐑𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                '',
                `*Patente:* ${dashboard.current.patent}`,
                `*Semana atual (${dashboard.current.weekKey}):* ${statusLine(dashboard.current)}`,
                `*Semana anterior (${dashboard.previous.weekKey}):* ${statusLine(dashboard.previous)}`,
                `*Próximo fechamento:* ${dashboard.nextPayment}`,
                '',
                dashboard.current.service
                    ? `> Serviço reconhecido: ${dashboard.current.service.label}`
                    : '> Uma missão/serviço elegível basta; mais serviços não multiplicam o salário.',
            ].join('\n'),
        });
    },
};
