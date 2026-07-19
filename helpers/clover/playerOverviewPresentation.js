'use strict';

const { getAttributeValues, getPbUsage } = require('./characterStats');
const { buildProfileCapacitySummary } = require('./capacityService');
const { formatStars, formatYulls } = require('./cavalierService');
const { normalizeText } = require('../textUtils');

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

function getProfileAttributes(stats) {
    return getAttributeValues(stats, {
        usePending: stats?.distribution_status === 'pending_confirmation',
    });
}

function renderAttributeLines(stats) {
    const values = getProfileAttributes(stats);
    return [
        `*𝐅𝐨𝐫𝐜̧𝐚:* ${Number(values.forca || 0)}`,
        `*𝐕𝐞𝐥𝐨𝐜𝐢𝐝𝐚𝐝𝐞:* ${Number(values.velocidade || 0)}`,
        `*𝐀𝐠𝐢𝐥𝐢𝐝𝐚𝐝𝐞:* ${Number(values.agilidade || 0)}`,
        `*𝐑𝐞𝐬𝐢𝐬𝐭𝐞̂𝐧𝐜𝐢𝐚:* ${Number(values.resistencia || 0)}`,
        `*𝐏𝐨𝐝𝐞𝐫 𝐌𝐚́𝐠𝐢𝐜𝐨:* ${Number(values.poder_magico || 0)}`,
    ];
}

function renderCompactAttributeLines(stats) {
    const values = getProfileAttributes(stats);
    return [
        `*𝐅𝐎𝐑:* ${Number(values.forca || 0)} · *𝐕𝐄𝐋:* ${Number(values.velocidade || 0)} · *𝐀𝐆𝐈:* ${Number(values.agilidade || 0)}`,
        `*𝐑𝐄𝐒:* ${Number(values.resistencia || 0)} · *𝐏𝐌:* ${Number(values.poder_magico || 0)}`,
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

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function renderProfileCompact(capacity, bonusSummary, cavalierSummary, { prefix = '.#' } = {}) {
    const player = capacity.player;
    const stats = capacity.stats;
    const pb = getPbUsage(stats);
    const ph = capacity.ph || {};
    const identity = bonusSummary?.ok ? bonusSummary.identity : {};
    const manaTotal = bonusSummary?.ok ? bonusSummary.mana.total : capacity.manaTotal;
    const reserve = bonusSummary?.ok ? formatReserveDisplay(bonusSummary) : '-';
    const squad = cavalierSummary?.squad;
    const squadName = squad?.name || display(cavalierSummary?.player?.esquadrao || player.esquadrao);
    const characterName = display(firstFilled(identity.name, player.personagem_nome, player.nome), 'Personagem');
    const magic = display(firstFilled(identity.magic, player.magia));
    const grimoire = display(firstFilled(identity.grimoire, player.grimorio));

    const lines = [
        '*♧┃𝐏𝐄𝐑𝐅𝐈𝐋 𝐃𝐎 𝐌𝐀𝐆𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  visão rápida do personagem  ──',
        '',
        section('𖥔', '𝗣𝗲𝗿𝘀𝗼𝗻𝗮𝗴𝗲𝗺'),
        '',
        `*𝐍𝐨𝐦𝐞:* ${characterName}`,
        `*𝐌𝐚𝐠𝐢𝐚:* ${magic}`,
        `*𝐆𝐫𝐢𝐦𝐨́𝐫𝐢𝐨:* ${grimoire}`,
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${squadName}`,
        `*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* ${cavalierSummary?.patent || '-'}`,
        '',
        section('✦', '𝗣𝗿𝗼𝗴𝗿𝗲𝘀𝘀𝗼'),
        '',
        `*𝐄𝐬𝐜𝐚𝐥𝐚:* ${capacity.stageName}`,
        `*𝐏𝐁:* ${pb.free} livre de ${pb.pbTotal}`,
        `*𝐏𝐇:* ${Number(ph.phAvailable || 0)} disponível · ${Number(ph.phAccumulated || 0)} acumulado`,
        `*𝐌𝐚𝐧𝐚:* ${manaTotal === null ? '-' : formatNumber(manaTotal)} · *𝐑𝐞𝐬𝐞𝐫𝐯𝐚:* ${reserve}`,
        '',
        section('◆', '𝗔𝘁𝗿𝗶𝗯𝘂𝘁𝗼𝘀'),
        '',
        ...renderCompactAttributeLines(stats),
        '',
        section('♢', '𝗧𝗿𝗮𝗰̧𝗼𝘀'),
        '',
        `*𝐀𝐩𝐭𝐢𝐝𝐚̃𝐨:* ${bonusSummary?.ok ? traitLabel(bonusSummary, 'aptitude') : display(firstFilled(player.aptidao_rara, player.aptidao_comum))}`,
        `*𝐌𝐚𝐫𝐜𝐚:* ${bonusSummary?.ok ? traitLabel(bonusSummary, 'mark') : display(firstFilled(player.marca_rara, player.marca_comum))}`,
        `*𝐀𝐧𝐨𝐦𝐚𝐥𝐢𝐚:* ${bonusSummary?.ok ? traitLabel(bonusSummary, 'anomaly') : display(player.anomalia, 'Nenhuma')}`,
        '',
        section('✓', '𝗘𝘀𝘁𝗮𝗱𝗼'),
        '',
        `*𝐅𝐢𝐜𝐡𝐚:* ${fichaStatusLabel(player)} · *𝐀𝐩𝐚𝐫𝐞̂𝐧𝐜𝐢𝐚:* ${appearanceStatusLabel(player)}`,
        `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐚:* ${storyStatusLabel(player)} · *𝐉𝐨𝐠𝐨:* ${gameStatusLabel(player)}`,
        '',
        section('■', '𝗔𝗯𝗿𝗶𝗿'),
        '',
        `> ${prefix}perfil completo`,
        `> ${prefix}capacidade  ·  ${prefix}inventario  ·  ${prefix}bonus`,
    ];

    if (stats.distribution_status !== 'confirmed') {
        lines.push('', '> ⓘ Atributos ainda não confirmados.');
    } else if (pb.free > 0) {
        lines.push('', `> ⓘ ${pb.free} PB livre para distribuir em ${prefix}atributos.`);
    }

    return lines.join('\n');
}

function renderProfileFull(capacity, bonusSummary, cavalierSummary, { prefix = '.#' } = {}) {
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
        `*̣${prefix}capacidade*`,
        '> Ver o que seu personagem já consegue fazer.',
        `*̣${prefix}bonus*`,
        '> Ver mana, reserva, descontos e efeitos registrados.',
        `*̣${prefix}inventario*`,
        '> Ver carteira, estrelas, patente e itens.',
        `*̣${prefix}arvores*`,
        '> Planejar progresso.',
    ];

    const powerSectionIndex = lines.findIndex((line) => normalizeText(line).includes('poder'));
    if (powerSectionIndex > 0) lines.splice(powerSectionIndex, 0, ...renderCavalierLines(cavalierSummary), '');

    if (stats.distribution_status !== 'confirmed') {
        lines.push(
            '',
            '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
            '',
            'ⓘ Seus atributos ainda não foram confirmados.',
            `Use *̣${prefix}atributos* para distribuir ou revisar.`
        );
    } else if (pb.free > 0) {
        lines.push(
            '',
            '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
            '',
            `ⓘ Você possui ${pb.free} PB livre para distribuir.`,
            `Use *̣${prefix}atributos*.`
        );
    }

    return lines.join('\n');
}

function getItemUseHint(item = {}, prefix = '.#') {
    if (item.kind === 'caixa_pa') return `${prefix}pa abrir`;
    if (item.template_key === 'box_simple_v1') return `${prefix}abrircaixa simples`;
    if (item.template_key === 'box_rare_v1') return `${prefix}abrircaixa rara`;
    if (item.kind === 'cupom_pa') return `${prefix}pa prioridade`;
    return null;
}

function itemConditionLabel(item = {}) {
    const labels = {
        integro: 'Íntegro',
        desgastado: 'Desgastado',
        danificado: 'Danificado',
        quebrado: 'Quebrado',
    };
    return labels[item.condition] || null;
}

function formatItemLine(item, { prefix = '.#' } = {}) {
    const quantity = Number(item.quantity || 1);
    const quantityPrefix = quantity > 1 ? `${quantity}x ` : '';
    const lines = [`*${quantityPrefix}${item.item_name}*`];
    if (display(item.description, '') !== '') lines.push(`> ${item.description}`);
    const useHint = getItemUseHint(item, prefix);
    if (useHint) lines.push(`> 𝐔𝐬𝐨: ${useHint}`);
    return lines.join('\n');
}

function getPlayerName(player = {}) {
    return display(player.personagem_nome || player.nome || player.display_name, 'Personagem');
}

function renderInventoryFull(summary, items, { prefix = '.#' } = {}) {
    const squad = summary.squad;
    const lines = [
        '♧┃𝐂𝐀𝐑𝐓𝐄𝐈𝐑𝐀 𝐄 𝐈𝐍𝐕𝐄𝐍𝐓𝐀́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  visão completa dos recursos registrados  ──',
        '',
        '_`─( ★ )───── 𝗖𝗮𝘃𝗮𝗹𝗲𝗶𝗿𝗼`_',
        '',
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${getPlayerName(summary.player)}`,
        `*𝐘𝐮𝐥𝐥𝐬:* ${formatYulls(summary.yulls)}`,
        `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ${formatStars(summary.stars)}`,
        `*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* ${summary.patent}`,
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${squad ? squad.name : display(summary.player.esquadrao)}`,
    ];

    if (squad) {
        lines.push(
            `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬 𝐚𝐭𝐮𝐚𝐢𝐬:* ${formatStars(squad.currentStars)}`,
            `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐜𝐨:* ${formatStars(squad.historicalStars)}`
        );
    }

    lines.push('', '_`─( ■ )───── 𝗜𝗻𝘃𝗲𝗻𝘁𝗮́𝗿𝗶𝗼`_', '');
    if (!items.length) lines.push('Você ainda não possui itens registrados.');
    else lines.push(...items.map((item) => formatItemLine(item, { prefix })));
    return lines.join('\n');
}

function renderInventoryPage(summary, pageData, { prefix = '.#' } = {}) {
    const lines = [
        '*♧┃𝐈𝐍𝐕𝐄𝐍𝐓𝐀́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  carteira e índice de itens  ──',
        '',
        section('★', '𝗖𝗮𝗿𝘁𝗲𝗶𝗿𝗮'),
        '',
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${getPlayerName(summary.player)}`,
        `*𝐘𝐮𝐥𝐥𝐬:* ${formatYulls(summary.yulls)} · *𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ${formatStars(summary.stars)}`,
        `*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* ${summary.patent}`,
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${summary.squad?.name || display(summary.player.esquadrao)}`,
        '',
        section('■', '𝗜𝘁𝗲𝗻𝘀'),
        '',
        `*𝐓𝐨𝐭𝐚𝐥:* ${pageData.totalUnits} unidade(s) em ${pageData.totalRecords} registro(s)`,
        `*𝐏𝐚́𝐠𝐢𝐧𝐚:* ${pageData.page}/${pageData.totalPages}`,
        '',
    ];

    if (!pageData.valid) {
        lines.push(
            `> Página ${pageData.page} não existe.`,
            `> Use: ${prefix}inventario pagina ${pageData.totalPages}`
        );
        return lines.join('\n');
    }

    if (!pageData.items.length) {
        lines.push('> Você ainda não possui itens registrados.');
        return lines.join('\n');
    }

    pageData.items.forEach((item, localIndex) => {
        const globalIndex = pageData.start + localIndex + 1;
        const quantity = Number(item.quantity || 1);
        const useMarker = getItemUseHint(item, prefix) ? ' · usável' : '';
        lines.push(`*${globalIndex}. ${item.item_name}* · ${quantity}x${useMarker}`);
    });

    lines.push(
        '',
        section('◆', '𝗔𝗯𝗿𝗶𝗿'),
        '',
        `> ${prefix}inventario detalhe <número>`,
        `> ${prefix}inventario completo`,
    );

    const navigation = [];
    if (pageData.page > 1) navigation.push(`${prefix}inventario pagina ${pageData.page - 1}`);
    if (pageData.page < pageData.totalPages) navigation.push(`${prefix}inventario pagina ${pageData.page + 1}`);
    if (navigation.length) lines.push(`> ${navigation.join('  ·  ')}`);

    return lines.join('\n');
}

function renderInventoryDetail(summary, result, { prefix = '.#' } = {}) {
    if (!result?.ok) {
        return [
            '*♧┃𝐈𝐓𝐄𝐌 𝐍𝐀̃𝐎 𝐄𝐍𝐂𝐎𝐍𝐓𝐑𝐀𝐃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            `> O inventário possui ${Number(result?.totalRecords || 0)} registro(s).`,
            `> Use: ${prefix}inventario`,
        ].join('\n');
    }

    const item = result.item;
    const hint = getItemUseHint(item, prefix);
    const lines = [
        '*♧┃𝐈𝐓𝐄𝐌 𝐃𝐎 𝐈𝐍𝐕𝐄𝐍𝐓𝐀́𝐑𝐈𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  detalhe registrado  ──',
        '',
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${getPlayerName(summary.player)}`,
        `*𝐈𝐭𝐞𝐦 ${result.position}:* ${item.item_name}`,
        `*𝐐𝐮𝐚𝐧𝐭𝐢𝐝𝐚𝐝𝐞:* ${Number(item.quantity || 1)}`,
    ];
    if (item.category) lines.push(`*𝐂𝐚𝐭𝐞𝐠𝐨𝐫𝐢𝐚:* ${item.category}`);
    if (item.quality) lines.push(`*𝐐𝐮𝐚𝐥𝐢𝐝𝐚𝐝𝐞:* ${item.quality}`);
    if (Number(item.reference_price || 0) > 0) {
        lines.push(`*𝐕𝐚𝐥𝐨𝐫 𝐝𝐞 𝐫𝐞𝐟𝐞𝐫𝐞̂𝐧𝐜𝐢𝐚:* ${formatYulls(item.reference_price)}`);
    }
    const condition = itemConditionLabel(item);
    if (condition) {
        lines.push(`*𝐂𝐨𝐧𝐝𝐢𝐜̧𝐚̃𝐨:* ${condition} · ${Number(item.durability_current)}/${Number(item.durability_max)}`);
    }
    if (item.bound) lines.push('*𝐕𝐢́𝐧𝐜𝐮𝐥𝐨:* ligado ao personagem');
    if (item.expires_at) lines.push(`*𝐕𝐚𝐥𝐢𝐝𝐚𝐝𝐞:* ${item.expires_at}`);
    lines.push(
        '',
        section('◆', '𝗗𝗲𝘀𝗰𝗿𝗶𝗰̧𝗮̃𝗼'),
        '',
        `> ${display(item.description, 'Nenhuma descrição registrada.')}`,
    );
    if (hint) lines.push('', `*𝐔𝐬𝐨:* ${hint}`);
    return lines.join('\n');
}

module.exports = {
    appearanceStatusLabel,
    display,
    fichaStatusLabel,
    formatItemLine,
    formatNumber,
    getItemUseHint,
    itemConditionLabel,
    renderInventoryDetail,
    renderInventoryFull,
    renderInventoryPage,
    renderProfileCompact,
    renderProfileFull,
    storyStatusLabel,
};
