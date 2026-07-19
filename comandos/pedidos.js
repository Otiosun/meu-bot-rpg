'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    MarketServiceError,
    cancelWeeklyNpcRequest,
    createWeeklyNpcRequest,
    fulfillWeeklyNpcRequest,
    listWeeklyNpcRequests,
    updateWeeklyNpcRequest,
} = require('../helpers/clover/marketService');

function parseFields(text) {
    const result = {};
    const regex = /(\w+)=((?:"[^"]*")|(?:'[^']*')|\S+)/g;
    let match;
    while ((match = regex.exec(String(text || ''))) !== null) {
        result[match[1].toLowerCase()] = match[2].replace(/^['"]|['"]$/g, '');
    }
    return result;
}

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}pedidos`,
    aliases: [`${COMMAND_PREFIX}pedidosemanais`],
    descricao: 'Consulta e atende pedidos semanais de NPCs.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (String(tokens[0] || '').toLowerCase() === 'adm') {
                const subaction = String(tokens[1] || '').toLowerCase();
                const fields = parseFields(body);
                if (subaction === 'criar') {
                    const result = await createWeeklyNpcRequest(db, idJogador, {
                        templateKey: fields.item,
                        npcName: fields.npc,
                        description: fields.descricao,
                        pricePercent: Number(fields.percentual || 100),
                        globalQuantity: Number(fields.global || 10),
                        personalLimit: Number(fields.limite || 2),
                        requiredQuality: fields.qualidade,
                        requiredCondition: fields.condicao,
                    });
                    await sendReply({ sock, idChat, m, text: `Pedido ${result.request.key} criado: ${result.request.itemName}, ${money(result.request.unitPrice)} por unidade.` });
                    return;
                }
                if (subaction === 'editar') {
                    const result = await updateWeeklyNpcRequest(db, idJogador, tokens[2], {
                        npcName: fields.npc,
                        description: fields.descricao,
                        pricePercent: fields.percentual === undefined ? undefined : Number(fields.percentual),
                        globalQuantity: fields.global === undefined ? undefined : Number(fields.global),
                        personalLimit: fields.limite === undefined ? undefined : Number(fields.limite),
                        requiredQuality: fields.qualidade,
                        requiredCondition: fields.condicao,
                    });
                    await sendReply({ sock, idChat, m, text: `Pedido ${result.request.key} atualizado.` });
                    return;
                }
                if (subaction === 'cancelar') {
                    await cancelWeeklyNpcRequest(db, idJogador, tokens[2]);
                    await sendReply({ sock, idChat, m, text: 'Pedido semanal cancelado.' });
                    return;
                }
                await sendReply({ sock, idChat, m, text: `ADM: *${COMMAND_PREFIX}pedidos adm criar item=<código> global=10 limite=2 percentual=100 npc="Nome"*.` });
                return;
            }
            if (String(tokens[0] || '').toLowerCase() === 'entregar') {
                const result = await fulfillWeeklyNpcRequest(db, idJogador, tokens[1], Number(tokens[2]), Number(tokens[3] || 1), {
                    idempotencyKey: `weekly-request:${idChat}:${m?.key?.id || Date.now()}`,
                    via: 'bot',
                });
                await sendReply({ sock, idChat, m, text: `Entrega concluída. Você recebeu ${money(result.delivery.total)}.` });
                return;
            }
            const requests = await listWeeklyNpcRequests(db, idJogador);
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐏𝐄𝐃𝐈𝐃𝐎𝐒 𝐒𝐄𝐌𝐀𝐍𝐀𝐈𝐒 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*', '',
                    ...(requests.length
                        ? requests.map((item) => `*${item.key}* · ${item.itemName} (${item.requiredQuality}; ${item.requiredCondition}) · ${money(item.unitPrice)} · global ${item.deliveredQuantity}/${item.globalQuantity} · seu ${item.playerDelivered}/${item.personalLimit}`)
                        : ['> Nenhum pedido de NPC está disponível nesta semana.']),
                    '', `Entregar: *${COMMAND_PREFIX}pedidos entregar <código> <item_id> [qtd]*`,
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
