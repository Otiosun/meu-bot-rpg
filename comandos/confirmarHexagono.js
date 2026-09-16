const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { confirmPendingHexagonUpgrade } = require('../helpers/clover/hexagonService');

function renderSuccess(result) {
    const pending = result.pending;
    return [
        '♧ 𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎 𝐀𝐓𝐔𝐀𝐋𝐈𝐙𝐀𝐃𝐎',
        '',
        `*Lado:* ${pending.sideLabel}`,
        `*Valor:* ${pending.oldValue}/7 → ${pending.newValue}/7`,
        `*PH gasto:* ${pending.cost}`,
        `*PH restante:* ${result.spend.after.phAvailable}`,
        '',
        '──  𝐄𝐅𝐄𝐈𝐓𝐎  ──',
        `> ${pending.oldLimitLabel} → ${pending.newLimitLabel}`,
        '',
        `Use *̣${COMMAND_PREFIX}hexagono* para ver o Hexágono completo.`,
    ].join('\n');
}

function renderFailure(result) {
    if (result?.reason === 'approval_required') {
        return [
            '♧ 𝐀𝐏𝐑𝐎𝐕𝐀𝐂̧𝐀̃𝐎 𝐍𝐄𝐂𝐄𝐒𝐒𝐀́𝐑𝐈𝐀',
            '',
            `*Lado:* ${result.pending.sideLabel}`,
            `*Pedido:* ${result.pending.oldValue}/7 → ${result.pending.newValue}/7`,
            `*Custo:* ${result.pending.cost} PH`,
            '',
            'Esse avanço precisa de aprovação narrativa da ADM.',
            'O PH ainda não foi gasto.',
        ].join('\n');
    }

    if (result?.reason === 'expired_pending') {
        return [
            '♧ 𝐏𝐄𝐃𝐈𝐃𝐎 𝐄𝐗𝐏𝐈𝐑𝐀𝐃𝐎',
            '',
            `Use *̣${COMMAND_PREFIX}hexagono upar <lado>* para abrir outro pedido.`,
        ].join('\n');
    }

    if (result?.reason === 'stale_pending') {
        return [
            '♧ 𝐏𝐄𝐃𝐈𝐃𝐎 𝐃𝐄𝐒𝐀𝐓𝐔𝐀𝐋𝐈𝐙𝐀𝐃𝐎',
            '',
            'O Hexágono mudou depois que esse pedido foi criado.',
            `Use *̣${COMMAND_PREFIX}hexagono upar <lado>* de novo.`,
        ].join('\n');
    }

    return [
        '♧ 𝐒𝐄𝐌 𝐏𝐄𝐃𝐈𝐃𝐎 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄',
        '',
        `Use *̣${COMMAND_PREFIX}hexagono upar <lado>* primeiro.`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}confirmarhexagono`,
    aliases: [`${COMMAND_PREFIX}confirmarhexágono`],
    descricao: 'Confirma um up pendente do Hexágono de Mana.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        try {
            const result = await confirmPendingHexagonUpgrade(db, idJogador, idJogador);
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok ? renderSuccess(result) : renderFailure(result),
            });
        } catch (error) {
            if (error?.code === 'insufficient_ph') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '♧ 𝐏𝐇 𝐈𝐍𝐒𝐔𝐅𝐈𝐂𝐈𝐄𝐍𝐓𝐄',
                        '',
                        'Você não tem PH disponível suficiente para confirmar esse up.',
                        `Use *̣${COMMAND_PREFIX}ph* para conferir.`,
                    ].join('\n'),
                });
                return;
            }
            throw error;
        }
    },
};
