'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { resolveTargetPlayer } = require('../helpers/clover/targetResolver');
const {
    ItemAdminServiceError,
    archiveItemTemplate,
    createItemTemplate,
    grantItemCopies,
    listItemTemplates,
    updateItemTemplate,
} = require('../helpers/clover/itemAdminService');

function parseFields(text) {
    const result = {};
    const regex = /(\w+)=((?:"[^"]*")|(?:'[^']*')|\S+)/g;
    let match;
    while ((match = regex.exec(String(text || ''))) !== null) {
        result[match[1].toLowerCase()] = match[2].replace(/^['"]|['"]$/g, '');
    }
    return result;
}

function inputFromFields(fields) {
    const durability = Number(fields.durabilidade || 0);
    const states = {
        integro: fields.integro,
        desgastado: fields.desgastado,
        danificado: fields.danificado,
        quebrado: fields.quebrado,
    };
    return {
        itemName: fields.nome,
        description: fields.descricao,
        category: fields.categoria,
        kind: fields.tipo,
        origin: fields.origem,
        basePrice: fields.valor === undefined ? undefined : Number(fields.valor),
        defaultQuality: fields.qualidade,
        defaultDurability: fields.durabilidade === undefined ? undefined : (durability > 0 ? durability : null),
        stackable: fields.empilhavel,
        transferable: fields.transferivel,
        marketable: fields.vendavel,
        duplicable: fields.duplicavel,
        requestable: fields.pedidos,
        conditionDescriptions: Object.values(states).some((value) => value !== undefined) ? states : undefined,
    };
}

function renderTemplate(item) {
    return `*${item.key}* · ${item.itemName} · ${Number(item.basePrice).toLocaleString('pt-BR')}¥ · ${item.stackable ? 'empilhável' : 'cópias separadas'} · pedidos ${item.requestable ? 'sim' : 'não'}`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}itemadm`,
    aliases: [`${COMMAND_PREFIX}itensadm`],
    descricao: 'Gerencia modelos e cópias de itens personalizados.',
    gameCommand: false,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const text = String(body || '').trim();
        const [action, key] = text.split(/\s+/, 2);
        const fields = parseFields(text);
        try {
            if (action === 'criar') {
                const result = await createItemTemplate(db, idJogador, inputFromFields(fields));
                await sendReply({ sock, idChat, m, text: `Modelo criado.\n\n${renderTemplate(result.template)}` });
                return;
            }
            if (action === 'editar') {
                const result = await updateItemTemplate(db, idJogador, key, inputFromFields(fields));
                await sendReply({ sock, idChat, m, text: `Modelo atualizado; cópias antigas mantiveram o snapshot anterior.\n\n${renderTemplate(result.template)}` });
                return;
            }
            if (action === 'arquivar') {
                await archiveItemTemplate(db, idJogador, key);
                await sendReply({ sock, idChat, m, text: `Modelo ${key} arquivado. Cópias já existentes foram preservadas.` });
                return;
            }
            if (action === 'dar' || action === 'gerar' || action === 'duplicar') {
                const context = getMessageContextInfo(m) || {};
                const mentions = Array.isArray(context.mentionedJid) ? context.mentionedJid.filter(Boolean) : [];
                const quotedParticipant = context.participant || context.remoteJid || null;
                const targetResult = await resolveTargetPlayer(db, mentions[0] || quotedParticipant, fields.player || '', {
                    quotedParticipant,
                    mechanical: true,
                });
                if (!targetResult.ok) {
                    await sendReply({ sock, idChat, m, text: targetResult.error || 'Jogador não encontrado.' });
                    return;
                }
                const result = await grantItemCopies(db, idJogador, targetResult.player.id, key, Number(fields.qtd || fields.quantidade || 1), {
                    source: 'item_admin_bot',
                    relatedId: `${idChat}:${m?.key?.id || Date.now()}`,
                    idempotencyKey: `item-admin-grant:${idChat}:${m?.key?.id || Date.now()}`,
                    forceSeparate: ['1', 'sim', 'true'].includes(String(fields.separado || '').toLowerCase()),
                });
                await sendReply({ sock, idChat, m, text: `${result.quantity}x ${result.template.itemName} entregue para ${targetResult.player.personagem_nome || targetResult.player.nome || targetResult.player.id}.` });
                return;
            }
            const items = await listItemTemplates(db, { customOnly: true, includeArchived: action === 'todos', limit: 50 });
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐂𝐀𝐓𝐀́𝐋𝐎𝐆𝐎 𝐀𝐃𝐌 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*', '',
                    ...(items.length ? items.map(renderTemplate) : ['> Nenhum modelo personalizado.']), '',
                    `Criar: *${COMMAND_PREFIX}itemadm criar nome="Erva Solar" descricao="Material colhido em Heart." categoria=material valor=2000 durabilidade=0 empilhavel=sim transferivel=sim vendavel=sim duplicavel=sim pedidos=sim*`,
                    `Durável: acrescente *durabilidade=5 integro="..." desgastado="..." danificado="..." quebrado="..."*`,
                    `Entregar: *${COMMAND_PREFIX}itemadm dar <código> @player qtd=3*`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof ItemAdminServiceError || ['InventoryServiceError'].includes(error?.name)) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
