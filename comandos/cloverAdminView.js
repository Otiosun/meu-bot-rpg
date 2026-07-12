const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    getMentions,
    getQuotedParticipant,
} = require('../helpers/clover/commandTargetUtils');
const {
    createCloverAdminView,
    renderViewHelp,
} = require('../helpers/clover/cloverAdminViewFacade');

module.exports = {
    nome: `${COMMAND_PREFIX}clover ver`,
    aliases: [
        `${COMMAND_PREFIX}cs ver`,
        `${COMMAND_PREFIX}clover consultar`,
        `${COMMAND_PREFIX}clover consulta`,
    ],
    descricao: 'Owner: consulta players, fila, lotes, esquadrões e integridade sem alterar o banco.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas o dono pode acessar as visões administrativas completas do Clover.',
            });
            return;
        }

        if (!String(body || '').trim()) {
            await sendReply({ sock, idChat, m, text: renderViewHelp() });
            return;
        }

        const result = await createCloverAdminView(db, body, {
            actorId: idJogador,
            chatId: idChat,
            mentions: getMentions(m),
            quotedParticipant: getQuotedParticipant(m),
        });

        await sendReply({
            sock,
            idChat,
            m,
            mentions: result.mentions || [],
            text: result.ok ? result.text : (result.error || renderViewHelp()),
        });
    },
};
