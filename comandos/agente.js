'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { buildQuestionId, createAgentBridgeClient } = require('../helpers/clover/chatgptAgentBridgeClient');

module.exports = {
    nome: `${COMMAND_PREFIX}agente`,
    aliases: [`${COMMAND_PREFIX}ia`, `${COMMAND_PREFIX}perguntar`],
    descricao: 'Envia uma dúvida ao agente Clover experimental.',
    gameCommand: false,
    executar: async ({ sock, m, idChat, idJogador, body }) => {
        if (String(idChat || '').endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `Por enquanto o agente experimental funciona apenas no PV. Me envie *${COMMAND_PREFIX}agente sua pergunta* no privado.`,
            });
            return;
        }

        const question = String(body || '').trim();
        if (!question) {
            await sendReply({
                sock,
                idChat,
                m,
                text: `Use *${COMMAND_PREFIX}agente sua pergunta*. Ex.: *${COMMAND_PREFIX}agente posso usar minha magia durante uma raid?*`,
            });
            return;
        }

        const client = createAgentBridgeClient();
        if (!client.config.enabled || !client.config.valid) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'O agente Clover ainda está em implantação. Tente novamente quando o teste estiver ativo.',
            });
            return;
        }

        const id = buildQuestionId({ idChat, messageId: m?.key?.id });
        try {
            const result = await client.enqueueQuestion({
                id,
                playerId: idJogador,
                playerName: m?.pushName || '',
                chatId: idChat,
                question,
                context: {
                    source: 'whatsapp_command',
                    command: `${COMMAND_PREFIX}agente`,
                    message_id: m?.key?.id || null,
                },
            });

            if (result?.skipped && result.reason === 'invalid_question') {
                throw new Error('Pergunta inválida.');
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: result?.duplicate
                    ? 'Essa pergunta já está na fila do agente. Assim que a resposta ficar pronta, eu envio por aqui.'
                    : 'Recebi. O agente Clover vai analisar e a resposta volta por este PV.',
            });
        } catch (error) {
            console.log('[clover-agent] falha ao enfileirar:', error?.code || error?.message || error);
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Não consegui colocar sua pergunta na fila agora. Nada foi cobrado nem alterado; tente novamente depois.',
            });
        }
    },
};
