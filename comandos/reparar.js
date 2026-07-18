'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    EconomyServiceError,
    confirmRepair,
    previewRepair,
} = require('../helpers/clover/economyService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}reparar`,
    aliases: [`${COMMAND_PREFIX}reparo`],
    descricao: 'Simula e confirma reparo de equipamento.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (String(tokens[0] || '').toLowerCase() === 'confirmar') {
                const result = await confirmRepair(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: `Reparo iniciado. Entrega prevista: ${result.repair.deliverAt}.` });
                return;
            }
            const itemId = Number(tokens[0]);
            if (!Number.isInteger(itemId)) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}reparar <id do item> [expresso] [vale]*.` });
                return;
            }
            const flags = new Set(tokens.map((token) => token.toLowerCase()));
            const messageId = m?.key?.id || `${Date.now()}`;
            const result = await previewRepair(db, idJogador, itemId, {
                express: flags.has('expresso'), useVoucher: flags.has('vale'), via: 'bot',
                idempotencyKey: `repair-preview:${idChat}:${messageId}`,
            });
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐑𝐄𝐏𝐀𝐑𝐎 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*',
                    '',
                    `*Item:* ${result.item.item_name}`,
                    `*Pontos restaurados:* ${result.repair.points}`,
                    `*Custo por ponto:* ${money(result.repair.pointCost)}`,
                    result.repair.brokenSurcharge ? `*Sobretaxa quebrado:* ${money(result.repair.brokenSurcharge)}` : null,
                    result.repair.discount ? `*Vale:* -${money(result.repair.discount)}` : null,
                    `*Total:* ${money(result.repair.total)}`,
                    '',
                    `> Confirme em 2 minutos: ${COMMAND_PREFIX}reparar confirmar ${result.repair.key}`,
                ].filter(Boolean).join('\n'),
            });
        } catch (error) {
            if (error instanceof EconomyServiceError || ['YullsServiceError', 'InventoryServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
