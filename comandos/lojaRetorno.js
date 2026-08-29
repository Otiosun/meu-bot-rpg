const { COMMAND_PREFIX } = require('../config/bot');
const { consumeActivationCode } = require('../helpers/activationCode');
const { sendReaction, sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
    closeReturnPointShop,
    getReturnPointShopGateState,
    getReturnPointShopRosterReadiness,
    openReturnPointShop,
} = require('../helpers/clover/returnPointShopGateService');

function resolveAction(matchedCommand, body) {
    const match = normalizeText(matchedCommand);
    if (match === normalizeText(`${COMMAND_PREFIX}ativarlojaretorno`)) return 'ativar';
    if (match === normalizeText(`${COMMAND_PREFIX}desativarlojaretorno`)) return 'desativar';
    if (match === normalizeText(`${COMMAND_PREFIX}statuslojaretorno`)) return 'status';
    const text = normalizeText(body);
    if (text.startsWith('ativar')) return 'ativar';
    if (text.startsWith('desativar')) return 'desativar';
    return 'status';
}

function ownerIdentity(idJogador, m) {
    return idJogador
        || m?.key?.participant
        || m?.key?.remoteJid
        || '';
}

function readinessText(readiness) {
    const current = readiness.keepCount == null ? '?' : readiness.keepCount;
    return [
        `*KEEP exigidos:* ${REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT}`,
        `*KEEP atuais:* ${current}`,
        `*Roster:* ${readiness.rosterStatus || 'nao finalizada'}`,
        readiness.rosterRevision == null ? null : `*Revisao:* ${readiness.rosterRevision}`,
    ].filter(Boolean).join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}lojaretorno`,
    aliases: [
        `${COMMAND_PREFIX}ativarlojaretorno`,
        `${COMMAND_PREFIX}desativarlojaretorno`,
        `${COMMAND_PREFIX}statuslojaretorno`,
    ],
    descricao: 'Abre, fecha ou consulta o gate da Loja de Retorno.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, body, matchedCommand, db }) => {
        if (idChat.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Controle da Loja de Retorno somente no PV do bot.*',
            });
            return;
        }

        const actorId = ownerIdentity(idJogador, m);
        if (!isOwner(actorId)
            && !isOwner(m?.key?.participant)
            && !isOwner(m?.key?.remoteJid)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Somente o Owner pode controlar a Loja de Retorno.*',
            });
            return;
        }

        const action = resolveAction(matchedCommand, body);
        if (action === 'status') {
            const [gate, readiness] = await Promise.all([
                getReturnPointShopGateState(db),
                getReturnPointShopRosterReadiness(db),
            ]);
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    gate.open
                        ? '*♧┃LOJA DE RETORNO · ABERTA*'
                        : '*♧┃LOJA DE RETORNO · FECHADA*',
                    '',
                    readinessText(readiness),
                    gate.openedAt ? `*Aberta em:* ${gate.openedAt}` : null,
                    gate.rosterRevision == null ? null : `*Roster usada na abertura:* r${gate.rosterRevision}`,
                    '',
                    `Abrir: *${COMMAND_PREFIX}lojaretorno ativar 123456*`,
                    `Fechar: *${COMMAND_PREFIX}lojaretorno desativar 123456*`,
                ].filter(Boolean).join('\n'),
            });
            return;
        }

        if (action === 'ativar') {
            const readiness = await getReturnPointShopRosterReadiness(db);
            if (!readiness.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '*A Loja de Retorno NAO foi aberta.*',
                        '',
                        readinessText(readiness),
                        '',
                        readiness.code === 'return_shop_keep_count_mismatch'
                            ? `A abertura exige exatamente *${REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT} KEEP*.`
                            : 'Finalize e valide a roster antes de abrir a loja.',
                        '*O codigo de ativacao nao foi consumido.*',
                    ].join('\n'),
                });
                return;
            }

            const auth = consumeActivationCode(
                body,
                `Novo codigo apos abrir Loja de Retorno por ${actorId}`
            );
            if (!auth.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '*Codigo invalido.*',
                        '',
                        `Use *${COMMAND_PREFIX}lojaretorno ativar 123456* com o codigo atual do terminal.`,
                    ].join('\n'),
                });
                return;
            }

            const result = await openReturnPointShop(db, actorId);
            await sendReaction({ sock, idChat, m, emoji: '✅' });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*♧┃LOJA DE RETORNO · ABERTA*',
                    '',
                    `*KEEP validados:* ${result.gate.keepCountAtOpen}/${REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT}`,
                    `*Roster:* revisao ${result.gate.rosterRevision}`,
                    'Compras no site estao liberadas a partir de agora.',
                ].join('\n'),
            });
            return;
        }

        const auth = consumeActivationCode(
            body,
            `Novo codigo apos fechar Loja de Retorno por ${actorId}`
        );
        if (!auth.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Codigo invalido.*',
                    '',
                    `Use *${COMMAND_PREFIX}lojaretorno desativar 123456* com o codigo atual do terminal.`,
                ].join('\n'),
            });
            return;
        }

        await closeReturnPointShop(db, actorId);
        await sendReaction({ sock, idChat, m, emoji: '✅' });
        await sendReply({
            sock,
            idChat,
            m,
            text: '*♧┃LOJA DE RETORNO · FECHADA*\n\nNovas compras foram bloqueadas imediatamente.',
        });
    },
};
