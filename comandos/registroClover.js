const { COMMAND_PREFIX } = require('../config/bot');
const { setCloverRegistrationGroup } = require('../helpers/clover/registrationManager');
const { isOwner, isSameUser } = require('../helpers/groupAccess');
const { sendReply } = require('../helpers/chatReply');

async function isGroupAdmin(sock, groupId, playerId) {
    try {
        const metadata = await sock.groupMetadata(groupId);
        const participant = (metadata.participants || []).find((item) => (
            isSameUser(item.id, playerId)
            || isSameUser(item.jid, playerId)
            || isSameUser(item.lid, playerId)
        ));
        return ['admin', 'superadmin'].includes(participant?.admin);
    } catch {
        return false;
    }
}

async function canManageRegistrationGroup(sock, idChat, idJogador) {
    if (isOwner(idJogador)) return true;
    if (!idChat?.endsWith('@g.us')) return false;
    return isGroupAdmin(sock, idChat, idJogador);
}

module.exports = {
    nome: `${COMMAND_PREFIX}setregistroclover`,
    aliases: [`${COMMAND_PREFIX}registroclover set`],
    descricao: 'Define este grupo como registro oficial de personagens Clover.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (!idChat?.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Use este comando dentro do grupo que sera o registro Clover.',
            });
            return;
        }

        if (!await canManageRegistrationGroup(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode definir o registro Clover.',
            });
            return;
        }

        await setCloverRegistrationGroup(db, idChat);
        await sendReply({
            sock,
            idChat,
            m,
            text: 'Este grupo foi definido como registro oficial de personagens Clover.',
        });
    },
};
