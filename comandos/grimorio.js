const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const {
    canManagePlayer,
    formatMention,
    getPlayerById,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    listApprovedSpells,
    renderGrimoire,
} = require('../helpers/clover/spellbookService');

async function resolveGrimoireTarget({ db, body, m, idJogador }) {
    const hasExplicitTarget = Boolean(resolveTargetAndRest(body, m).source !== 'none');
    if (!hasExplicitTarget) {
        const player = await getPlayerById(db, idJogador);
        return { ok: true, player: player || { id: idJogador }, explicit: false };
    }

    const { targetId, targetText } = resolveTargetAndRest(body, m);
    const resolved = await resolveTargetPlayer(db, targetId, targetText);
    return { ...resolved, explicit: true };
}

module.exports = {
    nome: `${COMMAND_PREFIX}grimorio`,
    aliases: [
        `${COMMAND_PREFIX}grimório`,
        `${COMMAND_PREFIX}grim`,
        `${COMMAND_PREFIX}meugrimorio`,
        `${COMMAND_PREFIX}meu grimorio`,
        `${COMMAND_PREFIX}meu grimório`,
    ],
    descricao: 'Mostra os feitiços aprovados do personagem.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const target = await resolveGrimoireTarget({ db, body, m, idJogador });
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error });
            return;
        }

        const player = target.player;
        const ownView = isSameUser(player.id, idJogador);
        if (!ownView && !await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode ver o grimório de outro player.',
            });
            return;
        }

        const spells = await listApprovedSpells(db, player.id);
        await sendReply({
            sock,
            idChat,
            m,
            mentions: [player.id],
            text: renderGrimoire(`${playerDisplayName(player, player.id)} (${formatMention(player.id)})`, spells),
        });
    },
};
