'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    ItemRedemptionServiceError,
    cancelItemRedemption,
    listOwnItemRedemptions,
    listPendingItemRedemptions,
    requestItemRedemption,
    resolveItemRedemption,
} = require('../helpers/clover/itemRedemptionService');

function renderRows(rows) {
    return rows.length
        ? rows.map((row) => `*${row.key}* · ${row.itemName} · ${row.status}${row.requestNote ? `\n> ${row.requestNote}` : ''}`)
        : ['> Nenhum pedido encontrado.'];
}

module.exports = {
    nome: `${COMMAND_PREFIX}resgatar`,
    aliases: [`${COMMAND_PREFIX}resgate`],
    descricao: 'Solicita o uso de Ticket de Feitiço ou Acesso a Missão Especial.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (action === 'pendentes') {
                const rows = await listPendingItemRedemptions(db, idJogador);
                await sendReply({ sock, idChat, m, text: ['*♧┃𝐑𝐄𝐒𝐆𝐀𝐓𝐄𝐒 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄𝐒*', '', ...renderRows(rows)].join('\n') });
                return;
            }
            if (['aprovar', 'negar'].includes(action) && tokens[1]) {
                const result = await resolveItemRedemption(
                    db, idJogador, tokens[1], action === 'aprovar' ? 'approved' : 'rejected', tokens.slice(2).join(' ')
                );
                await sendReply({ sock, idChat, m, text: `Resgate ${result.redemption.key}: *${result.redemption.status}*.` });
                return;
            }
            if (action === 'cancelar' && tokens[1]) {
                await cancelItemRedemption(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: 'Pedido cancelado e item liberado.' });
                return;
            }
            const itemId = Number(tokens[0]);
            if (Number.isInteger(itemId)) {
                const result = await requestItemRedemption(db, idJogador, itemId, tokens.slice(1).join(' '), {
                    idempotencyKey: `redemption:${idChat}:${m?.key?.id || Date.now()}`,
                    metadata: { via: 'bot' },
                });
                await sendReply({ sock, idChat, m, text: `Pedido *${result.redemption.key}* enviado. O item ficou reservado até a análise.` });
                return;
            }
            const rows = await listOwnItemRedemptions(db, idJogador);
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐌𝐄𝐔𝐒 𝐑𝐄𝐒𝐆𝐀𝐓𝐄𝐒 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*', '', ...renderRows(rows), '',
                    `Solicitar: *${COMMAND_PREFIX}resgatar <item_id> [observação]*`,
                    `Cancelar: *${COMMAND_PREFIX}resgatar cancelar <código>*`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof ItemRedemptionServiceError || ['ItemAdminServiceError', 'InventoryServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
