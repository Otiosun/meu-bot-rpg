const { COMMAND_PREFIX } = require('../config/bot');
const {
    getAttributeValues,
    getPbUsage,
} = require('../helpers/clover/characterStats');
const {
    buildProfileCapacitySummary,
    getPlayerTechnicalCapacity,
} = require('../helpers/clover/capacityService');
const { getCharacterBonusSummary } = require('../helpers/clover/characterBonusService');
const {
    formatStars,
    formatYulls,
    getCavalierSummary,
} = require('../helpers/clover/cavalierService');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');

function firstFilled(...values) {
    return values.find((value) => value !== null && value !== undefined && String(value).trim() && String(value).trim() !== '-') || '-';
}

function formatNumber(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '-';
    return new Intl.NumberFormat('pt-BR').format(number);
}

function display(value, fallback = '-') {
    const raw = firstFilled(value);
    return raw === '-' ? fallback : String(raw).trim();
}

function statusLabel(value, labels, fallback = 'pendente') {
    const key = String(value || '').trim().toLowerCase();
    return labels[key] || fallback;
}

function fichaStatusLabel(player) {
    return statusLabel(player?.ficha_status, {
        aprovada: 'aprovada',
        confirmada: 'confirmada',
        incompleta: 'incompleta',
    });
}

function appearanceStatusLabel(player) {
    return statusLabel(player?.personagem_aparencia_status, {
        approved: 'aprovada',
        aprovada: 'aprovada',
        rejected: 'negada',
        negada: 'negada',
        reprovada: 'negada',
        pending: 'pendente',
        pendente: 'pendente',
    });
}

function storyStatusLabel(player) {
    return statusLabel(player?.historia_status, {
        approved: 'aprovada',
        aprovada: 'aprovada',
        rejected: 'precisa de ajuste',
        negada: 'precisa de ajuste',
        rejeitada: 'precisa de ajuste',
        reprovada: 'precisa de ajuste',
        pendente: 'pendente',
    });
}

function gameStatusLabel(player) {
    return statusLabel(player?.jogo_status, {
        liberado: 'liberado',
        bloqueado: 'bloqueado',
    }, 'bloqueado');
}

function traitLabel(summary, key, fallback = 'Nenhuma') {
    const trait = summary?.traits?.[key];
    return display(trait?.label, fallback);
}

function renderAttributeLines(stats) {
    const values = getAttributeValues(stats, {
        usePending: stats.distribution_status === 'pending_confirmation',
    });
    return [
        `*𝐅𝐨𝐫𝐜̧𝐚:* ${Number(values.forca || 0)}`,
        `*𝐕𝐞𝐥𝐨𝐜𝐢𝐝𝐚𝐝𝐞:* ${Number(values.velocidade || 0)}`,
        `*𝐀𝐠𝐢𝐥𝐢𝐝𝐚𝐝𝐞:* ${Number(values.agilidade || 0)}`,
        `*𝐑𝐞𝐬𝐢𝐬𝐭𝐞̂𝐧𝐜𝐢𝐚:* ${Number(values.resistencia || 0)}`,
        `*𝐏𝐨𝐝𝐞𝐫 𝐌𝐚́𝐠𝐢𝐜𝐨:* ${Number(values.poder_magico || 0)}`,
    ];
}

function hasProfileFamily(value) {
    const normalized = normalizeText(value);
    return normalized
        && !['-', 'nenhum', 'nenhuma', 'sem familia', 'sem linhagem registrada'].includes(normalized);
}

function renderFamilyLine(identity, player) {
    const identityFamily = firstFilled(identity?.family);
    const playerFamily = firstFilled(player?.familia);
    const family = hasProfileFamily(identityFamily) ? identityFamily : playerFamily;
    return hasProfileFamily(family) ? `*𝐅𝐚𝐦𝐢́𝐥𝐢𝐚:* ${display(family)}` : null;
}

function appearanceProfileLabel(player) {
    return display(firstFilled(player?.personagem_aparencia, player?.aparencia), appearanceStatusLabel(player));
}

function formatReserveDisplay(summary, fallback = '-') {
    const reserve = summary?.reserve || {};
    if (reserve.percent && reserve.amount !== null && reserve.amount !== undefined) {
        return `${formatNumber(reserve.amount)} — _${reserve.percent}% Heart_`;
    }
    return display(fallback);
}

function renderHexagonLines(hexagon) {
    return [
        `*𝐏𝐄𝐑:* ${Number(hexagon?.percepcao || 1)} | *𝐑𝐄𝐓:* ${Number(hexagon?.retencao || 1)} |`,
        `*𝐄𝐌𝐈:* ${Number(hexagon?.emissao || 1)} | *𝐂𝐎𝐍:* ${Number(hexagon?.controle || 1)} |`,
        `*𝐏𝐑𝐄:* ${Number(hexagon?.pressao || 1)} | *𝐀𝐋𝐂:* ${Number(hexagon?.alcance || 1)} |`,
    ];
}

function formatInventoryCount(value) {
    const total = Number(value || 0);
    return `${total} ${total === 1 ? 'item' : 'itens'}`;
}

function renderCavalierLines(summary) {
    if (!summary?.ok) {
        return [
            '_`─( ★ )───── 𝗖𝗮𝘃𝗮𝗹𝗲𝗶𝗿𝗼`_',
            '',
            '*𝐘𝐮𝐥𝐥𝐬:* 0¥',
            '*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* 0 estrelas',
            '*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* Cavaleiro Mágico Júnior de 5ª Classe',
            '*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* -',
            '*𝐈𝐧𝐯𝐞𝐧𝐭𝐚́𝐫𝐢𝐨:* 0 itens',
        ];
    }

    const squad = summary.squad;
    const squadLabel = squad
        ? `${squad.name} — ${formatStars(squad.currentStars)} atuais`
        : display(summary.player?.esquadrao);

    return [
        '_`─( ★ )───── 𝗖𝗮𝘃𝗮𝗹𝗲𝗶𝗿𝗼`_',
        '',
        `*𝐘𝐮𝐥𝐥𝐬:* ${formatYulls(summary.yulls)}`,
        `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ${formatStars(summary.stars)}`,
        `*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* ${summary.patent}`,
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${squadLabel}`,
        `*𝐈𝐧𝐯𝐞𝐧𝐭𝐚́𝐫𝐢𝐨:* ${formatInventoryCount(summary.inventoryCount)}`,
    ];
}

function renderProfile(capacity, bonusSummary, cavalierSummary) {
    const player = capacity.player;
    const stats = capacity.stats;
    const pb = getPbUsage(stats);
    const ph = capacity.ph || {};
    const identity = bonusSummary?.ok ? bonusSummary.identity : {};
    const manaTotal = bonusSummary?.ok ? bonusSummary.mana.total : capacity.manaTotal;
    const reserve = bonusSummary?.ok ? formatReserveDisplay(bonusSummary) : '-';
    const profileCapacity = buildProfileCapacitySummary(capacity);
    const familyLine = renderFamilyLine(identity, player);

    const lines = [
        '♧┃𝐏𝐄𝐑𝐅𝐈𝐋 𝐃𝐎 𝐌𝐀𝐆𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  fıchα αtuαl ᥱ progrᥱsso do pᥱrsonαgᥱm  ──',
        '',
        '_`─( 𖥔 )───── 𝗣𝗲𝗿𝘀𝗼𝗻𝗮𝗴𝗲𝗺`_',
        '',
        `*𝐍𝐨𝐦𝐞:* ${display(firstFilled(identity.name, player.personagem_nome, player.nome), 'Personagem')}`,
        `*𝐑𝐞𝐢𝐧𝐨:* ${display(firstFilled(identity.kingdom, player.reino))}`,
        `*𝐑𝐚𝐜̧𝐚:* ${display(firstFilled(identity.race, player.raca))}`,
        `*𝐂𝐥𝐚𝐬𝐬𝐞:* ${display(firstFilled(identity.socialClass, player.classe))}`,
        ...(familyLine ? [familyLine] : []),
        `*𝐆𝐫𝐢𝐦𝐨́𝐫𝐢𝐨:* ${display(firstFilled(identity.grimoire, player.grimorio))}`,
        `*𝐌𝐚𝐠𝐢𝐚:* ${display(firstFilled(identity.magic, player.magia))}`,
        '',
        '_`─( ✓ )───── 𝗘𝘀𝘁𝗮𝗱𝗼`_',
        '',
        `*𝐅𝐢𝐜𝐡𝐚:* ${fichaStatusLabel(player)}`,
        `*𝐀𝐩𝐚𝐫𝐞̂𝐧𝐜𝐢𝐚:* ${appearanceProfileLabel(player)}`,
        `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐚:* ${storyStatusLabel(player)}`,
        `*𝐉𝐨𝐠𝐨:* ${gameStatusLabel(player)}`,
        '',
        '_`─( ✦ )───── 𝗣𝗼𝗱𝗲𝗿`_',
        '',
        `*𝐄𝐬𝐜𝐚𝐥𝐚:* ${capacity.stageName}`,
        `*𝐏𝐨𝐝𝐞𝐫 𝐝𝐞 𝐁𝐚𝐬𝐞:* ${pb.pbTotal} PB`,
        `*𝐏𝐁 𝐥𝐢𝐯𝐫𝐞:* ${pb.free}`,
        `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${Number(ph.phAvailable || 0)}`,
        `*𝐏𝐇 𝐚𝐜𝐮𝐦𝐮𝐥𝐚𝐝𝐨:* ${Number(ph.phAccumulated || 0)}`,
        '',
        '_`─( ◆ )───── 𝗔𝘁𝗿𝗶𝗯𝘂𝘁𝗼𝘀`_',
        '',
        `*𝐒𝐭𝐚𝐭𝐮𝐬:* ${pb.free}/${pb.pbTotal}`,
        '',
        ...renderAttributeLines(stats),
        '',
        `*𝐌𝐚𝐧𝐚 𝐭𝐨𝐭𝐚𝐥:* ${manaTotal === null ? '-' : formatNumber(manaTotal)}`,
        `*𝐑𝐞𝐬𝐞𝐫𝐯𝐚:* ${reserve}`,
        '',
        '_`─( ♢ )───── 𝗧𝗿𝗮𝗰̧𝗼𝘀`_',
        '',
        `*𝐀𝐩𝐭𝐢𝐝𝐚̃𝐨:* ${bonusSummary?.ok ? traitLabel(bonusSummary, 'aptitude') : display(firstFilled(player.aptidao_rara, player.aptidao_comum))}`,
        `*𝐌𝐚𝐫𝐜𝐚:* ${bonusSummary?.ok ? traitLabel(bonusSummary, 'mark') : display(firstFilled(player.marca_rara, player.marca_comum))}`,
        `*𝐀𝐧𝐨𝐦𝐚𝐥𝐢𝐚:* ${bonusSummary?.ok ? traitLabel(bonusSummary, 'anomaly') : display(player.anomalia, 'Nenhuma')}`,
        `*𝐆𝐚𝐧𝐜𝐡𝐨 𝐍𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐨:* ${bonusSummary?.ok ? display(bonusSummary.traits.hook, 'Nenhum') : display(player.gancho_narrativo, 'Nenhum')}`,
        '',
        '_`─( ⬡ )───── 𝗛𝗲𝘅𝗮́𝗴𝗼𝗻𝗼`_',
        '',
        ...renderHexagonLines(capacity.hexagon),
        '',
        `*𝐀𝐥𝐜𝐚𝐧𝐜𝐞:* até ${capacity.limits.alcanceLabel}`,
        `*𝐃𝐮𝐫𝐚𝐜̧𝐚̃𝐨:* ${capacity.limits.duracaoLabel}`,
        `*𝐈𝐦𝐩𝐚𝐜𝐭𝐨 𝐝𝐞 𝐦𝐚𝐧𝐚 𝐩𝐮𝐫𝐚:* PM ${capacity.limits.pressaoBonus}`,
        '',
        '_`─( 𐂂 )───── 𝗖𝗮𝗽𝗮𝗰𝗶𝗱𝗮𝗱𝗲`_',
        '',
        `*𝐂𝐫𝐢𝐚𝐜̧𝐚̃𝐨:* ${profileCapacity.creation}`,
        `*𝐑𝐞𝐟𝐨𝐫𝐜̧𝐨:* ${profileCapacity.reinforcement}`,
        `*𝐅𝐢́𝐬𝐢𝐜𝐨:* ${profileCapacity.physical}`,
        `*𝐌𝐚𝐧𝐚:* ${profileCapacity.mana}`,
        '',
        `*𝐑𝐞𝐬𝐮𝐦𝐨:* ${profileCapacity.summary}`,
        '',
        '_`─( ■ )───── 𝗗𝗲𝘁𝗮𝗹𝗵𝗲𝘀`_',
        '',
        `*̣${COMMAND_PREFIX}capacidade*`,
        '> Ver o que seu personagem já consegue fazer.',
        `*̣${COMMAND_PREFIX}bonus*`,
        '> Ver mana, reserva, descontos e efeitos registrados.',
        `*̣${COMMAND_PREFIX}arvores*`,
        '> Planejar progresso.',
    ];

    const powerSectionIndex = lines.findIndex((line) => normalizeText(line).includes('poder'));
    if (powerSectionIndex > 0) {
        lines.splice(powerSectionIndex, 0, ...renderCavalierLines(cavalierSummary), '');
    }

    const bonusCommandIndex = lines.findIndex((line) => String(line).includes(`${COMMAND_PREFIX}bonus`));
    if (bonusCommandIndex >= 0) {
        lines.splice(
            bonusCommandIndex + 2,
            0,
            `*̣${COMMAND_PREFIX}inventario*`,
            '> Ver carteira, estrelas, patente e itens.'
        );
    }

    if (stats.distribution_status !== 'confirmed') {
        lines.push(
            '',
            '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
            '',
            'ⓘ Seus atributos ainda não foram confirmados.',
            `Use *̣${COMMAND_PREFIX}atributos* para distribuir ou revisar.`
        );
    } else if (pb.free > 0) {
        lines.push(
            '',
            '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
            '',
            `ⓘ Você possui ${pb.free} PB livre para distribuir.`,
            `Use *̣${COMMAND_PREFIX}atributos*.`
        );
    }

    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}perfil`,
    descricao: 'Mostra o perfil de jogo do personagem.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        const capacity = await getPlayerTechnicalCapacity(db, idJogador);
        if (!capacity.ok) {
            await sendReply({ sock, idChat, m, text: 'Não encontrei seu personagem no banco.' });
            return;
        }

        const bonusSummary = await getCharacterBonusSummary(db, idJogador);
        const cavalierSummary = await getCavalierSummary(db, idJogador);
        await sendReply({ sock, idChat, m, text: renderProfile(capacity, bonusSummary, cavalierSummary) });
    },
};
