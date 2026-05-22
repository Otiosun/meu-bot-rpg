const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollCount } = require('../helpers/rollManager');

function renderWelcomeMessage(idJogador, rollCount) {
    return [
        `👋 *Boas-vindas, @${idJogador.split('@')[0]}!*`,
        '',
        'Eu vou te guiar ate sua ficha ser aprovada.',
        '',
        'Primeiro, siga estes passos:',
        '',
        `*1.* Use *${COMMAND_PREFIX}sortear* para gerar um roll completo.`,
        `> Voce pode sortear ate *${MAX_PLAYER_ROLLS} vezes*.`,
        '',
        `*2.* Use *${COMMAND_PREFIX}rolls* para rever todos os rolls salvos.`,
        '',
        `*3.* Use *${COMMAND_PREFIX}Ficha* para receber o modelo da ficha.`,
        '',
        '*4.* Preencha e envie a ficha exatamente no modelo enviado.',
        '> Nao altere a estrutura, os campos ou a ordem.',
        '',
        '*5.* Eu vou conferir se esta tudo certo:',
        '> idade, genero, aparencia, roll escolhido, classe, magia e possiveis conflitos.',
        '',
        `*6.* Quando tudo estiver correto, use *${COMMAND_PREFIX}confirmar*.`,
        '',
        '*7.* Depois disso, eu vou pedir que voce escolha uma magia disponivel.',
        '',
        '⚠️ Se nao entender algo, tudo bem.',
        'Eu vou te guiar passo a passo.',
        '',
        'Caso perca a mensagem ou queira continuar depois, use:',
        `*${COMMAND_PREFIX}continuar*`,
        '',
        `> Seu progresso atual: *${rollCount}/${MAX_PLAYER_ROLLS}* roll(s) salvo(s).`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}start`,
    aliases: [`${COMMAND_PREFIX}iniciar`, `${COMMAND_PREFIX}comecar`, `${COMMAND_PREFIX}começar`],
    descricao: 'Inicia o fluxo guiado de cadastro do bot.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rollCount = await getPlayerRollCount(db, idJogador);

        await updateOnboardingStep(
            db,
            idJogador,
            rollCount > 0 ? onboarding.current_step || 'roll_gerado' : 'inicio',
            { last_message: 'welcome', roll_count: rollCount }
        );

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [idJogador],
            text: renderWelcomeMessage(idJogador, rollCount),
        });
    },
};
