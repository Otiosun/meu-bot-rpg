'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const {
    formatMention,
    getPlayerById,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    ACCESS_PERMISSIONS,
    authorizeCharacterCommandAccess,
} = require('../helpers/clover/accessIntegrationService');
const { listApprovedSpells } = require('../helpers/clover/spellbookService');
const {
    parsePageNumber,
    renderGrimoirePage,
} = require('../helpers/clover/spellbookPresentation');

function looksLikePageExpression(value) {
    const text = String(value || '').trim();
    return /^\d{1,3}$/.test(text)
        || /^(?:pagina|página|pag|pág|p)(?:\s+.*)?$/i.test(text);
}

async function resolveGrimoireRequest({ db, body, m, idJogador }) {
    const parsed = resolveTargetAndRest(body, m);

    if (parsed.source === 'none' || (parsed.source === 'body' && looksLikePageExpression(body))) {
        const player = await getPlayerById(db, idJogador);
        return {
            ok: true,
            player: player || { id: idJogador },
            explicit: false,
            pageText: String(body || '').trim(),
        };
    }

    const resolved = await resolveTargetPlayer(db, parsed.targetId, parsed.targetText, {
        rejectEmptyCharacter: false,
    });
    return {
        ...resolved,
        explicit: true,
        pageText: parsed.rest,
    };
}

function renderInvalidPage(prefix = COMMAND_PREFIX) {
    return [
        '*♧┃𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        '> Informe a página como número.',
        `> Exemplo: ${prefix}grimorio pagina 2`,
    ].join('\n');
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
    descricao: 'Mostra o índice compacto de feitiços aprovados conforme o cargo.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const target = await resolveGrimoireRequest({ db, body, m, idJogador });
        if (!target.ok) {
            await sendReply({ sock, idChat, m, text: target.error });
            return;
        }

        const player = target.player;
        const ownView = isSameUser(player.id, idJogador);
        const access = await authorizeCharacterCommandAccess({
            db,
            sock,
            idChat,
            actorId: idJogador,
            targetPlayer: player,
            permission: ACCESS_PERMISSIONS.GRIMOIRE_READ,
            allowSelf: true,
            allowLegacyAdmin: true,
        });
        if (!access.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Você não possui acesso ao grimório desse personagem.',
            });
            return;
        }

        const page = parsePageNumber(target.pageText, 1);
        if (page === null) {
            await sendReply({ sock, idChat, m, text: renderInvalidPage() });
            return;
        }

        const spells = await listApprovedSpells(db, player.id);
        const mention = formatMention(player.id);
        await sendReply({
            sock,
            idChat,
            m,
            mentions: [player.id],
            text: renderGrimoirePage(
                `${playerDisplayName(player, player.id)} (${mention})`,
                spells,
                {
                    page,
                    prefix: COMMAND_PREFIX,
                    targetMention: ownView ? '' : mention,
                }
            ),
        });
    },
    resolveGrimoireRequest,
};
