const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    applyAttributeUpgrade,
    cancelPendingDistribution,
    confirmPendingDistribution,
    getCharacterStats,
    parseDistributionInput,
    parseUpgradeInput,
    renderAttributesPanel,
    renderConfirmedDistribution,
    renderDistributionErrors,
    renderPendingDistribution,
    savePendingDistribution,
} = require('../helpers/clover/characterStats');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { normalizeText } = require('../helpers/textUtils');

function resolveAction(matchedCommand, body) {
    const command = normalizeText(matchedCommand || '');
    const text = normalizeText(body || '');

    if (command.includes('confirmaratributos')) return 'confirm';
    if (command.includes('cancelaratributos')) return 'cancel';
    if (text.startsWith('distribuir')) return 'distribute';
    if (/^(upar|up|aumentar|somar|subir|evoluir)\b/.test(text)) return 'upgrade';
    return 'panel';
}

module.exports = {
    nome: `${COMMAND_PREFIX}atributos`,
    aliases: [
        `${COMMAND_PREFIX}atributo`,
        `${COMMAND_PREFIX}confirmaratributos`,
        `${COMMAND_PREFIX}cancelaratributos`,
    ],
    descricao: 'Mostra e distribui os atributos iniciais do personagem.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        const action = resolveAction(matchedCommand, body);

        if (action === 'panel') {
            const stats = await getCharacterStats(db, idJogador);
            await sendReply({ sock, idChat, m, text: renderAttributesPanel(stats) });
            return;
        }

        if (action === 'distribute') {
            const parsed = parseDistributionInput(body);
            if (parsed.errors.length) {
                await sendReply({ sock, idChat, m, text: renderDistributionErrors(parsed.errors) });
                return;
            }

            const saved = await savePendingDistribution(db, idJogador, parsed.values);
            if (!saved.ok) {
                const errors = saved.reason === 'already_confirmed'
                    ? ['Seus atributos já foram confirmados.']
                    : saved.validation?.errors || ['Não consegui salvar essa distribuição.'];
                await sendReply({ sock, idChat, m, text: renderDistributionErrors(errors) });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: renderPendingDistribution(saved.stats, saved.values, saved.validation),
            });
            return;
        }

        if (action === 'upgrade') {
            const parsed = parseUpgradeInput(body);
            if (parsed.errors.length) {
                await sendReply({ sock, idChat, m, text: renderDistributionErrors(parsed.errors) });
                return;
            }

            const result = await applyAttributeUpgrade(db, idJogador, parsed.values);
            if (!result.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderDistributionErrors(result.validation?.errors || ['NÃ£o consegui upar esse atributo.']),
                });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmedDistribution(result.stats),
            });
            return;
        }

        if (action === 'confirm') {
            const result = await confirmPendingDistribution(db, idJogador);
            if (!result.ok) {
                const text = result.reason === 'missing_pending'
                    ? 'Não existe distribuição pendente para confirmar. Use *.#atributos distribuir ...* primeiro.'
                    : renderDistributionErrors(result.validation?.errors || ['Distribuição pendente inválida.']);
                await sendReply({ sock, idChat, m, text });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: renderConfirmedDistribution(result.stats),
            });
            return;
        }

        if (action === 'cancel') {
            const result = await cancelPendingDistribution(db, idJogador);
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok
                    ? 'Distribuição pendente cancelada. Use *.#atributos* para montar outra.'
                    : 'Não existe distribuição pendente para cancelar.',
            });
        }
    },
};
