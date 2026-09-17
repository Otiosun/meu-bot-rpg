'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    getReturnPointsBalance,
    getReturnPointsLedger,
} = require('../helpers/clover/returnPointsService');

function formatPr(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    });
}

function formatLedgerKind(kind) {
    const labels = {
        credit: '+',
        debit: '-',
        refund: '+',
        compensation: '+',
    };
    return labels[String(kind || '').toLowerCase()] || '•';
}

function renderSummary(balance) {
    const lines = [
        '*♧┃𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*Saldo atual:* ${formatPr(balance)} PR`,
        '',
        '_Saldo oficial registrado no ledger de Pontos de Retorno._',
        '',
        `Use *${COMMAND_PREFIX}pr extrato* para ver os últimos lançamentos.`,
    ];
    return lines.join('\n');
}

function renderLedger(balance, rows) {
    const lines = [
        '*♧┃𝐄𝐗𝐓𝐑𝐀𝐓𝐎 𝐃𝐄 𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎*',
        '',
        `*Saldo creditado:* ${formatPr(balance)} PR`,
        '',
    ];

    if (!rows.length) {
        lines.push('_Nenhum lançamento de Pontos de Retorno ainda._');
        return lines.join('\n');
    }

    for (const row of rows) {
        const amount = Math.abs(Number(row.amount || 0));
        const sign = Number(row.amount || 0) < 0 ? '-' : formatLedgerKind(row.entry_kind);
        const reason = String(row.reason || row.source || 'Movimentação').trim();
        lines.push(`*${sign}${formatPr(amount)} PR* — ${reason}`);
    }
    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}pr`,
    aliases: [
        `${COMMAND_PREFIX}pontosretorno`,
        `${COMMAND_PREFIX}pontos retorno`,
    ],
    descricao: 'Consulta seus Pontos de Retorno.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const action = String(body || '').trim().toLowerCase();

        if (['extrato', 'historico', 'histórico'].includes(action)) {
            const [balance, rows] = await Promise.all([
                getReturnPointsBalance(db, idJogador),
                getReturnPointsLedger(db, idJogador, 10),
            ]);
            await sendReply({ sock, idChat, m, text: renderLedger(balance, rows) });
            return;
        }

        const balance = await getReturnPointsBalance(db, idJogador);
        await sendReply({ sock, idChat, m, text: renderSummary(balance) });
    },
};
