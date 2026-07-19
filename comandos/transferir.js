'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { resolveTargetPlayer } = require('../helpers/clover/targetResolver');
const {
    MarketServiceError,
    cancelPayment,
    confirmPayment,
    previewPayment,
} = require('../helpers/clover/marketService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}transferir`,
    aliases: [`${COMMAND_PREFIX}pagar`],
    descricao: 'Transfere Yulls com motivo, reserva e confirmação.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (action === 'confirmar') {
                const result = await confirmPayment(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: `Pagamento concluído: ${money(result.payment.amount)}. Recibo: ${result.payment.key}.` });
                return;
            }
            if (action === 'cancelar') {
                await cancelPayment(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: 'Pagamento cancelado e saldo liberado.' });
                return;
            }
            const context = getMessageContextInfo(m) || {};
            const mentions = Array.isArray(context.mentionedJid) ? context.mentionedJid.filter(Boolean) : [];
            const quotedParticipant = context.participant || context.remoteJid || null;
            const targetId = mentions[0] || quotedParticipant || null;
            const mentionIndex = tokens.findIndex((token) => token.startsWith('@'));
            const amountIndex = mentionIndex >= 0 ? mentionIndex + 1 : 1;
            const amount = Number(tokens[amountIndex]);
            const targetText = targetId ? '' : tokens[0];
            const reason = tokens.slice(amountIndex + 1).join(' ').trim();
            if (!amount || !reason) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}transferir @jogador <valor> <motivo>*.` });
                return;
            }
            const resolved = await resolveTargetPlayer(db, targetId, targetText, {
                quotedParticipant,
                mechanical: true,
                playerFilter: (player) => String(player?.jogo_status || '').toLowerCase() === 'liberado',
            });
            if (!resolved.ok) {
                await sendReply({ sock, idChat, m, text: resolved.error || 'Jogador não encontrado.' });
                return;
            }
            const result = await previewPayment(db, idJogador, resolved.player.id, amount, reason, {
                idempotencyKey: `payment-preview:${idChat}:${m?.key?.id || Date.now()}`,
                via: 'bot',
            });
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐏𝐀𝐆𝐀𝐌𝐄𝐍𝐓𝐎 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*',
                    '',
                    `*Destinatário:* ${resolved.player.personagem_nome || resolved.player.nome || resolved.player.id}`,
                    `*Valor:* ${money(result.payment.amount)}`,
                    `*Motivo:* ${result.payment.reason}`,
                    '',
                    `> Confirme em 2 minutos: ${COMMAND_PREFIX}transferir confirmar ${result.payment.key}`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof MarketServiceError || ['YullsServiceError', 'InventoryServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
