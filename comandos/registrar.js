const { COMMAND_PREFIX } = require('../config/bot');
const { ensurePlayerRecord, ensureOnboardingState } = require('../helpers/playerRegistry');

module.exports = {
    nome: `${COMMAND_PREFIX}registrar`,
    descricao: 'Faz um cadastro manual simples da sua conta no sistema.',
    executar: async ({ sock, idChat, idJogador, nomeUsuario, db }) => {
        await ensurePlayerRecord(db, idJogador, nomeUsuario);
        await ensureOnboardingState(db, idJogador, 'cadastro_manual');

        await sock.sendMessage(idChat, {
            text: [
                '✅ Seu número já está reconhecido no sistema.',
                '',
                `Agora siga por ${COMMAND_PREFIX}sortear para gerar seus rolls.`,
                `Depois envie sua ${COMMAND_PREFIX}𝐅icha 𝐏essoal.`,
            ].join('\n'),
        });
    },
};
