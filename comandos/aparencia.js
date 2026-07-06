const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    saveAppearanceImageFromMessage,
    sendAppearancePendingNotices,
    setAppearancePending,
} = require('../helpers/clover/appearanceManager');
const { syncArchiveCardForPlayer } = require('../helpers/clover/archiveManager');
const { ensurePlayerRecord } = require('../helpers/playerRegistry');
const { getPendingConfirmation } = require('../helpers/profileForms');

function renderUpdatedAppearanceMessage(appearance, hasImage) {
    return [
        '♧┃𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐄𝐍𝐕𝐈𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  registro visual em avaliação  ──',
        '',
        '_`─( ✓ )───── 𝗘𝘀𝘁𝗮𝗱𝗼`_',
        '',
        '*𝐒𝐭𝐚𝐭𝐮𝐬:* pendente de aprovação',
        `*𝐈𝐦𝐚𝐠𝐞𝐦:* ${hasImage ? 'SIM' : 'NÃO'}`,
        '',
        '_`─( 𖥔 )───── 𝗔𝗽𝗮𝗿𝗲̂𝗻𝗰𝗶𝗮`_',
        '',
        `*${appearance}*`,
        '',
        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
        '',
        'ⓘ Sua ficha não foi apagada; apenas a aparência entrou em avaliação.',
        'A administração vai avaliar e avisar no PV.',
    ].join('\n');
}

function renderAppearanceUsageMessage(player = null) {
    const hasApprovedAppearance = ['approved', 'aprovada'].includes(String(player?.personagem_aparencia_status || '').toLowerCase());
    return [
        '♧┃𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  registro visual do personagem  ──',
        '',
        'Você pode enviar ou trocar a aparência do personagem por aqui.',
        '',
        '_`─( ■ )───── 𝗨𝘀𝗲`_',
        '',
        '*̣.#aparencia Personagem — Obra*',
        '> Envia o nome para avaliação.',
        '',
        '_`─( ✦ )───── 𝗜𝗺𝗮𝗴𝗲𝗺`_',
        '',
        'Também pode enviar uma imagem com legenda.',
        '',
        hasApprovedAppearance ? 'ⓘ A nova aparência entra como pendente e a administração avalia de novo.' : null,
    ].filter(Boolean).join('\n');
}

function renderAppearanceLockedMessage() {
    return [
        '♧┃𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀 𝐀𝐈𝐍𝐃𝐀 𝐁𝐋𝐎𝐐𝐔𝐄𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  etapa ainda indisponível  ──',
        '',
        'Esse comando funciona depois que você tiver uma ficha pendente, confirmada ou aprovada.',
        '',
        '_`─( ■ )───── 𝗨𝘀𝗲`_',
        '',
        '*̣.#status*',
        '> Ver o que falta agora.',
    ].join('\n');
}

async function syncArchiveSafely(sock, db, playerId) {
    try {
        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log(`[arquivo] Não consegui sincronizar aparência de ${playerId}:`, error?.message || error);
    }
}

module.exports = {
    nome: `${COMMAND_PREFIX}aparencia`,
    aliases: [`${COMMAND_PREFIX}aparência`],
    descricao: 'Atualiza somente a aparência do personagem.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body, downloadMediaMessage, P }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const pending = await getPendingConfirmation(db, idJogador);
        const canUpdate = pending || ['confirmada', 'aprovada'].includes(player.ficha_status);

        if (!canUpdate) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderAppearanceLockedMessage(),
            });
            return;
        }

        const appearance = String(body || '').trim();
        if (!appearance) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderAppearanceUsageMessage(player),
            });
            return;
        }

        const imageInfo = await saveAppearanceImageFromMessage({
            sock,
            message: m,
            playerId: idJogador,
            downloadMediaMessage,
            loggerFactory: P,
        });

        await setAppearancePending(db, idJogador, appearance, imageInfo);
        await sendAppearancePendingNotices({
            sock,
            db,
            playerId: idJogador,
            receptionGroupId: idChat?.endsWith('@g.us') ? idChat : null,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: renderUpdatedAppearanceMessage(appearance, Boolean(imageInfo)),
        });

        await syncArchiveSafely(sock, db, idJogador);
    },
};
