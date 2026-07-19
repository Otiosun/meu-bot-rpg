'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getYullsHistory } = require('../helpers/clover/yullsService');

function money(value) {
    const amount = Number(value || 0);
    return `${amount > 0 ? '+' : ''}${amount.toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}extrato`,
    aliases: [],
    descricao: 'Mostra o extrato de Yulls dos últimos 7, 30 ou 90 dias.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const requested = Number(String(body || '').trim() || 7);
        const days = [7, 30, 90].includes(requested) ? requested : 7;
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const rows = (await getYullsHistory(db, idJogador, 100)).filter((row) => {
            const timestamp = new Date(String(row.created_at || '').replace(' ', 'T') + 'Z').getTime();
            return Number.isNaN(timestamp) || timestamp >= cutoff;
        });
        await sendReply({
            sock, idChat, m,
            text: [
                '*♧┃𝐄𝐗𝐓𝐑𝐀𝐓𝐎 𝐃𝐄 𝐘𝐔𝐋𝐋𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                `     ── últimos ${days} dias ──`,
                '',
                ...(rows.length ? rows.slice(0, 20).map((row) => (
                    `*${money(row.amount)}* · ${row.reason || row.source || row.kind}\n> Saldo: ${Number(row.balance_after).toLocaleString('pt-BR')}¥ · ${row.created_at}`
                )) : ['> Nenhuma movimentação nesse período.']),
            ].join('\n'),
        });
    },
};
