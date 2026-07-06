const { COMMAND_PREFIX } = require('../config/bot');
const arvoresCommand = require('./arvores');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const { getPlayerTechnicalCapacity } = require('../helpers/clover/capacityService');
const { getTreeState } = require('../helpers/clover/skillTreeService');

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function header(title, subtitle) {
    return [
        `*♧┃${title} 𖥔 CLOVER MULTICOLOR*`,
        `     ── ${subtitle} ──`,
    ];
}

function command(commandText, description) {
    return [
        `*̣${commandText}*`,
        `> ${description}`,
    ];
}

function roman(level) {
    return ['', 'I', 'II', 'III', 'IV', 'V'][Number(level || 0)] || String(level || '');
}

function percent(level) {
    return [0, 10, 20, 30, 40][Number(level || 0)] || 0;
}

function renderPhysicalGuide() {
    return [
        ...header('ÁRVORE FÍSICA', 'escolha pelo que você quer fazer'),
        '',
        section('◆', '𝑪𝒂𝒎𝒊𝒏𝒉𝒐𝒔'),
        '',
        '*𝑩𝒂𝒕𝒆𝒓, 𝒆𝒎𝒑𝒖𝒓𝒓𝒂𝒓, 𝒒𝒖𝒆𝒃𝒓𝒂𝒓, 𝒔𝒆𝒈𝒖𝒓𝒂𝒓:*',
        '> Vigor → Força Aplicada.',
        '*𝑨𝒈𝒖𝒆𝒏𝒕𝒂𝒓 𝒅𝒐𝒓, 𝒕𝒓𝒂𝒏𝒄𝒐 𝒆 𝒇𝒂𝒅𝒊𝒈𝒂:*',
        '> Vigor → Resistência Corporal ou Condicionamento Físico.',
        '*𝑪𝒐𝒓𝒓𝒆𝒓, 𝒇𝒖𝒈𝒊𝒓, 𝒑𝒆𝒓𝒔𝒆𝒈𝒖𝒊𝒓, 𝒓𝒆𝒑𝒐𝒔𝒊𝒄𝒊𝒐𝒏𝒂𝒓:*',
        '> Controle Corporal → Mobilidade.',
        '*𝑹𝒆𝒂𝒈𝒊𝒓, 𝒆𝒔𝒒𝒖𝒊𝒗𝒂𝒓, 𝒂𝒋𝒖𝒔𝒕𝒂𝒓 𝒐 𝒄𝒐𝒓𝒑𝒐:*',
        '> Controle Corporal → Reflexos Corporais.',
        '*𝑨𝒄𝒆𝒓𝒕𝒂𝒓 𝒃𝒓𝒆𝒄𝒉𝒂, 𝒑𝒐𝒏𝒕𝒐 𝒇𝒓𝒂𝒄𝒐 𝒐𝒖 𝒅𝒆𝒔𝒂𝒓𝒎𝒆:*',
        '> Controle Corporal → Precisão Técnica.',
        '*𝑷𝒆𝒓𝒄𝒆𝒃𝒆𝒓 𝒄𝒐𝒓𝒑𝒐, 𝒔𝒐𝒎, 𝒄𝒉𝒆𝒊𝒓𝒐, 𝒑𝒓𝒆𝒔𝒔𝒂̃𝒐:*',
        '> Percepção Física → Sentidos ou Intuição Corporal.',
        '',
        section('■', '𝑼𝒔𝒂𝒓'),
        '',
        ...command(`${COMMAND_PREFIX}fisico meus`, 'Ver o seu estado físico atual.'),
        ...command(`${COMMAND_PREFIX}fisico proximos`, 'Ver os próximos nós físicos.'),
        ...command(`${COMMAND_PREFIX}arvore fisico`, 'Ver a imagem completa.'),
        ...command(`${COMMAND_PREFIX}guia fisico`, 'Ler a explicação da árvore.'),
    ].join('\n');
}

function pushPhysicalLine(lines, label, level, text) {
    if (!level) return;
    lines.push(`*${label}:* ${roman(level)}`, `> +${percent(level)}% ${text}`);
}

function renderOwnedPhysical(capacity) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const physical = capacity.physical || {};
    const levels = physical.levels || {};
    const senseLabels = {
        visao: 'Visão',
        audicao: 'Audição',
        olfato: 'Olfato',
        tato: 'Tato',
        paladar: 'Paladar',
        intuicao: 'Intuição Corporal',
    };
    const senseEntries = Object.entries(levels.senses || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${senseLabels[key] || key} ${roman(level)}`);
    const identityEntries = Object.entries(levels.identities || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => {
            const labels = {
                barbarian: 'Bárbaro',
                tyrant: 'Tirano',
                benevolent: 'Benevolente',
                cult: 'Culto',
                just: 'Justo',
                unjust: 'Injusto',
                instinct: 'Instinto',
            };
            return `${labels[key] || key} ${roman(level)}`;
        });

    const lines = [
        ...header('FÍSICO ATUAL', 'leitura do seu corpo treinado'),
        '',
        section('✓', '𝑬𝒔𝒕𝒂𝒅𝒐'),
        '',
        `*𝑷𝒆𝒓𝒔𝒐𝒏𝒂𝒈𝒆𝒎:* ${capacity.displayName || 'Personagem'}`,
        `*𝑬𝒔𝒕𝒂́𝒈𝒊𝒐:* ${capacity.stageName || '-'}`,
        `*𝑵𝒐́𝒔 𝑭𝒊́𝒔𝒊𝒄𝒐𝒔:* ${Number(capacity.treeSummaries?.fisico?.count || 0)}`,
        '',
        section('◆', '𝑳𝒊𝒏𝒉𝒂𝒔 𝑪𝒐𝒎 𝑩𝒐̂𝒏𝒖𝒔'),
        '',
    ];

    const beforeLength = lines.length;
    pushPhysicalLine(lines, '𝑭𝒐𝒓𝒄̧𝒂 𝑨𝒑𝒍𝒊𝒄𝒂𝒅𝒂', levels.strength, 'em golpe, empurrão, puxão, quebra de postura e disputa física.');
    pushPhysicalLine(lines, '𝑹𝒆𝒔𝒊𝒔𝒕𝒆̂𝒏𝒄𝒊𝒂 𝑪𝒐𝒓𝒑𝒐𝒓𝒂𝒍', levels.resistance, 'em dor, tranco, postura, durabilidade física e continuar sob pressão.');
    pushPhysicalLine(lines, '𝑪𝒐𝒏𝒅𝒊𝒄𝒊𝒐𝒏𝒂𝒎𝒆𝒏𝒕𝒐 𝑭𝒊́𝒔𝒊𝒄𝒐', levels.conditioning, 'em fôlego, ritmo, retomada e esforço prolongado.');
    pushPhysicalLine(lines, '𝑴𝒐𝒃𝒊𝒍𝒊𝒅𝒂𝒅𝒆', levels.mobility, 'em avanço, recuo, perseguição, fuga e reposicionamento.');
    pushPhysicalLine(lines, '𝑹𝒆𝒇𝒍𝒆𝒙𝒐𝒔 𝑪𝒐𝒓𝒑𝒐𝒓𝒂𝒊𝒔', levels.reflexes, 'em reação, esquiva, ajuste corporal e troca de direção.');
    pushPhysicalLine(lines, '𝑷𝒓𝒆𝒄𝒊𝒔𝒂̃𝒐 𝑻𝒆́𝒄𝒏𝒊𝒄𝒂', levels.precision, 'em brecha real, ponto certo, desarme, entrada limpa e punição de abertura.');
    if (lines.length === beforeLength) lines.push('> Nenhuma linha com bônus comprada ainda.');

    lines.push('', section('✦', '𝑳𝒆𝒊𝒕𝒖𝒓𝒂'));
    lines.push('');
    lines.push(senseEntries.length ? `*𝑺𝒆𝒏𝒕𝒊𝒅𝒐𝒔:* ${senseEntries.join(', ')}` : '*𝑺𝒆𝒏𝒕𝒊𝒅𝒐𝒔:* nenhum');
    lines.push('> Sentidos dão alcance narrativo, qualidade de leitura e permissão de percepção, não porcentagem.');
    lines.push(identityEntries.length ? `*𝑰𝒅𝒆𝒏𝒕𝒊𝒅𝒂𝒅𝒆:* ${identityEntries.join(', ')}` : '*𝑰𝒅𝒆𝒏𝒕𝒊𝒅𝒂𝒅𝒆:* nenhuma');
    lines.push('> Identidades mudam a leitura da postura física em combate.');
    lines.push('', section('!', '𝑵𝒂̃𝒐 𝑭𝒂𝒛'));
    lines.push('');
    lines.push('> Não aumenta magia criada.');
    lines.push('> Não melhora projétil mágico.');
    lines.push('> Não substitui Estilo de Luta, arma específica ou golpe personalizado.');
    lines.push('> Não dá acerto automático.');

    return lines.join('\n');
}

function nodeCost(item) {
    const cost = Number(item?.effectiveCost ?? item?.node?.cost ?? 0);
    return `${cost} PH`;
}

function nodeStatus(item) {
    const labels = {
        available: 'disponível',
        no_ph: 'sem PH',
        approval: 'aprovação narrativa',
        locked: 'bloqueado',
    };
    return labels[item?.status] || item?.status || 'bloqueado';
}

async function renderNextPhysical(db, playerId) {
    const state = await getTreeState(db, playerId, 'fisico');
    const items = [
        ...state.availableNodes,
        ...state.nodeStates.filter((item) => ['no_ph', 'approval', 'locked'].includes(item.status)),
    ].slice(0, 6);

    const lines = [
        ...header('PRÓXIMOS NÓS FÍSICOS', 'caminhos disponíveis e próximos passos'),
        '',
        section('✓', '𝑹𝒆𝒔𝒖𝒎𝒐'),
        '',
        `*𝑷𝑯 𝒅𝒊𝒔𝒑𝒐𝒏𝒊́𝒗𝒆𝒍:* ${state.ph.phAvailable}`,
        `*𝑷𝒓𝒐𝒈𝒓𝒆𝒔𝒔𝒐:* ${state.ownedCount}/${state.totalNodes} nós`,
        '',
        section('✦', '𝑵𝒐́𝒔'),
        '',
    ];

    if (!items.length) {
        lines.push('> Nenhum próximo nó calculado agora.');
    } else {
        for (const item of items) {
            lines.push(
                `*${item.node.name}* \`${nodeCost(item)} · ${nodeStatus(item)}\``,
                `> ${item.node.metadata?.playerSummary || item.node.shortEffect || item.node.effect}`
            );
        }
    }

    lines.push(
        '',
        section('■', '𝑼𝒔𝒂𝒓'),
        '',
        ...command(`${COMMAND_PREFIX}no fisico <no>`, 'Ver detalhes.'),
        ...command(`${COMMAND_PREFIX}comprar fisico <no>`, 'Comprar um nó disponível.'),
    );

    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}fisico`,
    aliases: [`${COMMAND_PREFIX}físico`],
    gameCommand: true,
    descricao: 'Guia rápido e atalhos da Árvore Física oficial.',
    executar: async (context) => {
        const tokens = splitBody(context.body);
        const subcommand = normalizeText(tokens[0] || '');

        if (subcommand === 'comprar') {
            await arvoresCommand.executar({
                ...context,
                matchedCommand: `${COMMAND_PREFIX}comprar`,
                body: ['fisico', ...tokens.slice(1)].join(' ').trim(),
            });
            return;
        }

        if (['arvore', 'árvore', 'imagem', 'visual'].includes(subcommand)) {
            await arvoresCommand.executar({
                ...context,
                matchedCommand: `${COMMAND_PREFIX}arvore`,
                body: ['fisico', ...tokens.slice(1)].join(' ').trim(),
            });
            return;
        }

        if (['no', 'nó', 'detalhe', 'detalhes'].includes(subcommand)) {
            await arvoresCommand.executar({
                ...context,
                matchedCommand: `${COMMAND_PREFIX}no`,
                body: ['fisico', ...tokens.slice(1)].join(' ').trim(),
            });
            return;
        }

        if (['meus', 'meu', 'atual', 'status'].includes(subcommand)) {
            const capacity = await getPlayerTechnicalCapacity(context.db, context.idJogador);
            await sendReply({
                sock: context.sock,
                idChat: context.idChat,
                m: context.m,
                text: renderOwnedPhysical(capacity),
            });
            return;
        }

        if (['proximos', 'próximos', 'proximo', 'próximo'].includes(subcommand)) {
            await sendReply({
                sock: context.sock,
                idChat: context.idChat,
                m: context.m,
                text: await renderNextPhysical(context.db, context.idJogador),
            });
            return;
        }

        await sendReply({
            sock: context.sock,
            idChat: context.idChat,
            m: context.m,
            text: renderPhysicalGuide(),
        });
    },
};
