'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    EconomyServiceError,
    INITIAL_EQUIPMENT_KEYS,
    grantInitialPackage,
    getShopCatalog,
    listShops,
} = require('../helpers/clover/economyService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}lojas`,
    aliases: [`${COMMAND_PREFIX}loja`],
    descricao: 'Mostra lojas NPC e o catálogo da Economia V1.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (['inicio', 'inicial', 'começar', 'comecar'].includes(String(tokens[0] || '').toLowerCase())) {
                if (!tokens[1]) {
                    await sendReply({
                        sock, idChat, m,
                        text: [
                            `Escolha o equipamento: *${COMMAND_PREFIX}lojas inicio <código>*`,
                            '',
                            ...[...INITIAL_EQUIPMENT_KEYS].map((key) => `> ${key}`),
                        ].join('\n'),
                    });
                    return;
                }
                const result = await grantInitialPackage(db, idJogador, tokens[1], { via: 'bot' });
                await sendReply({
                    sock, idChat, m,
                    text: result.duplicate
                        ? 'Seu pacote inicial da Economia V1 já foi entregue.'
                        : `Pacote entregue: +500¥, Roupas Comuns, ${result.items?.[1]?.item_name || tokens[1]} e Kit de Campo — todos os itens iniciais são vinculados.`,
                });
                return;
            }
            if (!tokens[0]) {
                const shops = await listShops(db);
                await sendReply({
                    sock, idChat, m,
                    text: [
                        '*♧┃𝐋𝐎𝐉𝐀𝐒 𝐃𝐀 𝐂𝐀𝐏𝐈𝐓𝐀𝐋 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                        '',
                        ...shops.map((shop) => `*${shop.name}* · ${shop.listingCount} item(ns)\n> Código: ${shop.key}`),
                        '',
                        `> Abrir: ${COMMAND_PREFIX}loja <código da loja>`,
                    ].join('\n'),
                });
                return;
            }
            const catalog = await getShopCatalog(db, tokens[0]);
            if (tokens[1]) {
                const ref = String(tokens[1]).toLowerCase();
                const item = catalog.listings.find((listing) => (
                    String(listing.key).toLowerCase() === ref
                    || String(listing.templateKey).toLowerCase() === ref
                ));
                if (!item) throw new EconomyServiceError('listing_not_found', 'Item não encontrado nessa loja.');
                const effects = Object.keys(item.effects || {}).length ? JSON.stringify(item.effects) : 'sem efeito mecânico automático';
                await sendReply({
                    sock, idChat, m,
                    text: [
                        `*♧┃${item.itemName.toUpperCase()} 𖥔 𝐂𝐚𝐭𝐚́𝐥𝐨𝐠𝐨*`, '',
                        `*Preço:* ${money(item.unitPrice)}`,
                        `*Origem:* ${item.origin || 'Clover'}`,
                        `*Qualidade:* ${item.quality || 'comum'}`,
                        `*Disponibilidade:* ${item.availability}`,
                        `*Descrição:* ${item.description || '-'}`,
                        `*Efeito registrado:* ${effects}`,
                        item.personalWeeklyLimit ? `*Limite semanal:* ${item.personalWeeklyLimit}` : null,
                        '', `Comprar: *${COMMAND_PREFIX}comprar ${item.key} [qtd]*`,
                    ].filter(Boolean).join('\n'),
                });
                return;
            }
            await sendReply({
                sock, idChat, m,
                text: [
                    `*♧┃${catalog.shop.name.toUpperCase()} 𖥔 𝐄𝐜𝐨𝐧𝐨𝐦𝐢𝐚 𝐕𝟏*`,
                    '',
                    ...(catalog.listings.length ? catalog.listings.map((item) => (
                        `*${item.itemName}* · ${money(item.unitPrice)}\n> ${item.key} · ${item.availability}${item.availability === 'regional' ? ' · +15% · 4h' : ''}\n> Detalhes: ${COMMAND_PREFIX}loja ${catalog.shop.key} ${item.key}`
                    )) : ['> Catálogo aberto apenas quando houver serviço ou anúncio compatível.']),
                    '',
                    `> Comprar: ${COMMAND_PREFIX}comprar <código> [qtd]`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof EconomyServiceError) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
