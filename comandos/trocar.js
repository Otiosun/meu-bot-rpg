'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { resolveTargetPlayer } = require('../helpers/clover/targetResolver');
const {
    MarketServiceError,
    cancelSecureTrade,
    confirmSecureTrade,
    createSecureTrade,
    listTrades,
    updateTradeSide,
} = require('../helpers/clover/marketService');

function parseItems(value) {
    if (!value || value === '-') return [];
    return String(value).split(',').filter(Boolean).map((entry) => {
        const [inventoryItemId, quantity = '1'] = entry.split(':');
        return { inventoryItemId: Number(inventoryItemId), quantity: Number(quantity) };
    });
}

function fields(tokens) {
    return Object.fromEntries(tokens.filter((token) => token.includes('=')).map((token) => {
        const index = token.indexOf('=');
        return [token.slice(0, index).toLowerCase(), token.slice(index + 1)];
    }));
}

function summarize(trade, actorId) {
    const mine = trade.creatorId === actorId;
    return `*${trade.key}* · ${trade.status} · revisão ${trade.revision} · você ${mine ? (trade.creatorConfirmed ? 'confirmou' : 'não confirmou') : (trade.targetConfirmed ? 'confirmou' : 'não confirmou')} · outro lado ${mine ? (trade.targetConfirmed ? 'confirmou' : 'não confirmou') : (trade.creatorConfirmed ? 'confirmou' : 'não confirmou')}`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}trocar`,
    aliases: [`${COMMAND_PREFIX}troca`],
    descricao: 'Cria e confirma uma Troca Segura.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        const action = String(tokens[0] || '').toLowerCase();
        try {
            if (action === 'confirmar') {
                const result = await confirmSecureTrade(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: result.completed ? `Troca ${result.trade.key} concluída. Recibo registrado para os dois lados.` : `Sua parte da troca ${result.trade.key} foi reservada e confirmada.` });
                return;
            }
            if (action === 'cancelar') {
                await cancelSecureTrade(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: 'Troca cancelada; itens e Yulls reservados foram liberados.' });
                return;
            }
            if (action === 'editar') {
                const data = fields(tokens.slice(2));
                const result = await updateTradeSide(db, idJogador, tokens[1], {
                    items: parseItems(data.itens || data.items),
                    yulls: Number(data.yulls || 0),
                    note: data.motivo,
                });
                await sendReply({ sock, idChat, m, text: `Troca ${result.trade.key} atualizada para a revisão ${result.trade.revision}. As confirmações anteriores foram anuladas.` });
                return;
            }
            if (action === 'criar') {
                const context = getMessageContextInfo(m) || {};
                const mentions = Array.isArray(context.mentionedJid) ? context.mentionedJid.filter(Boolean) : [];
                const quotedParticipant = context.participant || context.remoteJid || null;
                const targetId = mentions[0] || quotedParticipant || null;
                const targetToken = tokens[1]?.startsWith('@') ? tokens[1] : tokens[1];
                const resolved = await resolveTargetPlayer(db, targetId, targetId ? '' : targetToken, {
                    quotedParticipant,
                    mechanical: true,
                    playerFilter: (player) => String(player?.jogo_status || '').toLowerCase() === 'liberado',
                });
                if (!resolved.ok) {
                    await sendReply({ sock, idChat, m, text: resolved.error || 'Jogador não encontrado.' });
                    return;
                }
                const data = fields(tokens.slice(2));
                const result = await createSecureTrade(db, idJogador, resolved.player.id, {
                    creatorItems: parseItems(data.dar),
                    targetItems: parseItems(data.pedir),
                    creatorYulls: Number(data.ydar || 0),
                    targetYulls: Number(data.ypedir || 0),
                    note: data.motivo,
                }, { via: 'bot' });
                await sendReply({
                    sock, idChat, m,
                    text: `Troca *${result.trade.key}* criada. Cada lado deve usar *${COMMAND_PREFIX}trocar confirmar ${result.trade.key}*. Alterações anulam confirmações anteriores.`,
                });
                return;
            }
            const trades = await listTrades(db, idJogador, 20);
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐓𝐑𝐎𝐂𝐀 𝐒𝐄𝐆𝐔𝐑𝐀 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*', '',
                    ...(trades.length ? trades.map((trade) => summarize(trade, idJogador)) : ['> Nenhuma troca registrada.']),
                    '',
                    `Criar: *${COMMAND_PREFIX}trocar criar @jogador dar=12:1,15:2 pedir=22:1 ydar=0 ypedir=500*`,
                    '> Itens usam o ID exibido no inventário. Campos sem item podem usar “-”.',
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
