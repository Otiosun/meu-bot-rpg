const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isSameUser } = require('../helpers/groupAccess');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const {
    createPendingHexagonUpgrade,
    formatHexagonShort,
    getHexagonDerivedLimits,
    getOrCreateHexagon,
    HEXAGON_SIDES,
} = require('../helpers/clover/hexagonService');
const { renderHexagonPngCached } = require('../helpers/clover/hexagonRenderer');
const { normalizeText } = require('../helpers/textUtils');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');

function getMentions(m) {
    return getMessageContextInfo(m)?.mentionedJid || [];
}

function getQuotedParticipant(m) {
    return getMessageContextInfo(m)?.participant || null;
}

function jidFromToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const withoutLeadingAt = raw.replace(/^@/, '');
    if (withoutLeadingAt.includes('@')) return withoutLeadingAt;

    const digits = withoutLeadingAt.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function resolveTarget(body, m, fallbackPlayerId) {
    const mentions = getMentions(m);
    if (mentions.length) return mentions[0];

    const quoted = getQuotedParticipant(m);
    if (quoted) return quoted;

    const first = String(body || '')
        .trim()
        .split(/\s+/)
        .filter((part) => part && normalizeText(part) !== 'texto')[0];
    return jidFromToken(first) || fallbackPlayerId;
}

function wantsTextOnly(body) {
    return String(body || '')
        .trim()
        .split(/\s+/)
        .some((part) => normalizeText(part) === 'texto');
}

function getBodyParts(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function isUpgradeRequest(body) {
    const first = normalizeText(getBodyParts(body)[0] || '');
    return ['upar', 'up', 'evoluir', 'melhorar'].includes(first);
}

function getUpgradeSide(body) {
    return getBodyParts(body).slice(1).join(' ');
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function renderUpgradeUsage() {
    return [
        '♧┃𝐔𝐏 𝐃𝐄 𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  evolução de alcance, duração ᥱ controle  ──',
        '',
        '_`─( ■ )───── 𝗨𝘀𝗲`_',
        '',
        `*̣${COMMAND_PREFIX}hexagono upar <lado>*`,
        '',
        '_`─( ⬡ )───── 𝗟𝗮𝗱𝗼𝘀`_',
        '',
        HEXAGON_SIDES.map((side) => `> ${side.key}`).join('\n'),
        '',
        '_`─( ✦ )───── 𝗘𝘅𝗲𝗺𝗽𝗹𝗼`_',
        '',
        `*̣${COMMAND_PREFIX}hexagono upar controle*`,
    ].join('\n');
}

function renderUpgradePreview(result) {
    const { pending, ph } = result;
    const lines = [
        '♧┃𝐔𝐏 𝐃𝐄 𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  pedido de evolução  ──',
        '',
        '_`─( ⬡ )───── 𝗣𝗲𝗱𝗶𝗱𝗼`_',
        '',
        `*𝐋𝐚𝐝𝐨:* ${pending.sideLabel}`,
        `*𝐀𝐭𝐮𝐚𝐥:* ${pending.oldValue}/5`,
        `*𝐏𝐫𝐨́𝐱𝐢𝐦𝐨:* ${pending.newValue}/5`,
        `*𝐂𝐮𝐬𝐭𝐨:* ${pending.cost} PH`,
        `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${ph.phAvailable}`,
        '',
        '_`─( ✦ )───── 𝗘𝗳𝗲𝗶𝘁𝗼`_',
        '',
        `> ${pending.oldLimitLabel} → ${pending.newLimitLabel}`,
        '',
    ];

    if (pending.requiresApproval) {
        lines.push(
            '_`─( ! )───── 𝗔𝗽𝗿𝗼𝘃𝗮𝗰̧𝗮̃𝗼`_',
            '',
            '> Esse avanço precisa de aprovação narrativa da ADM.',
            '> O pedido ficou registrado, mas o PH ainda não foi gasto.',
            '',
            '_`─( ■ )───── 𝗔𝗗𝗠`_',
            '',
            `*̣${COMMAND_PREFIX}aprovarhexagono @player*`,
            '> Aprova e aplica o gasto de PH.'
        );
    } else {
        lines.push(
            '_`─( ✓ )───── 𝗖𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝗿`_',
            '',
            `*̣${COMMAND_PREFIX}confirmarhexagono*`,
            '> Gastar PH e confirmar.',
            '',
            '_`─( ! )───── 𝗖𝗮𝗻𝗰𝗲𝗹𝗮𝗿`_',
            '',
            `*̣${COMMAND_PREFIX}cancelarhexagono*`,
            '> Cancelar este pedido.'
        );
    }

    return lines.join('\n');
}

function renderUpgradeFailure(result) {
    if (result?.reason === 'insufficient_ph') {
        return [
            '♧┃𝐏𝐇 𝐈𝐍𝐒𝐔𝐅𝐈𝐂𝐈𝐄𝐍𝐓𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
            '     ──  evolução não aplicada  ──',
            '',
            '_`─( ⬡ )───── 𝗣𝗲𝗱𝗶𝗱𝗼`_',
            '',
            `*𝐋𝐚𝐝𝐨:* ${result.sideLabel}`,
            `*𝐀𝐭𝐮𝐚𝐥:* ${result.oldValue}/5`,
            `*𝐏𝐫𝐨́𝐱𝐢𝐦𝐨:* ${result.newValue}/5`,
            `*𝐂𝐮𝐬𝐭𝐨:* ${result.cost} PH`,
            `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${result.ph.phAvailable}`,
            `*𝐅𝐚𝐥𝐭𝐚:* ${result.missingPh} PH`,
        ].join('\n');
    }

    if (result?.reason === 'max_level') {
        return [
            '♧┃𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎 𝐍𝐎 𝐋𝐈𝐌𝐈𝐓𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
            '     ──  lado já maximizado  ──',
            '',
            `*${result.sideLabel}:* ${result.oldValue}/5`,
            '> Esse lado já está no máximo.',
        ].join('\n');
    }

    return renderUpgradeUsage();
}

function renderHexagonCurrentLines(hexagon) {
    return [
        `*𝐏𝐄𝐑:* ${Number(hexagon?.percepcao || 1)} | *𝐑𝐄𝐓:* ${Number(hexagon?.retencao || 1)} |`,
        `*𝐄𝐌𝐈:* ${Number(hexagon?.emissao || 1)} | *𝐂𝐎𝐍:* ${Number(hexagon?.controle || 1)} |`,
        `*𝐏𝐑𝐄:* ${Number(hexagon?.pressao || 1)} | *𝐀𝐋𝐂:* ${Number(hexagon?.alcance || 1)} |`,
    ];
}

function renderHexagon({ targetId, player, hexagon }) {
    const limits = getHexagonDerivedLimits(hexagon);
    const name = player?.personagem_nome && player.personagem_nome !== '-'
        ? player.personagem_nome
        : player?.nome || formatMention(targetId);

    return [
        '♧┃𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎 𝐃𝐄 𝐌𝐀𝐍𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  alcance, duração ᥱ domínio de mana  ──',
        '',
        `${formatMention(targetId)} - ${name}`,
        '',
        '_`─( ⬡ )───── 𝗟𝗮𝗱𝗼𝘀`_',
        '',
        ...renderHexagonCurrentLines(hexagon),
        '',
        '_`─( ✦ )───── 𝗟𝗶𝗺𝗶𝘁𝗲𝘀`_',
        '',
        `*𝐀𝐥𝐜𝐚𝐧𝐜𝐞:* até ${limits.alcanceLabel}`,
        `*𝐀́𝐫𝐞𝐚:* ${limits.areaLabel}`,
        `*𝐃𝐮𝐫𝐚𝐜̧𝐚̃𝐨:* ${limits.duracaoLabel}`,
        `*𝐈𝐦𝐩𝐚𝐜𝐭𝐨 𝐝𝐞 𝐦𝐚𝐧𝐚 𝐩𝐮𝐫𝐚:* PM ${limits.pressaoBonus}`,
        `*𝐂𝐨𝐧𝐭𝐫𝐨𝐥𝐞:* ${limits.controleLabel}`,
        `*𝐄𝐦𝐢𝐬𝐬𝐚̃𝐨:* ${limits.emissaoLabel}`,
        `*𝐏𝐞𝐫𝐜𝐞𝐩𝐜̧𝐚̃𝐨:* ${limits.percepcaoLabel}`,
        '',
        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
        '',
        'ⓘ A árvore diz o que você sabe fazer.',
        'O Hexágono diz até onde isso funciona bem.',
        'O bot não aprova técnica automaticamente.',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}hexagono`,
    aliases: [`${COMMAND_PREFIX}hexágono`],
    descricao: 'Mostra o Hexágono de Mana e limites derivados.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (isUpgradeRequest(body)) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (!phaseInfo.canPlay) {
                await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
                return;
            }

            const side = getUpgradeSide(body);
            if (!side) {
                await sendReply({ sock, idChat, m, text: renderUpgradeUsage() });
                return;
            }

            try {
                const result = await createPendingHexagonUpgrade(db, idJogador, side, idJogador);
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: result.ok ? renderUpgradePreview(result) : renderUpgradeFailure(result),
                });
            } catch (error) {
                console.log('[clover-hexagon-upgrade] falha:', error?.stack || error?.message || error);
                await sendReply({ sock, idChat, m, text: renderUpgradeUsage() });
            }
            return;
        }

        const textOnly = wantsTextOnly(body);
        const targetId = resolveTarget(body, m, idJogador);
        const ownView = isSameUser(targetId, idJogador);

        if (!ownView && !await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode consultar o Hexágono de outro player.',
            });
            return;
        }

        if (ownView) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (!phaseInfo.canPlay) {
                await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
                return;
            }
        }

        const player = await db.get('SELECT id, nome, personagem_nome FROM jogadores WHERE id = ?', [targetId]);
        if (!player) {
            await sendReply({ sock, idChat, m, text: 'Player não encontrado no banco.' });
            return;
        }

        const hexagon = await getOrCreateHexagon(db, targetId);
        const text = renderHexagon({ targetId, player, hexagon });

        if (!textOnly) {
            try {
                const rendered = await renderHexagonPngCached(targetId, hexagon, {
                    title: 'HEXÁGONO DE MANA',
                    subtitle: player?.personagem_nome || player?.nome || formatMention(targetId),
                });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [targetId],
                    imagePath: rendered.path,
                    text,
                });
                return;
            } catch (error) {
                console.log('[clover-hexagon-render] falha ao gerar PNG:', error?.stack || error?.message || error);
            }
        }

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [targetId],
            text,
        });
    },
};
