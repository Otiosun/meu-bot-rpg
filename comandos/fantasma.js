'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    createOrResetGhostTestPlayer,
} = require('../helpers/clover/ghostTestPlayerService');

function renderSuccess(result) {
    const action = result.mode === 'reset' ? 'recriado' : 'criado';
    return [
        '*Modo Fantasma do Clover ativado.*',
        '',
        `Seu personagem de teste foi ${action}.`,
        '',
        '*Personagem:* Whatever',
        '*Tipo:* sandbox, nao canonico',
        '*Estagio:* 2',
        '*Status:* jogo liberado',
        '',
        'Nada disso entra na historia oficial nem deve ser tratado como ficha real.',
        '',
        '*Para testar agora:*',
        `> ${COMMAND_PREFIX}perfil`,
        `> ${COMMAND_PREFIX}status`,
        `> ${COMMAND_PREFIX}atributos`,
        `> ${COMMAND_PREFIX}rolls`,
        `> ${COMMAND_PREFIX}site`,
        '',
        `Se quiser limpar e voltar ao preset, use *${COMMAND_PREFIX}fantasma* de novo.`,
    ].join('\n');
}

function renderBlocked(result) {
    return [
        '*Modo Fantasma nao aplicado.*',
        '',
        result.error || 'Esse numero ja possui dados reais no Clover.',
        '',
        'Para testar sem risco, use outro numero/conta de teste ou faca isso depois de um reset oficial.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}fantasma`,
    aliases: [`${COMMAND_PREFIX}teste`, `${COMMAND_PREFIX}sandbox`],
    descricao: 'Cria um personagem fantasma pronto para testar o Clover sem afetar ficha canonica.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const result = await createOrResetGhostTestPlayer(db, {
            playerId: idJogador,
            alternateIds: [
                m?.key?.remoteJidAlt,
                m?.key?.participantAlt,
            ],
            displayName: nomeUsuario,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: result.ok ? renderSuccess(result) : renderBlocked(result),
            policy: { source: 'ghost_test_reply' },
        });
    },
    renderBlocked,
    renderSuccess,
};
