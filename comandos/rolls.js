const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const { ensurePlayerRecord, updateOnboardingStep } = require('../helpers/playerRegistry');
const { listPlayerRolls, renderRollList } = require('../helpers/rollManager');

module.exports = {
    nome: `${COMMAND_PREFIX}rolls`,
    aliases: [`${COMMAND_PREFIX}sorteios`],
    descricao: 'Mostra todos os seus rolls salvos em bloco.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const rolls = await listPlayerRolls(db, idJogador);

        await updateOnboardingStep(db, idJogador, rolls.length > 0 ? 'roll_gerado' : 'inicio', {
            last_message: 'roll_list',
            count: rolls.length,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: renderRollList(rolls, player.numero_roll_escolhido),
        });
    },
};
