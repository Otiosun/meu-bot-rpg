const { COMMAND_PREFIX } = require('../config/bot');
const { ensurePlayerRecord, ensureOnboardingState } = require('../helpers/playerRegistry');

module.exports = {
    nome: `${COMMAND_PREFIX}registrar`,
    oculto: true,
    descricao: 'Mantem um cadastro manual de fallback no sistema.',
    executar: async ({ sock, idChat, idJogador, nomeUsuario, db }) => {
        await ensurePlayerRecord(db, idJogador, nomeUsuario);
        await ensureOnboardingState(db, idJogador, 'cadastro_manual');

        await sock.sendMessage(idChat, {
            text: [
                '*Seu numero ja esta reconhecido no sistema.*',
                '',
                `Agora siga por ${COMMAND_PREFIX}sortear para gerar seus rolls.`,
                `Quando quiser revisar tudo, use ${COMMAND_PREFIX}rolls.`,
            ].join('\n'),
        });
    },
};
