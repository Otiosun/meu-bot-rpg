const { COMMAND_PREFIX } = require('../config/bot');
const { consumeActivationCode } = require('../helpers/activationCode');
const { isGroupEnabled, setGroupEnabled } = require('../helpers/groupAccess');
const { sendReaction, sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');

function resolveAction(matchedCommand, body) {
    const normalizedMatch = normalizeText(matchedCommand);
    if (normalizedMatch === normalizeText(`${COMMAND_PREFIX}ativargrupo`)) return 'ativar';
    if (normalizedMatch === normalizeText(`${COMMAND_PREFIX}desativargrupo`)) return 'desativar';
    if (normalizedMatch === normalizeText(`${COMMAND_PREFIX}statusgrupo`)) return 'status';

    const normalizedBody = normalizeText(body);
    if (normalizedBody.startsWith('ativar')) return 'ativar';
    if (normalizedBody.startsWith('desativar')) return 'desativar';
    return 'status';
}

module.exports = {
    nome: `${COMMAND_PREFIX}grupo`,
    aliases: [`${COMMAND_PREFIX}ativargrupo`, `${COMMAND_PREFIX}desativargrupo`, `${COMMAND_PREFIX}statusgrupo`],
    descricao: 'Ativa ou desativa o bot neste grupo.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, body, matchedCommand, db }) => {
        if (!idChat.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Esse comando so pode ser usado dentro de um grupo.*',
            });
            return;
        }

        const action = resolveAction(matchedCommand, body);
        if (action === 'ativar') {
            const auth = consumeActivationCode(body, `Novo codigo para grupos apos ativacao em ${idChat}`);
            if (!auth.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '*Codigo invalido para ativacao.*',
                        '',
                        `Use *${COMMAND_PREFIX}ativargrupo 123456* com o codigo atual de 6 digitos que apareceu no terminal.`,
                    ].join('\n'),
                });
                return;
            }

            await setGroupEnabled(db, idChat, true);
            await sendReaction({
                sock,
                idChat,
                m,
                emoji: '✅',
            });
            return;
        }

        if (action === 'desativar') {
            const auth = consumeActivationCode(body, `Novo codigo para grupos apos desativacao em ${idChat}`);
            if (!auth.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '*Codigo invalido para desativacao.*',
                        '',
                        `Use *${COMMAND_PREFIX}desativargrupo 123456* com o codigo atual de 6 digitos que apareceu no terminal.`,
                    ].join('\n'),
                });
                return;
            }

            await setGroupEnabled(db, idChat, false);
            await sendReaction({
                sock,
                idChat,
                m,
                emoji: '✅',
            });
            return;
        }

        const enabled = await isGroupEnabled(db, idChat);
        await sendReply({
            sock,
            idChat,
            m,
            text: [
                enabled
                    ? '*Status atual: bot ativado neste grupo.*'
                    : '*Status atual: bot desativado neste grupo.*',
                '',
                `Para ativar: *${COMMAND_PREFIX}ativargrupo 123456*`,
                `Para desativar: *${COMMAND_PREFIX}desativargrupo 123456*`,
                'Use o codigo atual de 6 digitos que esta no terminal.',
            ].filter(Boolean).join('\n'),
        });
    },
};
