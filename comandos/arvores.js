const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const {
    cancelPendingPurchase,
    confirmPendingPurchase,
    createPendingPurchase,
    getNodeDetails,
    getTreeState,
    resolveRouteAlias,
    routeLabel,
} = require('../helpers/clover/skillTreeService');
const { renderTreeVisualPngCached } = require('../helpers/clover/treeVisualRenderer');
const { getTree } = require('../helpers/clover/treeLoader');
const { normalizeText } = require('../helpers/textUtils');
const {
    renderNodeNotFoundMessage,
    renderTreeNotFoundMessage,
} = require('../helpers/clover/playerMenuMessages');

const STATUS_LABELS = {
    owned: 'Comprado',
    available: 'Disponível',
    locked: 'Bloqueado',
    no_ph: 'Sem PH',
    approval: 'Aprovação narrativa',
};

const STATUS_ICONS = {
    owned: '◆',
    available: '✦',
    locked: '◇',
    no_ph: '◈',
    approval: '✧',
};

const MANA_COMPACT_TEXT_TREE = [
    '*Mapa textual oficial*',
    '```',
    'MANA',
    '├─ Percepção de Mana',
    '│  ├─ Sentir Mana I',
    '│  │  ├─ Sentir Mana II',
    '│  │  │  └─ Sentir Mana III',
    '│  ├─ Leitura de Flutuação',
    '│  ├─ Assinatura Mágica',
    '│  └─ Campo de Mana I',
    '│     ├─ Campo de Mana II',
    '│     └─ Campo de Mana III',
    '│',
    '├─ Fluxo de Mana',
    '│  ├─ Circulação',
    '│  ├─ Estabilidade',
    '│  ├─ Canalização',
    '│  ├─ Ritmo de Mana',
    '│  ├─ Pele de Mana I',
    '│  │  ├─ Pele de Mana II',
    '│  │  └─ Pele de Mana III',
    '│  ├─ Controle Fino I',
    '│  │  ├─ Controle Fino II',
    '│  │  └─ Controle Fino III',
    '│  ├─ Compressão de Mana',
    '│  ├─ Manto de Mana',
    '│  ├─ Voo de Vassoura',
    '│  ├─ Revestimento de Objeto',
    '│  └─ Manutenção Simultânea',
    '│',
    '├─ Retenção de Mana',
    '│  ├─ Economia I',
    '│  │  ├─ Economia II',
    '│  │  └─ Economia III',
    '│  ├─ Recuperação I',
    '│  │  ├─ Recuperação II',
    '│  │  └─ Recuperação III',
    '│  ├─ Ocultação de Mana',
    '│  └─ Núcleo de Mana',
    '│',
    '├─ Emissão de Mana',
    '│  ├─ Bala de Mana I',
    '│  │  ├─ Bala de Mana II',
    '│  │  └─ Bala de Mana III',
    '│  ├─ Pulso de Mana I',
    '│  │  ├─ Pulso de Mana II',
    '│  │  └─ Pulso de Mana III',
    '│  └─ Pressão de Mana',
    '│',
    '├─ Mana Ambiente',
    '│  ├─ Leitura Ambiental',
    '│  ├─ Adaptação Ambiental',
    '│  ├─ Mana Ambiente I',
    '│  │  ├─ Mana Ambiente II',
    '│  │  └─ Mana Ambiente III',
    '│  └─ Ressonância',
    '│',
    '└─ Maestria de Mana',
    '   ├─ Condutor',
    '   ├─ Reservatório',
    '   ├─ Dominador',
    '   ├─ Método de Mana',
    '   ├─ Zona de Mana I',
    '   │  ├─ Zona de Mana II',
    '   │  └─ Zona de Mana III',
    '   └─ Domínio de Mana',
    '```',
    '',
    '*Pesos de mana pura*',
    '> Bala I/II/III: Peso 2/4/6.',
    '> Pulso I/II/III: Peso 2/4/6.',
    '> Pele de Mana ativa: Peso 2.',
    '> Manto de Mana ativo: Peso 5.',
    '> O Hexágono limita alcance, duração, pressão, emissão e controle.',
];

const FISICO_TEXT_TREE = [
    '*Mapa textual oficial*',
    '```',
    'Físico',
    '├─ Vigor',
    '│  ├─ Força Aplicada I -> II -> III -> IV',
    '│  ├─ Resistência Corporal I -> II -> III -> IV',
    '│  └─ Condicionamento Físico I -> II -> III -> IV',
    '├─ Controle Corporal',
    '│  ├─ Mobilidade I -> II -> III -> IV',
    '│  ├─ Reflexos Corporais I -> II -> III -> IV',
    '│  └─ Precisão Técnica I -> II -> III -> IV',
    '├─ Percepção Física',
    '│  ├─ Visão I -> II -> III -> IV -> V',
    '│  ├─ Audição I -> II -> III -> IV -> V',
    '│  ├─ Olfato I -> II -> III -> IV -> V',
    '│  ├─ Tato I -> II -> III -> IV -> V',
    '│  ├─ Paladar I -> II -> III -> IV -> V',
    '│  └─ Intuição Corporal I -> II -> III -> IV -> V',
    '├─ Bárbaro I -> Bárbaro II',
    '│  ├─ Tirano I -> Tirano II',
    '│  └─ Benevolente I -> Benevolente II',
    '├─ Culto I -> Culto II',
    '│  ├─ Justo I -> Justo II',
    '│  └─ Injusto I -> Injusto II',
    '├─ Instinto I -> Instinto II',
    '├─ Contra Magos',
    '├─ Ki',
    '├─ Zetten',
    '└─ Ápice Físico',
    '```',
    '',
    '*Regra de leitura*',
    '> Linhas físicas comuns: I/II/III/IV = +10/+20/+30/+40%.',
    '> Sentidos e Intuição: I a V, sem bônus numérico; começam em 35 PH.',
    '> Nível II libera caminhos básicos; III libera marcos fortes; IV é domínio.',
    '> Não concede Estilo de Luta, arma, golpe personalizado ou antimagia.',
    '> Ki, Zetten e Ápice Físico exigem aprovação narrativa.',
];

function resolveAction(matchedCommand) {
    const command = normalizeText(matchedCommand || '');
    if (command.includes('arvores') || command.includes('árvores')) return 'menu';
    if (command.includes('confirmarcompra')) return 'confirm';
    if (command.includes('cancelarcompra')) return 'cancel';
    if (command.includes('comprar')) return 'buy';
    if (command.includes('rota')) return 'route';
    if (command.includes('no') || command.includes('nó')) return 'node';
    if (command.includes('arvore') || command.includes('árvore')) return 'tree';
    return 'menu';
}

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

const TREE_TAIL_FILLERS = new Set(['arvore', 'árvore', 'no', 'nó', 'node', 'habilidade']);

function stripTreeTailFillers(parts) {
    return parts.filter((part) => !TREE_TAIL_FILLERS.has(normalizeText(part)));
}

function parseTreeAndTail(body, defaultTree = 'mana', options = {}) {
    const parts = stripTreeTailFillers(splitBody(body));
    if (!parts.length) return { treeId: defaultTree, tail: '' };

    const firstTree = getTree(parts[0]);
    if (firstTree && parts.length > 1) {
        return { treeId: firstTree.id, tail: parts.slice(1).join(' ') };
    }

    if (firstTree && parts.length === 1) {
        return { treeId: firstTree.id, tail: options.baseFallback ? firstTree.id : '' };
    }

    return { treeId: defaultTree, tail: parts.join(' ') };
}

function parseTreeViewArgs(body) {
    const parts = splitBody(body);
    const normalizedParts = parts.map((part) => normalizeText(part));
    const textOnly = normalizedParts.some((part) => part === 'texto');
    const complete = normalizedParts.some((part) => ['completa', 'completo', 'complete'].includes(part));
    const summary = normalizedParts.some((part) => ['resumo', 'compacta', 'compacto', 'compact'].includes(part));
    const filtered = parts.filter((part, index) => (
        normalizedParts[index] !== 'texto'
        && !['completa', 'completo', 'complete'].includes(normalizedParts[index])
        && !['resumo', 'compacta', 'compacto', 'compact'].includes(normalizedParts[index])
    ));
    return {
        treeId: filtered[0] || (textOnly || complete || summary ? 'mana' : null),
        textOnly,
        visualMode: complete ? 'complete' : 'compact',
    };
}

function isMagicTreeVisualAlias(value) {
    const normalized = normalizeText(value || '');
    return ['magia', 'magic', 'arvore de magia', 'arvore magia'].includes(normalized);
}

function renderApprovedMagicTreeText() {
    return [
        '*ARVORE DE MAGIA*',
        '',
        'Use as arvores separadas abaixo para consultar cada caminho:',
        '',
        `${COMMAND_PREFIX}arvore suporte`,
        `${COMMAND_PREFIX}arvore criacao`,
        `${COMMAND_PREFIX}arvore reforco`,
        '',
        `Use *${COMMAND_PREFIX}arvores* para abrir o menu.`,
    ].join('\n');
}

function formatStatus(status) {
    return `${STATUS_ICONS[status] || '•'} ${STATUS_LABELS[status] || status}`;
}

function formatNodeLine(item) {
    const node = item.node;
    const suffix = item.status === 'owned'
        ? 'Comprado'
        : `${STATUS_LABELS[item.status] || item.status} · ${Number(node.cost || 0)} PH`;
    return `${STATUS_ICONS[item.status] || '·'} *${node.name}*\n> ${suffix}`;
}

function renderTreesMenu() {
    return [
        '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄𝐒 𝐃𝐄 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒𝐎',
        '     ──  cαmınhos dᥱ ᥱvoluçα̃o  ──',
        '',
        'Escolhα umα άrvorᥱ pαrα consultαr:',
        '',
        '──  𝐌𝐀𝐍𝐀  ──',
        '',
        '*̣.#arvore mana*',
        '> Técnıcαs dᥱ mαnıpulαçα̃o, lᥱıturα, ᥱmıssα̃o ᥱ sustᥱntαçα̃o dᥱ Mαnα.',
        '',
        '──  𝐌𝐀𝐆𝐈𝐀  ──',
        '',
        '*̣.#arvore suporte*',
        '> Efᥱıtos, condıçõᥱs, prαgαs, bᥱnçα̃os, curα, buff ᥱ trαnsmıssα̃o.',
        '',
        '*̣.#arvore criacao*',
        '> Mαnıfᥱstαçα̃o mάgıcα, formαs, ᥱstruturα, dᥱnsıdαdᥱ ᥱ prᥱcısα̃o.',
        '',
        '*̣.#arvore reforco*',
        '> Buff mάgıco no corpo, αtrıbutos físıcos ᥱ rᥱforço αvαnçαdo.',
        '',
        '──  𝐂𝐎𝐍𝐒𝐔𝐋𝐓𝐀 𝐃𝐄 𝐍𝐎́  ──',
        '',
        '*̣.#no <arvore> <no>*',
        '> Vᥱ α dᥱscrıçα̃o dᥱ um nó.',
        '',
        '*̣.#comprar <arvore> <no>*',
        '> Inıcıα α comprα dᥱ um nó.',
        '',
        'ⓘ Exemplo:',
        '*̣.#no mana bala-de-mana-i*',
    ].join('\n');
}

function renderSupportPurchaseBlocked() {
    return [
        '♧ 𝐒𝐔𝐏𝐎𝐑𝐓𝐄 𝐄𝐌 𝐑𝐄𝐕𝐈𝐒𝐀̃𝐎',
        '',
        'A árvore de Suporte já pode ser consultada.',
        'Mas compra por comando ainda está bloqueada até o balanceamento final.',
        '',
        '──  𝐔𝐒𝐄  ──',
        '',
        `*̣${COMMAND_PREFIX}arvore suporte*`,
        '> Para ver o visual.',
        '',
        `*̣${COMMAND_PREFIX}no suporte <no>*`,
        '> Para ver a descrição de um nó.',
    ].join('\n');
}

function renderSection(title) {
    return `     *──  ${title}  ──*`;
}

function statusDetail(item) {
    if (!item?.node) return STATUS_LABELS[item?.status] || 'Bloqueado';
    if (item.status === 'owned') return 'Comprado';
    return `${STATUS_LABELS[item.status] || item.status} · ${Number(item.node.cost || 0)} PH`;
}

function findNextRouteStep(state, routeId) {
    const nodeStatesById = Object.fromEntries(state.nodeStates.map((item) => [item.node.id, item]));
    return sortRouteNodes(state.tree.nodes.filter((node) => (
        node.route === routeId && !(node.tags || []).includes('convergencia')
    )))
        .map((node) => nodeStatesById[node.id])
        .find((item) => item?.status !== 'owned') || null;
}

function renderTreeTextOverview(state) {
    const nodeStatesById = Object.fromEntries(state.nodeStates.map((item) => [item.node.id, item]));
    const tree = state.tree;
    const milestoneNodes = tree.nodes.filter((node) => (
        (node.tags || []).some((tag) => ['convergencia', 'juncao', 'avancado'].includes(tag))
    )).slice(0, 8);

    const lines = [
        `♧┃${tree.name.toUpperCase()} 𖥔 Clover`,
        `     ──  ${tree.subtitle || 'rotas, selos e progressão'}  ──`,
        '',
        `*PH disponível:* ${state.ph.phAvailable}`,
        `*PH acumulado:* ${state.ph.phAccumulated}`,
        `*Estágio:* ${state.ph.stageName}`,
        `*Progresso:* ${state.ownedCount}/${state.totalNodes} nós`,
        '',
    ];

    if (tree.id === 'mana') {
        lines.push(...MANA_COMPACT_TEXT_TREE, '');
    }

    lines.push(renderSection('ROTAS PRINCIPAIS'), '');

    for (const progress of state.routeProgress.filter((item) => item.route.id !== 'base')) {
        const route = progress.route;
        const next = findNextRouteStep(state, route.id);
        lines.push(
            `${route.symbol} *ROTA DA ${route.name.toUpperCase()}*`,
            route.shortDescription,
            `Progresso: ${progress.owned}/${progress.total}`,
            next ? `Próximo selo: *${next.node.name}*` : 'Próximo selo: rota base completa',
            next ? `> ${statusDetail(next)}` : '> Comprado',
            ''
        );
    }

    if (milestoneNodes.length) {
        lines.push(renderSection('MARCOS'), '');
    }
    for (const node of milestoneNodes) {
        const item = nodeStatesById[node.id];
        if (!item) continue;
        lines.push(
            `\`${routeLabel(tree, node.route)}\``,
            `> ${item.node.name} · ${statusDetail(item)}`,
            ''
        );
    }

    const suggestions = [
        ...state.availableNodes,
        ...state.nodeStates.filter((item) => item.status === 'no_ph' || item.status === 'locked' || item.status === 'approval'),
    ].slice(0, 4);

    lines.push(renderSection('PRÓXIMO PASSO'));
    if (!suggestions.length) {
        lines.push('', 'Nenhum próximo selo encontrado agora.');
    } else {
        const item = suggestions[0];
        lines.push(...[
            '',
            `*Próximo nó:* ${item.node.name}`,
            `*Status:* ${statusDetail(item)}`,
            item.missingRequirementLabels?.length ? `*Falta:* ${item.missingRequirementLabels.join(', ')}` : null,
            item.missingPh > 0 ? `*Falta:* ${item.missingPh} PH` : null,
            tree.id === 'suporte' ? '*Compra:* bloqueada até o balanceamento final.' : null,
            '',
            'Use:',
            `${COMMAND_PREFIX}rota ${tree.id} ${item.node.route}`,
            `${COMMAND_PREFIX}no ${tree.id} ${item.node.name}`,
            tree.id === 'suporte'
                ? null
                : (item.status === 'no_ph' ? `${COMMAND_PREFIX}ph` : `${COMMAND_PREFIX}comprar ${tree.id} ${item.node.name}`),
        ].filter(Boolean));
    }

    return lines.join('\n');
}

function renderTreeOverview(state) {
    return renderTreeTextOverview(state);
}

function renderTreeCaption(state, visualMode = 'compact') {
    return renderTreeCaptionClean(state, visualMode);
}

function sortRouteNodes(nodes) {
    return [...nodes].sort((left, right) => {
        if (Number(left.tier || 0) !== Number(right.tier || 0)) return Number(left.tier || 0) - Number(right.tier || 0);
        return Number(left.cost || 0) - Number(right.cost || 0);
    });
}

function routeLongDescription(route) {
    const descriptions = {
        percepcao: 'A Rota da Percepção ensina o personagem a sentir fluxos de mana, ler movimentos mágicos e perceber o campo ao redor.',
        fluxo: 'A Rota do Fluxo ensina o personagem a circular mana pelo corpo com estabilidade, resposta e menos quebra de controle.',
        emissao: 'A Rota da Emissão ensina o personagem a projetar mana para fora com pressão, forma e alcance.',
        retencao: 'A Rota da Retenção ensina o personagem a sustentar mana por mais tempo, reduzir desperdício e manter efeitos ativos.',
    };
    return route.description || descriptions[route.id] || route.shortDescription;
}

function renderRouteNextAdvice(item) {
    if (!item) return ['Rota sem próximo nó técnico agora.'];
    if (item.status === 'available') return ['Este selo já pode ser preparado para compra.'];
    if (item.status === 'no_ph') return ['Você ainda precisa de PH para iniciar esse passo.'];
    if (item.status === 'locked') return ['Ainda existem requisitos antes deste selo.'];
    if (item.status === 'approval') return ['Este selo exige aprovação narrativa antes da compra.'];
    return ['Este passo já foi comprado.'];
}

function renderRouteTextView(state, routeAlias) {
    const resolved = resolveRouteAlias(state.tree, routeAlias);
    if (!resolved.ok) {
        const options = resolved.matches?.map((route) => route.name) || resolved.suggestions || state.tree.routes.map((route) => route.name);
        return [
            'Não encontrei essa rota.',
            '',
            `Tente: ${options.join(', ')}.`,
        ].join('\n');
    }

    const route = resolved.route;
    const nodeStatesById = Object.fromEntries(state.nodeStates.map((item) => [item.node.id, item]));
    const routeNodes = sortRouteNodes(state.tree.nodes.filter((node) => (
        node.route === route.id && !(node.tags || []).includes('convergencia')
    )));
    const convergenceNodes = state.tree.nodes.filter((node) => (
        (node.tags || []).includes('convergencia')
        && node.requires.some((requiredId) => state.tree.nodesById[requiredId]?.route === route.id)
    ));
    const next = routeNodes.map((node) => nodeStatesById[node.id]).find((item) => item.status !== 'owned')
        || convergenceNodes.map((node) => nodeStatesById[node.id]).find((item) => item.status !== 'owned');
    const progress = state.routeProgress.find((item) => item.route.id === route.id);

    const lines = [
        ...treeMessageHeader(`𝐑𝐎𝐓𝐀 𝐃𝐀 ${treePrettyText(route.name).toUpperCase()}`, treeDisplayName(state.tree)),
        '',
        routeLongDescription(route),
        '',
        `*Leva a:* ${route.leadsTo.join(', ')}.`,
        `*Progresso:* ${progress?.owned || 0}/${progress?.total || routeNodes.length}`,
        '',
        treePrettySection('𝗖𝗮𝗺𝗶𝗻𝗵𝗼'),
        '',
    ];

    routeNodes.forEach((node, index) => {
        const item = nodeStatesById[node.id];
        const prefix = index === 0 ? `${route.symbol} ` : '   ╰─ ';
        lines.push(
            `${prefix}${STATUS_ICONS[item.status] || '·'} *${node.name}*`,
            `${index === 0 ? '  ' : '      '}> ${statusDetail(item)}`
        );
        if (index < routeNodes.length - 1) lines.push('   │');
    });

    lines.push('', treePrettySection('𝗖𝗼𝗻𝘃𝗲𝗿𝗴𝗲̂𝗻𝗰𝗶𝗮𝘀'), '');
    for (const node of convergenceNodes) {
        const item = nodeStatesById[node.id];
        const reqRoutes = [...new Set(node.requires.map((nodeId) => {
            const required = state.tree.nodesById[nodeId];
            return required ? routeLabel(state.tree, required.route) : nodeId;
        }))];
        lines.push(
            `\`${reqRoutes.join(' + ')}\``,
            `> ${node.name} · ${statusDetail(item)}`,
            ''
        );
    }

    lines.push(treePrettySection('𝗣𝗿𝗼́𝘅𝗶𝗺𝗼 𝗣𝗮𝘀𝘀𝗼'), '');
    if (next) {
        lines.push(...[
            `*Próximo nó:* ${next.node.name}`,
            `*Custo:* ${Number(next.node.cost || 0)} PH`,
            `*Status:* ${statusDetail(next)}`,
            next.missingRequirementLabels?.length ? `*Falta:* ${next.missingRequirementLabels.join(', ')}` : null,
            next.missingPh > 0 ? `*Falta:* ${next.missingPh} PH` : null,
            '',
            ...renderRouteNextAdvice(next),
            '',
            'Use:',
            next.status === 'no_ph' ? `${COMMAND_PREFIX}ph` : `${COMMAND_PREFIX}no ${state.tree.id} ${next.node.name}`,
        ].filter(Boolean));
    } else {
        lines.push('Rota sem próximo nó técnico agora.');
    }

    return lines.join('\n');
}

function renderRouteView(state, routeAlias) {
    return renderRouteTextView(state, routeAlias);

    const resolved = resolveRouteAlias(state.tree, routeAlias);
    if (!resolved.ok) {
        const options = resolved.matches?.map((route) => route.name) || resolved.suggestions || state.tree.routes.map((route) => route.name);
        return [
            'Não encontrei essa rota.',
            '',
            `Tente: ${options.join(', ')}`,
        ].join('\n');
    }

    const route = resolved.route;
    const nodeStatesById = Object.fromEntries(state.nodeStates.map((item) => [item.node.id, item]));
    const routeNodes = sortRouteNodes(state.tree.nodes.filter((node) => node.route === route.id));
    const convergenceNodes = state.tree.nodes.filter((node) => (
        (node.tags || []).includes('convergencia')
        && node.requires.some((requiredId) => state.tree.nodesById[requiredId]?.route === route.id)
    ));
    const next = routeNodes.map((node) => nodeStatesById[node.id]).find((item) => item.status !== 'owned')
        || convergenceNodes.map((node) => nodeStatesById[node.id]).find((item) => item.status !== 'owned');

    const lines = [
        `${route.symbol}┃ROTA DA ${route.name.toUpperCase()} 𖥔 Mana`,
        '',
        route.shortDescription,
        `Leva a: ${route.leadsTo.join(', ')}.`,
        '',
    ];

    routeNodes.forEach((node, index) => {
        const item = nodeStatesById[node.id];
        const prefix = index === 0 ? `${route.symbol} ` : '   └─ ';
        lines.push(`${prefix}${node.name} ${STATUS_ICONS[item.status] || '•'}${item.status === 'owned' ? '' : ` ${node.cost} PH`}`);
        if (index < routeNodes.length - 1) lines.push('   │');
    });

    lines.push('', 'Convergências desta rota:');
    for (const node of convergenceNodes) {
        const item = nodeStatesById[node.id];
        const reqs = node.requires.map((nodeId) => state.tree.nodesById[nodeId]?.name || nodeId).join(' + ');
        lines.push(`> ${reqs} → ${node.name} (${STATUS_LABELS[item.status]})`);
    }

    lines.push('', 'Próximo recomendado:');
    lines.push(next ? `> ${formatNodeLine(next)}` : '> Rota sem próximo nó técnico agora.');

    return lines.join('\n');
}

function renderResolutionProblem(result) {
    if (result.reason === 'ambiguous') {
        return [
            'Encontrei mais de um nó com esse nome.',
            '',
            ...result.matches.map((node) => `> ${node.name}`),
            '',
            'Use um nome mais específico.',
        ].join('\n');
    }

    const treeId = result.state?.tree?.id || 'mana';
    if (result.reason === 'not_found' || result.reason === 'missing_input') {
        return renderNodeNotFoundMessage();
    }

    return [
        'Não encontrei esse nó.',
        '',
        result.suggestions?.length ? `Talvez você queira: ${result.suggestions.join(', ')}.` : `Tente ver a árvore com ${COMMAND_PREFIX}arvore ${treeId}.`,
    ].join('\n');
}

function renderNodeDetails(result) {
    if (!result.ok) return renderResolutionProblem(result);

    const { node, nodeState, route, unlocks } = result;
    const technicalWeight = node.metadata?.technicalWeight;
    const missing = [
        ...(nodeState.missingRequirementLabels || []),
        nodeState.missingPh > 0 ? `${nodeState.missingPh} PH` : null,
        node.requiresApproval && nodeState.status === 'approval' ? 'aprovação narrativa' : null,
    ].filter(Boolean);

    return [
        `♧┃${node.name} 𖥔 ${result.state.tree.name}`,
        '',
        `*Rota:* ${route.symbol} ${route.name}`,
        `*Custo:* ${node.cost} PH`,
        `*Status:* ${formatStatus(nodeState.status)}`,
        '',
        `*Efeito curto:* ${node.shortEffect}`,
        `*Efeito:* ${node.effect}`,
        technicalWeight !== undefined ? `*Peso técnico:* ${technicalWeight}` : null,
        '',
        `*Requisitos:* ${node.requires.length ? node.requires.map((nodeId) => result.state.tree.nodesById[nodeId]?.name || nodeId).join(', ') : 'nenhum'}`,
        `*Faltando:* ${missing.length ? missing.join(', ') : 'nada'}`,
        `*Desbloqueia:* ${unlocks.length ? unlocks.map((item) => item.name).join(', ') : '-'}`,
        `*Requer aprovação:* ${node.requiresApproval ? 'sim' : 'não'}`,
    ].filter((line) => line !== null).join('\n');
}

function renderPurchaseBlocked(result) {
    if (!result.ok && ['ambiguous', 'not_found', 'missing_input'].includes(result.reason)) {
        return renderResolutionProblem(result);
    }

    const details = result.details || result;
    if (details.nodeState?.status === 'owned') {
        return `Você já comprou *${details.node.name}*.`;
    }
    if (details.nodeState?.status === 'approval') {
        return [
            `*${details.node.name}* requer aprovação narrativa.`,
            '',
            'Esse nó não pode ser comprado direto por comando.',
        ].join('\n');
    }
    if (details.nodeState?.status === 'no_ph') {
        return [
            `PH disponível insuficiente para *${details.node.name}*.`,
            '',
            `Custo: ${details.node.cost} PH`,
            `Falta: ${details.nodeState.missingPh} PH`,
        ].join('\n');
    }
    if (details.nodeState?.status === 'locked') {
        return [
            `*${details.node.name}* ainda está bloqueado.`,
            '',
            `Falta: ${details.nodeState.missingRequirementLabels.join(', ') || 'requisitos'}`,
        ].join('\n');
    }

    return 'Esse nó não está disponível para compra agora.';
}

function renderPurchasePreview(result) {
    const { details } = result;
    const after = Math.max(0, Number(details.state.ph.phAvailable || 0) - Number(details.node.cost || 0));
    return [
        'Compra pendente criada.',
        '',
        `*Nó:* ${details.node.name}`,
        `*Árvore:* ${details.state.tree.name}`,
        `*Custo:* ${details.node.cost} PH`,
        `*PH disponível:* ${details.state.ph.phAvailable} → ${after}`,
        '',
        `Confirme com *${COMMAND_PREFIX}confirmarcompra*.`,
        `Cancele com *${COMMAND_PREFIX}cancelarcompra*.`,
    ].join('\n');
}

function renderPurchaseSuccess(result) {
    return [
        'Nó comprado com sucesso.',
        '',
        `*Nó:* ${result.node.name}`,
        `*Árvore:* ${result.tree.name}`,
        `*PH disponível:* ${result.spend.before.phAvailable} → ${result.spend.after.phAvailable}`,
        `*PH acumulado:* ${result.spend.after.phAccumulated}`,
        `*Ledger:* #${result.spend.ledgerId}`,
    ].join('\n');
}

function renderConfirmFailure(result) {
    if (result.reason === 'missing_pending') {
        return `Não existe compra pendente. Use *${COMMAND_PREFIX}comprar <arvore> <nó>* primeiro.`;
    }
    if (result.reason === 'already_owned') {
        return `Você já possui *${result.node?.name || 'esse nó'}*.`;
    }
    if (result.reason === 'not_available') {
        return renderPurchaseBlocked(result);
    }
    return 'Não consegui confirmar essa compra agora.';
}

function uxSection(title) {
    return `──  ${title}  ──`;
}

function uxCommandNodeName(node) {
    return String(node?.id || node?.name || '').replace(/_/g, '-');
}

function uxStatusLabel(status, treeId = null) {
    const labels = {
        owned: 'Comprado',
        available: 'Disponivel',
        locked: 'Bloqueado',
        no_ph: 'Sem PH',
        approval: 'Aprovacao narrativa',
    };
    return labels[status] || status || 'Bloqueado';
}

function uxTypeLabel(value) {
    const labels = {
        base: 'base',
        rota: 'rota',
        tecnica: 'tecnica',
        tecnica_perigosa: 'tecnica perigosa',
        upgrade: 'upgrade',
        gateway: 'gateway',
        avancado: 'avancado',
        advanced: 'avancado',
        forbidden: 'proibido',
        proibido: 'proibido',
        topo: 'topo',
        permissao: 'permissao',
        permission: 'permissao',
    };
    return labels[value] || value || 'tecnica';
}

function uxRiskLabel(value) {
    const labels = {
        baixo: 'baixo',
        medio: 'medio',
        alto: 'alto',
        extremo: 'extremo',
    };
    return labels[value] || value || 'nao registrado';
}

function uxNarrativeLabel(value) {
    const labels = {
        livre: 'livre',
        treino: 'treino',
        treino_registrado: 'treino registrado',
        marco: 'marco narrativo',
        marco_narrativo: 'marco narrativo',
        marco_forte: 'marco narrativo forte',
        proibido_especial: 'proibido/especial',
    };
    return labels[value] || value || 'sem requisito narrativo registrado';
}

function uxRoman(index) {
    return ['I', 'II', 'III', 'IV', 'V'][index] || String(index + 1);
}

function uxBulletList(items, fallback) {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return `• ${fallback}`;
    return clean.map((item) => `• ${item}`).join('\n');
}

function uxRankDescription(node, index) {
    const metadata = node.metadata || {};
    if (Array.isArray(metadata.rankDescriptions) && metadata.rankDescriptions[index]) {
        return metadata.rankDescriptions[index];
    }
    if (index === 0) return 'acesso bruto / uso funcional inicial.';
    if (index === 1) return 'uso confiavel; costuma liberar caminhos seguintes.';
    if (index === 2) return 'dominio tecnico, refinamento ou uso forte.';
    return 'progressao adicional registrada para este caminho.';
}

function uxRankBlock(node) {
    const metadata = node.metadata || {};
    const rankCosts = Array.isArray(metadata.rankCosts) ? metadata.rankCosts : [];
    if (rankCosts.length) {
        const lines = [uxSection('RANKS')];
        rankCosts.forEach((cost, index) => {
            lines.push('', `*Rank ${uxRoman(index)}:* ${cost} PH`, `> ${uxRankDescription(node, index)}`);
        });
        if (metadata.rank) {
            lines.push('', `*Rank deste no:* ${uxRoman(Number(metadata.rank) - 1)} de ${metadata.maxRank || rankCosts.length}.`);
        }
        return lines.join('\n');
    }
    if (metadata.maxRank && Number(metadata.maxRank) > 1) {
        return [
            uxSection('RANK'),
            '',
            `*Rank maximo:* ${metadata.maxRank}`,
            metadata.rank ? `*Rank deste no:* ${uxRoman(Number(metadata.rank) - 1)}` : null,
        ].filter(Boolean).join('\n');
    }
    return [
        uxSection('RANK'),
        '',
        '*Nivel:* unico.',
    ].join('\n');
}

function uxNodeDescription(node) {
    return node.metadata?.playerSummary
        || node.shortEffect
        || node.effect
        || 'Sem descricao detalhada cadastrada ainda.';
}

function uxNodeTechnicalReading(node) {
    const parts = [
        node.metadata?.technicalSummary,
        node.effect,
        node.metadata?.technicalWeight !== undefined ? `Peso tecnico: ${node.metadata.technicalWeight}.` : null,
    ].filter(Boolean);
    return parts.length ? parts.join('\n\n') : 'Consulte a ADM para usos complexos.';
}

function uxNodeLimits(node, tree) {
    const metadata = node.metadata || {};
    const limits = [];
    if (metadata.notDoes) limits.push(metadata.notDoes);
    if (node.requiresApproval) limits.push('Usos complexos dependem de aprovacao narrativa da ADM.');
    if (metadata.risk === 'alto' || metadata.risk === 'extremo') {
        limits.push('Uso amplo, persistente ou decisivo precisa de cena, treino, marco ou justificativa.');
    }
    if (tree.id === 'criacao') limits.push('Criacao melhora manifestacao magica; nao buffa corpo.');
    if (tree.id === 'reforco') limits.push('Reforco melhora corpo, atributos fisicos ou aliados; nao melhora projetil/criacao magica comum sozinho.');
    if (tree.id === 'suporte') limits.push('Suporte nao cria efeito absoluto sozinho; condicoes, cura, praga e selos fortes dependem de limite e ADM.');
    if (tree.id === 'mana') limits.push('Mana nao ignora Hexagono, custo, alcance, duracao ou controle de cena.');
    return [...new Set(limits)].join('\n\n') || 'Sem limite especifico cadastrado ainda.';
}

function uxRequirementsBlock(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const requirements = node.requires.map((nodeId) => tree.nodesById[nodeId]?.name || nodeId);
    const missing = nodeState.missingRequirementLabels || [];
    const satisfied = nodeState.satisfiedRequirementLabels || [];
    const lines = [
        node.requires.length ? `• Mecanicos: ${requirements.join(', ')}` : '• Mecanicos: nenhum.',
        satisfied.length ? `• Ja cumpridos: ${satisfied.join(', ')}` : null,
        missing.length ? `• Faltando: ${missing.join(', ')}` : null,
        nodeState.missingPh > 0 ? `• PH faltando: ${nodeState.missingPh} PH.` : null,
        `• Narrativo: ${uxNarrativeLabel(node.metadata?.narrativeRequirement)}.`,
        node.requiresApproval ? '• Aprovacao narrativa: necessaria.' : '• Aprovacao narrativa: nao exigida para compra comum.',
    ].filter(Boolean);
    return lines.join('\n');
}

function uxUnlocksBlock(unlocks) {
    if (!unlocks?.length) return '• Nenhum caminho direto cadastrado.';
    return uxBulletList(unlocks.map((node) => `${node.name} (${node.cost} PH)`), 'Nenhum caminho direto cadastrado.');
}

function renderSupportPurchaseBlockedUx() {
    return [
        '♧ SUPORTE E APROVACAO',
        '',
        'A árvore de Suporte já pode ser comprada em nós básicos.',
        'Nós avançados ou sensíveis exigem aprovação narrativa da ADM.',
        '',
        'Use:',
        `*̣${COMMAND_PREFIX}arvore suporte*`,
        `*̣${COMMAND_PREFIX}no suporte <no>*`,
        `*̣${COMMAND_PREFIX}comprar suporte <no>*`,
    ].join('\n');
}

function renderNodePurchaseAdviceUx(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const command = `${COMMAND_PREFIX}comprar ${tree.id} ${uxCommandNodeName(node)}`;

    if (nodeState.status === 'owned') {
        return [
            uxSection('COMPRA'),
            '',
            'Voce ja possui este no.',
        ].join('\n');
    }
    if (nodeState.status === 'available') {
        return [
            uxSection('COMPRA'),
            '',
            `*̣${command}*`,
            '> Inicia a compra deste no.',
        ].join('\n');
    }
    if (nodeState.status === 'approval') {
        return [
            uxSection('APROVACAO'),
            '',
            'Este no exige aprovacao narrativa da ADM.',
            'A compra pode precisar de cena, treino, marco ou justificativa.',
        ].join('\n');
    }
    if (nodeState.status === 'no_ph') {
        return [
            uxSection('COMPRA'),
            '',
            `Este no exige ${node.cost} PH e voce ainda precisa de ${nodeState.missingPh} PH.`,
            '',
            `Use *̣${COMMAND_PREFIX}ph* para consultar seus Pontos de Habilidade.`,
        ].join('\n');
    }
    return [
        uxSection('COMPRA'),
        '',
        'Este no ainda nao pode ser comprado.',
        'Cumpra os requisitos acima primeiro.',
    ].join('\n');
}

function renderNodeDetailsUx(result) {
    if (!result.ok) return renderResolutionProblem(result);

    const { node, nodeState, route, unlocks } = result;
    const tree = result.state.tree;
    const metadata = node.metadata || {};

    return [
        '♧ NÓ DE ÁRVORE',
        `     ──  ${tree.name}  ──`,
        '',
        `*${node.name}*`,
        '',
        uxSection('STATUS'),
        '',
        `*Estado:* ${uxStatusLabel(nodeState.status, tree.id)}`,
        `*Arvore:* ${tree.name}`,
        `*Rota:* ${route?.symbol || ''} ${route?.name || node.route}`,
        `*Custo:* ${node.cost} PH`,
        `*Tipo:* ${uxTypeLabel(metadata.type)}`,
        `*Risco:* ${uxRiskLabel(metadata.risk)}`,
        '',
        uxRankBlock(node),
        '',
        uxSection('FUNCAO'),
        '',
        uxNodeDescription(node),
        '',
        uxSection('LEITURA TECNICA'),
        '',
        uxNodeTechnicalReading(node),
        '',
        uxSection('REQUISITOS'),
        '',
        uxRequirementsBlock(result),
        '',
        uxSection('LIMITES'),
        '',
        uxNodeLimits(node, tree),
        '',
        uxSection('PROXIMOS CAMINHOS'),
        '',
        uxUnlocksBlock(unlocks),
        '',
        renderNodePurchaseAdviceUx(result),
    ].join('\n');
}

function renderPurchaseBlockedUx(result) {
    if (!result.ok && ['ambiguous', 'not_found', 'missing_input'].includes(result.reason)) {
        return renderResolutionProblem(result);
    }

    const details = result.details || result;
    const tree = details.state?.tree || result.state?.tree || getTree('mana');
    const node = details.node;
    const nodeState = details.nodeState;

    if (nodeState?.status === 'owned') {
        return [
            '♧ NÓ JÁ COMPRADO',
            '',
            'Voce ja possui este no:',
            '',
            `*${tree.name} — ${node.name}*`,
            '',
            'Use:',
            `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
            '',
            'Para ver seu progresso.',
        ].join('\n');
    }
    if (nodeState?.status === 'approval') {
        return [
            '♧ APROVACAO NARRATIVA',
            '',
            `*${tree.name} — ${node.name}*`,
            '',
            'Este no exige aprovacao narrativa da ADM.',
            'A compra pode precisar de cena, treino, marco ou justificativa.',
            '',
            `Use *̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(node)}* para ver os detalhes.`,
        ].join('\n');
    }
    if (nodeState?.status === 'no_ph') {
        return [
            '♧ PH INSUFICIENTE',
            '',
            'Voce nao possui PH suficiente para comprar este no.',
            '',
            `*No:* ${node.name}`,
            `*Custo:* ${node.cost} PH`,
            `*PH disponivel:* ${details.state.ph.phAvailable} PH`,
            `*Falta:* ${nodeState.missingPh} PH`,
            '',
            'Use:',
            `*̣${COMMAND_PREFIX}ph*`,
            '',
            'Para consultar seus Pontos de Habilidade.',
        ].join('\n');
    }
    if (nodeState?.status === 'locked') {
        const firstMissing = nodeState.missingRequirements?.[0];
        const missingNode = firstMissing ? tree.nodesById[firstMissing] : null;
        return [
            '♧ NÓ BLOQUEADO',
            '',
            `*${tree.name} — ${node.name}*`,
            '',
            'Voce ainda nao cumpriu os requisitos deste no.',
            '',
            uxSection('FALTA'),
            '',
            uxBulletList(nodeState.missingRequirementLabels, 'requisitos anteriores'),
            '',
            'Use:',
            `*̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(missingNode || node)}*`,
            '',
            'Para entender o caminho anterior.',
        ].join('\n');
    }

    return [
        '♧ COMPRA INDISPONIVEL',
        '',
        'Esse no nao esta disponivel para compra agora.',
        '',
        node ? `Use *̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(node)}* para ver os detalhes.` : `Use *̣${COMMAND_PREFIX}arvores*.`,
    ].join('\n');
}

function renderPurchasePreviewUx(result) {
    const { details } = result;
    const after = Math.max(0, Number(details.state.ph.phAvailable || 0) - Number(details.node.cost || 0));
    const risk = details.node.metadata?.risk;
    const attention = [
        details.node.requiresApproval ? 'Este no exige aprovacao narrativa.' : null,
        risk === 'alto' || risk === 'extremo' ? 'Usos complexos deste no dependem de contexto e ADM.' : null,
    ].filter(Boolean);
    return [
        '♧ COMPRA PENDENTE',
        '',
        'Voce esta prestes a comprar:',
        '',
        `*Arvore:* ${details.state.tree.name}`,
        `*No:* ${details.node.name}`,
        `*Custo:* ${details.node.cost} PH`,
        `*PH disponivel:* ${details.state.ph.phAvailable} PH`,
        `*PH apos compra:* ${after} PH`,
        '',
        uxSection('O QUE ISSO LIBERA'),
        '',
        uxNodeDescription(details.node),
        '',
        uxSection('ATENCAO'),
        '',
        attention.length ? attention.join('\n') : 'Compra comum. Nenhuma aprovacao extra registrada para este no.',
        '',
        uxSection('CONFIRMAR'),
        '',
        `*̣${COMMAND_PREFIX}confirmarcompra*`,
        '> Confirma a compra.',
        `*̣${COMMAND_PREFIX}cancelarcompra*`,
        '> Cancela a compra.',
        '',
        'ⓘ Esta compra expira em 15 minutos.',
    ].join('\n');
}

function renderPurchaseSuccessUx(result) {
    const cost = Number(result.node.cost || result.pending?.metadata?.cost || 0);
    return [
        '♧ NÓ COMPRADO',
        '',
        'Voce comprou:',
        '',
        `*${result.tree.name} — ${result.node.name}*`,
        '',
        uxSection('PH'),
        '',
        `*Custo:* ${cost} PH`,
        `*PH restante:* ${result.spend.after.phAvailable} PH`,
        '',
        uxSection('NOVA CAPACIDADE'),
        '',
        uxNodeDescription(result.node),
        result.node.requiresApproval ? '\nUsos complexos deste no ainda dependem de aprovacao narrativa.' : null,
        '',
        'Use:',
        `*̣${COMMAND_PREFIX}capacidade*`,
        '> Para ver a leitura atualizada.',
    ].filter((line) => line !== null).join('\n');
}

function renderConfirmFailureUx(result) {
    if (result.reason === 'missing_pending') {
        return [
            ...treeMessageHeader('𝐍𝐄𝐍𝐇𝐔𝐌𝐀 𝐂𝐎𝐌𝐏𝐑𝐀 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄', 'confirmação vazia'),
            '',
            'Você não possui compra pendente para confirmar.',
            '',
            treePrettySection('𝗨𝘀𝗲'),
            `*̣${COMMAND_PREFIX}arvores*`,
            '> Ver os caminhos disponíveis.',
        ].join('\n');
    }
    if (result.reason === 'expired_pending') {
        return [
            ...treeMessageHeader('𝐂𝐎𝐌𝐏𝐑𝐀 𝐄𝐗𝐏𝐈𝐑𝐀𝐃𝐀', 'tempo de confirmação encerrado'),
            '',
            'Sua compra pendente expirou.',
            '',
            treePrettySection('𝗔𝗴𝗼𝗿𝗮'),
            `*̣${COMMAND_PREFIX}comprar <árvore> <nó>*`,
            '> Iniciar novamente.',
            '> Nenhum PH foi gasto.',
        ].join('\n');
    }
    if (result.reason === 'already_owned') {
        return [
            ...treeMessageHeader('𝐍𝐎́ 𝐉𝐀́ 𝐂𝐎𝐌𝐏𝐑𝐀𝐃𝐎', 'progresso registrado'),
            '',
            `Você já possui *${result.node?.name || 'esse nó'}*.`,
        ].join('\n');
    }
    if (result.reason === 'not_available') {
        return renderPurchaseBlockedUx(result);
    }
    return [
        ...treeMessageHeader('𝐂𝐎𝐌𝐏𝐑𝐀 𝐍𝐀̃𝐎 𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐃𝐀', 'tente novamente'),
        '',
        'Não consegui confirmar essa compra agora.',
    ].join('\n');
}

function renderCancelSuccessUx() {
    return [
        ...treeMessageHeader('𝐂𝐎𝐌𝐏𝐑𝐀 𝐂𝐀𝐍𝐂𝐄𝐋𝐀𝐃𝐀', 'pendência removida'),
        '',
        'A compra pendente foi cancelada.',
        '',
        'Nenhum PH foi gasto.',
    ].join('\n');
}

function renderCancelFailureUx() {
    return [
        ...treeMessageHeader('𝐍𝐄𝐍𝐇𝐔𝐌𝐀 𝐂𝐎𝐌𝐏𝐑𝐀 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄', 'nada para cancelar'),
        '',
        'Não existe compra pendente para cancelar.',
    ].join('\n');
}

function renderTreeCaptionClean(state, visualMode = 'compact') {
    const tree = state?.tree || getTree('mana') || { id: 'mana', name: 'Arvore de Mana', routes: [] };

    if (tree.id === 'suporte') {
        return [
            '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐒𝐔𝐏𝐎𝐑𝐓𝐄',
            '',
            'Enviando sua árvore de Suporte...',
            '',
            '──  𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐑𝐀́𝐏𝐈𝐃𝐀  ──',
            '',
            'Suporte trabalha efeitos, condições, transmissão, cura, buff, praga e interferência mágica.',
            '',
            'ⓘ A consulta está liberada.',
            'Compras de Suporte ficam bloqueadas até o balanceamento final.',
        ].join('\n');
    }

    if (tree.id === 'criacao') {
        return [
            '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐂𝐑𝐈𝐀𝐂̧𝐀̃𝐎',
            '',
            'Enviαndo suα άrvorᥱ dᥱ Crıαçα̃o...',
            '',
            '──  𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐑𝐀́𝐏𝐈𝐃𝐀  ──',
            '',
            'Crıαçα̃o ᥱ́ α mαnıfᥱstαçα̃o dα mαgıα.',
            '',
            'Elα melhorα:',
            '• formαs crıαdαs;',
            '• ᥱstruturα;',
            '• dᥱnsıdαdᥱ;',
            '• prᥱcısα̃o;',
            '• dᥱfᥱsα, vᥱlocıdαdᥱ ᥱ forçα dα mαnıfᥱstαçα̃o.',
            '',
            'ⓘ Crıαçα̃o nα̃o buffα o corpo.',
            'Isso ᥱ́ função dᥱ Rᥱforço.',
        ].join('\n');
    }

    if (tree.id === 'reforco') {
        return [
            '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐑𝐄𝐅𝐎𝐑𝐂̧𝐎',
            '',
            'Enviαndo suα άrvorᥱ dᥱ Rᥱforço...',
            '',
            '──  𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐑𝐀́𝐏𝐈𝐃𝐀  ──',
            '',
            'Rᥱforço ᥱ́ buff mάgıco no corpo.',
            '',
            'Elᥱ melhorα:',
            '• Forçα;',
            '• Vᥱlocıdαdᥱ;',
            '• Agılıdαdᥱ;',
            '• Rᥱsıstᥱ̂ncıα;',
            '• Dᥱfᥱsα;',
            '• buff ᥱm αlıαdos;',
            '• rᥱforço αvαnçαdo com formα.',
            '',
            'ⓘ Rᥱforço nα̃o buffα projétil ou crıαçα̃o mάgıcα.',
            'Isso ᥱ́ função dᥱ Crıαçα̃o.',
        ].join('\n');
    }

    return [
        '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐌𝐀𝐍𝐀',
        '',
        'Enviαndo suα άrvorᥱ dᥱ Mαnα...',
        '',
        'ⓘ A άrvorᥱ mostrα nós comprαdos, dısponívᥱıs ᥱ bloquᥱαdos.',
        'Pαrα vᥱr um nó:',
        '*̣.#no mana <no>*',
    ].join('\n');
}

function captionTitleForTreeV2(tree) {
    const titles = {
        mana: '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐌𝐀𝐍𝐀',
        suporte: '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐒𝐔𝐏𝐎𝐑𝐓𝐄',
        criacao: '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐂𝐑𝐈𝐀𝐂̧𝐀̃𝐎',
        reforco: '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐑𝐄𝐅𝐎𝐑𝐂̧𝐎',
    };
    return titles[tree.id] || `♧ ${String(tree.name || 'ARVORE').toUpperCase()}`;
}

function captionSubtitleForTreeV2(tree) {
    const subtitles = {
        mana: 'progrᥱsso ᥱ próxımos nós',
        suporte: 'ᥱfᥱıtos, condıçõᥱs ᥱ ıntᥱrfᥱrêncıα',
        criacao: 'formα, ᥱstruturα ᥱ mαnıfᥱstαçα̃o',
        reforco: 'corpo, αtrıbutos ᥱ buff',
    };
    return subtitles[tree.id] || 'progrᥱsso ᥱ próxımos nós';
}

function nodeCostLabelV2(node, compactRanks = false) {
    const rankCosts = node?.metadata?.rankCosts;
    if (compactRanks && Array.isArray(rankCosts) && rankCosts.length) {
        return `${rankCosts.join('/')} PH`;
    }
    return `${Number(node?.cost || 0)} PH`;
}

function nodeSummaryV2(node) {
    return String(
        node?.metadata?.playerSummary
        || node?.shortEffect
        || node?.effect
        || 'Sem resumo cadastrado ainda.'
    ).replace(/\s+/g, ' ').trim();
}

function captionNodeLinesV2(item, options = {}) {
    const node = item.node;
    const status = item.status && item.status !== 'available'
        ? ` · ${uxStatusLabel(item.status, options.treeId)}`
        : '';
    return [
        `*${node.name}* \`${nodeCostLabelV2(node, options.compactRanks)}${status}\``,
        `> ${nodeSummaryV2(node)}`,
    ];
}

function getCaptionCandidatesV2(state, limit = 4) {
    const tree = state.tree;
    if (tree.id === 'suporte') {
        return state.nodeStates
            .filter((item) => item.node.id !== 'suporte')
            .filter((item) => ['available', 'no_ph', 'approval', 'locked'].includes(item.status))
            .sort((left, right) => {
                if (Number(left.node.tier || 0) !== Number(right.node.tier || 0)) {
                    return Number(left.node.tier || 0) - Number(right.node.tier || 0);
                }
                return Number(left.node.cost || 0) - Number(right.node.cost || 0);
            })
            .slice(0, limit);
    }

    const available = state.availableNodes.slice(0, limit);
    if (available.length) return available;

    return state.nodeStates
        .filter((item) => ['no_ph', 'approval', 'locked'].includes(item.status))
        .sort((left, right) => {
            const order = { no_ph: 0, approval: 1, locked: 2 };
            if ((order[left.status] || 9) !== (order[right.status] || 9)) {
                return (order[left.status] || 9) - (order[right.status] || 9);
            }
            return Number(left.node.cost || 0) - Number(right.node.cost || 0);
        })
        .slice(0, limit);
}

function captionReminderForTreeV2(tree) {
    if (tree.id === 'criacao') {
        return [
            '──  𝐋𝐄𝐌𝐁𝐑𝐄𝐓𝐄  ──',
            '> Criação melhorα mαnıfᥱstαçα̃o mágıcα.',
            '> Nα̃o buffα o corpo.',
            '',
        ];
    }
    if (tree.id === 'reforco') {
        return [
            '──  𝐋𝐄𝐌𝐁𝐑𝐄𝐓𝐄  ──',
            '> Reforço melhorα corpo, αtrıbutos físıcos ou αlıαdos.',
            '> Nα̃o melhorα projétıl/crıαçα̃o mágıcα sozınho.',
            '',
        ];
    }
    if (tree.id === 'suporte') {
        return [
            '──  𝐀𝐕𝐈𝐒𝐎  ──',
            '> Suporte αındα nα̃o podᥱ sᥱr comprαdo.',
            '> Consultαr nα̃o gαstα PH.',
            '',
        ];
    }
    return [];
}

function renderTreeCaptionClean(state, visualMode = 'compact') {
    const tree = state?.tree || getTree('mana') || { id: 'mana', name: 'Arvore de Mana', routes: [] };
    const candidates = getCaptionCandidatesV2(state, 4);
    const hasAvailable = state.availableNodes.length > 0;
    const candidateTitle = hasAvailable ? '𝐃𝐈𝐒𝐏𝐎𝐍𝐈́𝐕𝐄𝐋 𝐀𝐆𝐎𝐑𝐀' : '𝐏𝐑𝐎́𝐗𝐈𝐌𝐎𝐒 𝐍𝐎́𝐒';

    const lines = [
        captionTitleForTreeV2(tree),
        `     ──  ${captionSubtitleForTreeV2(tree)}  ──`,
        '',
        `*Progresso:* ${state.ownedCount}/${state.totalNodes} nós`,
        `*PH disponível:* ${state.ph.phAvailable}`,
        tree.id === 'suporte' ? '*Suporte:* básicos liberados; avançados pedem aprovação.' : null,
        visualMode === 'complete' ? '*Modo:* completo' : null,
        '',
        `──  ${candidateTitle}  ──`,
    ].filter(Boolean);

    if (candidates.length) {
        for (const item of candidates) {
            lines.push(...captionNodeLinesV2(item, {
                treeId: tree.id,
                compactRanks: tree.id === 'suporte',
            }));
        }
        if (state.availableNodes.length > candidates.length) {
            lines.push('', `ⓘ Existem outros nós disponíveis. Use *̣${COMMAND_PREFIX}arvore ${tree.id} texto* para ver mais.`);
        }
    } else {
        lines.push('> Nenhum próximo nó calculado agora.');
    }

    lines.push(
        '',
        ...captionReminderForTreeV2(tree),
        '──  𝐂𝐎𝐌𝐀𝐍𝐃𝐎𝐒  ──',
        `*̣${COMMAND_PREFIX}no ${tree.id} <no>*`,
        '> Vᥱr dᥱtαlhᥱs dᥱ um nó.',
        `*̣${COMMAND_PREFIX}comprar ${tree.id} <no>*`,
        '> Inıcıαr comprα.',
        `*̣${COMMAND_PREFIX}arvore ${tree.id} texto*`,
        '> Vᥱr α vᥱrsα̃o ᥱm tᥱxto.'
    );

    return lines.filter(Boolean).join('\n');
}

function renderNodeNotFoundForTreeV2(treeId = 'mana') {
    return [
        '♧ 𝐍𝐎́ 𝐍𝐀̃𝐎 𝐄𝐍𝐂𝐎𝐍𝐓𝐑𝐀𝐃𝐎',
        '',
        'Nα̃o ᥱncontrᥱı ᥱssᥱ nó nᥱssα άrvorᥱ.',
        'Tαlvᥱz o nomᥱ ᥱstᥱjα ᥱscrıto dᥱ outro jᥱıto.',
        '',
        'Use:',
        `*̣${COMMAND_PREFIX}arvore ${treeId} texto*`,
        '> Pαrα vᥱr os nomᥱs dısponívᥱıs.',
    ].join('\n');
}

function renderResolutionProblem(result) {
    const treeId = result.state?.tree?.id || 'mana';
    if (result.reason === 'ambiguous') {
        return [
            '♧ 𝐍𝐎́ 𝐀𝐌𝐁𝐈́𝐆𝐔𝐎',
            '',
            'Encontrᥱı mαıs dᥱ um nó com ᥱssᥱ nomᥱ.',
            '',
            '──  𝐏𝐎𝐃𝐄 𝐒𝐄𝐑  ──',
            ...result.matches.map((node) => `*${node.name}*`),
            '',
            'Use um nomᥱ mαıs ᥱspᥱcı́fıco.',
            `Exemplo: *̣${COMMAND_PREFIX}no ${treeId} ${uxCommandNodeName(result.matches[0])}*`,
        ].join('\n');
    }

    if (result.reason === 'not_found' || result.reason === 'missing_input') {
        return renderNodeNotFoundForTreeV2(treeId);
    }

    return [
        '♧ 𝐍𝐎́ 𝐍𝐀̃𝐎 𝐄𝐍𝐂𝐎𝐍𝐓𝐑𝐀𝐃𝐎',
        '',
        'Nα̃o consᥱguı rᥱsolvᥱr ᥱssᥱ nó.',
        result.suggestions?.length ? `Tαlvᥱz você quᥱırα: ${result.suggestions.join(', ')}.` : `Tᥱntᥱ: *̣${COMMAND_PREFIX}arvore ${treeId} texto*`,
    ].join('\n');
}

function nodeRankLineV2(node) {
    const metadata = node.metadata || {};
    const rankCosts = Array.isArray(metadata.rankCosts) ? metadata.rankCosts : [];
    if (rankCosts.length) {
        const rank = metadata.rank ? `${uxRoman(Number(metadata.rank) - 1)} dᥱ ${metadata.maxRank || rankCosts.length}` : `${rankCosts.length} ranks`;
        return [
            `*Rank:* ${rank}`,
            `*Ranks:* ${rankCosts.map((cost, index) => `Rank ${uxRoman(index)} ${cost} PH`).join(' · ')}`,
        ];
    }
    if (metadata.maxRank && Number(metadata.maxRank) > 1) {
        return [
            `*Rank:* ${metadata.rank ? uxRoman(Number(metadata.rank) - 1) : 'I'} dᥱ ${metadata.maxRank}`,
        ];
    }
    return ['*Rank:* único'];
}

function nodeRequirementLinesV2(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const requirements = node.requires.map((nodeId) => tree.nodesById[nodeId]?.name || nodeId);
    const missing = [
        ...(nodeState.missingRequirementLabels || []),
        nodeState.missingPh > 0 ? `${nodeState.missingPh} PH` : null,
        nodeState.status === 'approval' ? 'aprovação narrativa' : null,
    ].filter(Boolean);

    return [
        `*Precisa:* ${requirements.length ? requirements.join(', ') : 'nenhum'}`,
        `*Faltando:* ${missing.length ? missing.join(', ') : 'nada'}`,
        `*Aprovação:* ${node.requiresApproval ? 'necessária' : 'não exigida'}`,
    ];
}

function nodeTechnicalLinesV2(node) {
    const parts = [];
    const effect = String(node.effect || '').trim();
    if (effect && effect !== String(nodeSummaryV2(node)).trim()) {
        parts.push(effect);
    }
    if (node.metadata?.technicalWeight !== undefined) {
        parts.push(`Peso técnico: ${node.metadata.technicalWeight}.`);
    }
    return parts.length ? parts : ['Consulte a ADM para usos complexos.'];
}

function nodeUnlockLineV2(unlocks) {
    if (!unlocks?.length) return '*Libera:* nenhum caminho direto cadastrado';
    return `*Libera:* ${unlocks.map((node) => `${node.name} \`${Number(node.cost || 0)} PH\``).join(', ')}`;
}

function renderNodePurchaseAdviceUx(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const commandName = uxCommandNodeName(node);

    if (nodeState.status === 'owned') {
        return [
            '──  𝐀𝐂̧𝐀̃𝐎  ──',
            `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
            '> Voltα pαrα α άrvorᥱ.',
            'ⓘ Você jά possuı ᥱstᥱ nó.',
        ].join('\n');
    }
    if (nodeState.status === 'available') {
        return [
            '──  𝐀𝐂̧𝐀̃𝐎  ──',
            `*̣${COMMAND_PREFIX}comprar ${tree.id} ${commandName}*`,
            '> Inıcıα α comprα dᥱstᥱ nó.',
            `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
            '> Voltα pαrα α άrvorᥱ.',
        ].join('\n');
    }
    if (nodeState.status === 'approval') {
        return [
            '──  𝐀𝐂̧𝐀̃𝐎  ──',
            'Estᥱ nó ᥱxıgᥱ αprovαçα̃o nαrrαtıvα dα ADM.',
            'A comprα podᥱ prᥱcısαr dᥱ cᥱnα, trᥱıno, mαrco ou justıfıcαtıvα.',
        ].join('\n');
    }
    if (nodeState.status === 'no_ph') {
        return [
            '──  𝐀𝐂̧𝐀̃𝐎  ──',
            `Estᥱ nó custα ${node.cost} PH ᥱ αındα fαltα ${nodeState.missingPh} PH.`,
            `*̣${COMMAND_PREFIX}ph*`,
            '> Consultαr Pontos dᥱ Hαbılıdαdᥱ.',
        ].join('\n');
    }
    return [
        '──  𝐀𝐂̧𝐀̃𝐎  ──',
        'Estᥱ nó αındα nα̃o podᥱ sᥱr comprαdo.',
        'Cumpra os requisitos primeiro.',
    ].join('\n');
}

function renderNodeDetailsUx(result) {
    if (!result.ok) return renderResolutionProblem(result);

    const { node, nodeState, route, unlocks } = result;
    const tree = result.state.tree;
    const metadata = node.metadata || {};
    const routeName = `${route?.symbol || ''} ${route?.name || node.route || '-'}`.trim();

    return [
        '♧ 𝐍𝐎́ 𝐃𝐄 𝐀́𝐑𝐕𝐎𝐑𝐄',
        `     ──  ${tree.name} · ${routeName}  ──`,
        '',
        `*${node.name}* \`[${uxStatusLabel(nodeState.status, tree.id)}]\``,
        `> ${nodeSummaryV2(node)}`,
        '',
        '──  𝐑𝐄𝐒𝐔𝐌𝐎  ──',
        `*Custo:* ${node.cost} PH`,
        ...nodeRankLineV2(node),
        metadata.technicalWeight !== undefined ? `*Peso técnico:* ${metadata.technicalWeight}` : null,
        `*Tipo:* ${uxTypeLabel(metadata.type)}`,
        `*Risco:* ${uxRiskLabel(metadata.risk)}`,
        `*Narrativo:* ${uxNarrativeLabel(metadata.narrativeRequirement)}`,
        '',
        '──  𝐑𝐄𝐐𝐔𝐈𝐒𝐈𝐓𝐎𝐒  ──',
        ...nodeRequirementLinesV2(result),
        '',
        '──  𝐋𝐄𝐈𝐓𝐔𝐑𝐀  ──',
        ...nodeTechnicalLinesV2(node).map((line) => `> ${line}`),
        '',
        '──  𝐋𝐈𝐌𝐈𝐓𝐄𝐒  ──',
        `> ${uxNodeLimits(node, tree).replace(/\n\n/g, '\n> ')}`,
        '',
        '──  𝐂𝐀𝐌𝐈𝐍𝐇𝐎  ──',
        nodeUnlockLineV2(unlocks),
        '',
        renderNodePurchaseAdviceUx(result),
    ].filter((line) => line !== null).join('\n');
}

function renderTreesMenu() {
    return [
        '♧ 𝐀́𝐑𝐕𝐎𝐑𝐄𝐒 𝐃𝐄 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒𝐎',
        '     ──  cαmınhos dᥱ ᥱvoluçα̃o  ──',
        '',
        'Escolhα umα άrvorᥱ pαrα consultαr:',
        '',
        '──  𝐌𝐀𝐍𝐀  ──',
        '*̣.#arvore mana*',
        '> Técnıcαs dᥱ mαnıpulαçα̃o, lᥱıturα, ᥱmıssα̃o ᥱ sustᥱntαçα̃o dᥱ Mαnα.',
        '',
        '──  𝐂𝐀𝐌𝐈𝐍𝐇𝐎𝐒 𝐃𝐄 𝐌𝐀𝐆𝐈𝐀  ──',
        '*̣.#arvore suporte*',
        '> Efᥱıtos, condıçõᥱs, prαgαs, bᥱnçα̃os, curα, buff ᥱ trαnsmıssα̃o.',
        '*̣.#arvore criacao*',
        '> Mαnıfᥱstαçα̃o mágıcα, formαs, ᥱstruturα, dᥱnsıdαdᥱ ᥱ prᥱcısα̃o.',
        '*̣.#arvore reforco*',
        '> Buff mágıco no corpo, αtrıbutos físıcos ᥱ rᥱforço αvαnçαdo.',
        '',
        '──  𝐂𝐎𝐍𝐒𝐔𝐋𝐓𝐀 𝐃𝐄 𝐍𝐎́  ──',
        '*̣.#no <arvore> <no>*',
        '> Vᥱ α dᥱscrıçα̃o dᥱ um nó.',
        '*̣.#comprar <arvore> <no>*',
        '> Inıcıα α comprα dᥱ um nó.',
        '',
        'Exemplo:',
        '*̣.#no mana bala-de-mana-i*',
    ].join('\n');
}

const previousRenderTreeTextOverview = renderTreeTextOverview;
renderTreeTextOverview = function renderTreeTextOverview(state) {
    if (state?.tree?.id !== 'suporte') {
        return previousRenderTreeTextOverview(state);
    }

    const tree = state.tree;
    const nodeStatesById = Object.fromEntries(state.nodeStates.map((item) => [item.node.id, item]));
    const suggestions = [
        ...state.availableNodes,
        ...state.nodeStates.filter((item) => ['no_ph', 'approval', 'locked'].includes(item.status)),
    ].slice(0, 6);

    const lines = [
        '♧ ÁRVORE DE SUPORTE',
        '     -- efeitos, condições e interferência --',
        '',
        `*PH disponível:* ${state.ph.phAvailable}`,
        `*PH acumulado:* ${state.ph.phAccumulated}`,
        `*Progresso:* ${state.ownedCount}/${state.totalNodes} nós`,
        '*Regra:* básicos compráveis; Magigramática e avançados pedem aprovação.',
        '',
        '-- ROTAS --',
    ];

    for (const progress of state.routeProgress.filter((item) => item.route.id !== 'base')) {
        const next = sortRouteNodes(progress.nodes)
            .map((node) => nodeStatesById[node.id])
            .find((item) => item?.status !== 'owned');
        lines.push(
            `${progress.route.symbol} *${progress.route.name}*`,
            `> Progresso: ${progress.owned}/${progress.total}`,
            next ? `> Próximo: ${next.node.name} · ${statusDetail(next)}` : '> Rota completa'
        );
    }

    lines.push('', '-- PRÓXIMOS NÓS --');
    if (!suggestions.length) {
        lines.push('> Nenhum próximo nó calculado agora.');
    } else {
        for (const item of suggestions) {
            lines.push(
                `*${item.node.name}* \`${nodeCostLabelV2(item.node, true)} · ${uxStatusLabel(item.status, tree.id)}\``,
                `> ${nodeSummaryV2(item.node)}`
            );
        }
    }

    lines.push(
        '',
        '-- COMANDOS --',
        `*.#no suporte <no>*`,
        '> Ver detalhes de um nó.',
        `*.#comprar suporte <no>*`,
        '> Comprar nó básico disponível.'
    );

    return lines.join('\n');
};

getCaptionCandidatesV2 = function getCaptionCandidatesV2(state, limit = 4) {
    const available = state.availableNodes.slice(0, limit);
    if (available.length) return available;

    return state.nodeStates
        .filter((item) => ['no_ph', 'approval', 'locked'].includes(item.status))
        .sort((left, right) => {
            const order = { no_ph: 0, approval: 1, locked: 2 };
            if ((order[left.status] || 9) !== (order[right.status] || 9)) {
                return (order[left.status] || 9) - (order[right.status] || 9);
            }
            if (Number(left.node.tier || 0) !== Number(right.node.tier || 0)) {
                return Number(left.node.tier || 0) - Number(right.node.tier || 0);
            }
            return Number(left.node.cost || 0) - Number(right.node.cost || 0);
        })
        .slice(0, limit);
};

captionReminderForTreeV2 = function captionReminderForTreeV2(tree) {
    if (tree.id === 'criacao') {
        return [
            '──  LEMBRETE  ──',
            '> Criação melhora manifestação mágica.',
            '> Não buffa o corpo.',
            '',
        ];
    }
    if (tree.id === 'reforco') {
        return [
            '──  LEMBRETE  ──',
            '> Reforço melhora corpo, atributos físicos ou aliados.',
            '> Não melhora projétil/criação mágica sozinho.',
            '',
        ];
    }
    if (tree.id === 'suporte') {
        return [
            '──  AVISO  ──',
            '> Básicos podem ser comprados.',
            '> Magigramática e avançados pedem aprovação.',
            '',
        ];
    }
    return [];
};

renderTreeCaptionClean = function renderTreeCaptionClean(state, visualMode = 'compact') {
    const tree = state?.tree || getTree('mana') || { id: 'mana', name: 'Árvore de Mana', routes: [] };
    const candidates = getCaptionCandidatesV2(state, 4);
    const hasAvailable = state.availableNodes.length > 0;
    const candidateTitle = hasAvailable ? 'DISPONÍVEL AGORA' : 'PRÓXIMOS NÓS';

    const lines = [
        captionTitleForTreeV2(tree),
        `     --  ${captionSubtitleForTreeV2(tree)}  --`,
        '',
        `*Progresso:* ${state.ownedCount}/${state.totalNodes} nós`,
        `*PH disponível:* ${state.ph.phAvailable}`,
        tree.id === 'suporte' ? '*Suporte:* básicos liberados; avançados pedem aprovação.' : null,
        visualMode === 'complete' ? '*Modo:* completo' : null,
        '',
        `──  ${candidateTitle}  ──`,
    ].filter(Boolean);

    if (candidates.length) {
        for (const item of candidates) {
            lines.push(...captionNodeLinesV2(item, {
                treeId: tree.id,
                compactRanks: tree.id === 'suporte',
            }));
        }
        if (state.availableNodes.length > candidates.length) {
            lines.push('', `ⓘ Existem outros nós disponíveis. Use *̣${COMMAND_PREFIX}arvore ${tree.id} texto* para ver mais.`);
        }
    } else {
        lines.push('> Nenhum próximo nó calculado agora.');
    }

    lines.push(
        '',
        ...captionReminderForTreeV2(tree),
        '──  COMANDOS  ──',
        `*̣${COMMAND_PREFIX}no ${tree.id} <no>*`,
        '> Ver detalhes de um nó.',
        `*̣${COMMAND_PREFIX}comprar ${tree.id} <no>*`,
        '> Iniciar compra.',
        `*̣${COMMAND_PREFIX}arvore ${tree.id} texto*`,
        '> Ver a versão em texto.'
    );

    return lines.filter(Boolean).join('\n');
};

function treeCostInfo(itemOrNode) {
    const node = itemOrNode?.node || itemOrNode || {};
    const base = Number(itemOrNode?.baseCost ?? itemOrNode?.nodeState?.baseCost ?? node.cost ?? 0);
    const effective = Number(itemOrNode?.effectiveCost ?? itemOrNode?.nodeState?.effectiveCost ?? base);
    const discount = itemOrNode?.discount || itemOrNode?.nodeState?.discount || null;
    return {
        base,
        effective,
        discountPercent: Number(discount?.percent || 0),
        discountSources: discount?.sources || [],
    };
}

function treeCostLabel(itemOrNode, compactRanks = false) {
    const node = itemOrNode?.node || itemOrNode || {};
    const hasState = Boolean(itemOrNode?.node || itemOrNode?.nodeState || itemOrNode?.effectiveCost !== undefined);
    if (compactRanks && !hasState && Array.isArray(node?.metadata?.rankCosts) && node.metadata.rankCosts.length) {
        return `${node.metadata.rankCosts.join('/')} PH`;
    }

    const info = treeCostInfo(itemOrNode);
    if (info.discountPercent > 0 && info.effective !== info.base) {
        return `${info.effective} PH (${info.base} PH -${info.discountPercent}%)`;
    }
    return `${info.effective} PH`;
}

nodeCostLabelV2 = function nodeCostLabelV2(nodeOrItem, compactRanks = false) {
    return treeCostLabel(nodeOrItem, compactRanks);
};

statusDetail = function statusDetail(item) {
    if (!item?.node) return STATUS_LABELS[item?.status] || 'Bloqueado';
    if (item.status === 'owned') return 'Comprado';
    return `${STATUS_LABELS[item.status] || item.status} · ${treeCostLabel(item)} `;
};

captionNodeLinesV2 = function captionNodeLinesV2(item, options = {}) {
    const node = item.node;
    const status = item.status && item.status !== 'available'
        ? ` · ${uxStatusLabel(item.status, options.treeId)}`
        : '';
    return [
        `*${node.name}* \`${treeCostLabel(item, options.compactRanks)}${status}\``,
        `> ${nodeSummaryV2(node)}`,
    ];
};

uxUnlocksBlock = function uxUnlocksBlock(unlocks) {
    if (!unlocks?.length) return '• Nenhum caminho direto cadastrado.';
    return uxBulletList(unlocks.map((node) => `${node.name} (${treeCostLabel(node)})`), 'Nenhum caminho direto cadastrado.');
};

renderNodePurchaseAdviceUx = function renderNodePurchaseAdviceUx(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const command = `${COMMAND_PREFIX}comprar ${tree.id} ${uxCommandNodeName(node)}`;

    if (nodeState.status === 'owned') {
        return [
            uxSection('COMPRA'),
            '',
            'Você já possui este nó.',
        ].join('\n');
    }
    if (nodeState.status === 'available') {
        return [
            uxSection('COMPRA'),
            '',
            `*̣${command}*`,
            '> Inicia a compra deste nó.',
        ].join('\n');
    }
    if (nodeState.status === 'approval') {
        return [
            uxSection('APROVAÇÃO'),
            '',
            'Este nó exige aprovação narrativa da ADM.',
            'A compra pode precisar de cena, treino, marco ou justificativa.',
        ].join('\n');
    }
    if (nodeState.status === 'no_ph') {
        return [
            uxSection('COMPRA'),
            '',
            `Este nó exige ${treeCostLabel(nodeState)} e você ainda precisa de ${nodeState.missingPh} PH.`,
            '',
            `Use *̣${COMMAND_PREFIX}ph* para consultar seus Pontos de Habilidade.`,
        ].join('\n');
    }
    return [
        uxSection('COMPRA'),
        '',
        'Este nó ainda não pode ser comprado.',
        'Cumpra os requisitos acima primeiro.',
    ].join('\n');
};

renderNodeDetailsUx = function renderNodeDetailsUx(result) {
    if (!result.ok) return renderResolutionProblem(result);

    const { node, nodeState, route, unlocks } = result;
    const tree = result.state.tree;
    const metadata = node.metadata || {};

    return [
        '♧ NÓ DE ÁRVORE',
        `     --  ${tree.name}  --`,
        '',
        `*${node.name}*`,
        '',
        uxSection('STATUS'),
        '',
        `*Estado:* ${uxStatusLabel(nodeState.status, tree.id)}`,
        `*Árvore:* ${tree.name}`,
        `*Rota:* ${route?.symbol || ''} ${route?.name || node.route}`,
        `*Custo:* ${treeCostLabel(nodeState)}`,
        `*Tipo:* ${uxTypeLabel(metadata.type)}`,
        `*Risco:* ${uxRiskLabel(metadata.risk)}`,
        '',
        uxRankBlock(node),
        '',
        uxSection('FUNÇÃO'),
        '',
        uxNodeDescription(node),
        '',
        uxSection('LEITURA TÉCNICA'),
        '',
        uxNodeTechnicalReading(node),
        '',
        uxSection('REQUISITOS'),
        '',
        uxRequirementsBlock(result),
        '',
        uxSection('LIMITES'),
        '',
        uxNodeLimits(node, tree),
        '',
        uxSection('PRÓXIMOS CAMINHOS'),
        '',
        uxUnlocksBlock(unlocks),
        '',
        renderNodePurchaseAdviceUx(result),
    ].join('\n');
};

renderPurchaseBlockedUx = function renderPurchaseBlockedUx(result) {
    if (!result.ok && ['ambiguous', 'not_found', 'missing_input'].includes(result.reason)) {
        return renderResolutionProblem(result);
    }

    const details = result.details || result;
    const tree = details.state?.tree || result.state?.tree || getTree('mana');
    const node = details.node;
    const nodeState = details.nodeState;

    if (nodeState?.status === 'owned') {
        return [
            '♧ NÓ JÁ COMPRADO',
            '',
            'Você já possui este nó:',
            '',
            `*${tree.name} — ${node.name}*`,
            '',
            'Use:',
            `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
            '',
            'Para ver seu progresso.',
        ].join('\n');
    }
    if (nodeState?.status === 'approval') {
        return [
            '♧ APROVAÇÃO NARRATIVA',
            '',
            `*${tree.name} — ${node.name}*`,
            '',
            'Este nó exige aprovação narrativa da ADM.',
            'A compra pode precisar de cena, treino, marco ou justificativa.',
            '',
            `Use *̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(node)}* para ver os detalhes.`,
        ].join('\n');
    }
    if (nodeState?.status === 'no_ph') {
        return [
            '♧ PH INSUFICIENTE',
            '',
            'Você não possui PH suficiente para comprar este nó.',
            '',
            `*Nó:* ${node.name}`,
            `*Custo:* ${treeCostLabel(nodeState)}`,
            `*PH disponível:* ${details.state.ph.phAvailable} PH`,
            `*Falta:* ${nodeState.missingPh} PH`,
            '',
            'Use:',
            `*̣${COMMAND_PREFIX}ph*`,
            '',
            'Para consultar seus Pontos de Habilidade.',
        ].join('\n');
    }
    if (nodeState?.status === 'locked') {
        const firstMissing = nodeState.missingRequirements?.[0];
        const missingNode = firstMissing ? tree.nodesById[firstMissing] : null;
        return [
            '♧ NÓ BLOQUEADO',
            '',
            `*${tree.name} — ${node.name}*`,
            '',
            'Você ainda não cumpriu os requisitos deste nó.',
            '',
            uxSection('FALTA'),
            '',
            uxBulletList(nodeState.missingRequirementLabels, 'requisitos anteriores'),
            '',
            'Use:',
            `*̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(missingNode || node)}*`,
            '',
            'Para entender o caminho anterior.',
        ].join('\n');
    }

    return [
        '♧ COMPRA INDISPONÍVEL',
        '',
        'Esse nó não está disponível para compra agora.',
        '',
        node ? `Use *̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(node)}* para ver os detalhes.` : `Use *̣${COMMAND_PREFIX}arvores*.`,
    ].join('\n');
};

renderPurchasePreviewUx = function renderPurchasePreviewUx(result) {
    const { details } = result;
    const cost = treeCostInfo(details.nodeState).effective;
    const after = Math.max(0, Number(details.state.ph.phAvailable || 0) - cost);
    const risk = details.node.metadata?.risk;
    const attention = [
        details.node.requiresApproval ? 'Este nó exige aprovação narrativa.' : null,
        risk === 'alto' || risk === 'extremo' ? 'Usos complexos deste nó dependem de contexto e ADM.' : null,
    ].filter(Boolean);
    return [
        '♧ COMPRA PENDENTE',
        '',
        'Você está prestes a comprar:',
        '',
        `*Árvore:* ${details.state.tree.name}`,
        `*Nó:* ${details.node.name}`,
        `*Custo:* ${treeCostLabel(details.nodeState)}`,
        `*PH disponível:* ${details.state.ph.phAvailable} PH`,
        `*PH após compra:* ${after} PH`,
        '',
        uxSection('O QUE ISSO LIBERA'),
        '',
        uxNodeDescription(details.node),
        '',
        uxSection('ATENÇÃO'),
        '',
        attention.length ? attention.join('\n') : 'Compra comum. Nenhuma aprovação extra registrada para este nó.',
        '',
        uxSection('CONFIRMAR'),
        '',
        `*̣${COMMAND_PREFIX}confirmarcompra*`,
        '> Confirma a compra.',
        `*̣${COMMAND_PREFIX}cancelarcompra*`,
        '> Cancela a compra.',
        '',
        'ⓘ Esta compra expira em 15 minutos.',
    ].join('\n');
};

renderPurchaseSuccessUx = function renderPurchaseSuccessUx(result) {
    const cost = Number(result.cost || result.pending?.metadata?.cost || 0);
    const baseCost = Number(result.baseCost || result.pending?.metadata?.base_cost || result.node.cost || cost);
    const discountPercent = Number(result.discount?.percent || result.pending?.metadata?.discount_percent || 0);
    const costText = discountPercent > 0 && baseCost !== cost
        ? `${cost} PH (${baseCost} PH -${discountPercent}%)`
        : `${cost} PH`;

    return [
        '♧ NÓ COMPRADO',
        '',
        'Você comprou:',
        '',
        `*${result.tree.name} — ${result.node.name}*`,
        '',
        uxSection('PH'),
        '',
        `*Custo:* ${costText}`,
        `*PH restante:* ${result.spend.after.phAvailable} PH`,
        '',
        uxSection('NOVA CAPACIDADE'),
        '',
        uxNodeDescription(result.node),
        result.node.requiresApproval ? '\nUsos complexos deste nó ainda dependem de aprovação narrativa.' : null,
        '',
        'Use:',
        `*̣${COMMAND_PREFIX}capacidade*`,
        '> Para ver a leitura atualizada.',
    ].filter((line) => line !== null).join('\n');
};

function treePrettyText(value) {
    return String(value ?? '')
        .replace(/Ã¡/g, 'á')
        .replace(/Ã /g, 'à')
        .replace(/Ã¢/g, 'â')
        .replace(/Ã£/g, 'ã')
        .replace(/Ã©/g, 'é')
        .replace(/Ãª/g, 'ê')
        .replace(/Ã­/g, 'í')
        .replace(/Ã³/g, 'ó')
        .replace(/Ã´/g, 'ô')
        .replace(/Ãµ/g, 'õ')
        .replace(/Ãº/g, 'ú')
        .replace(/Ã§/g, 'ç')
        .replace(/Ã/g, 'Á')
        .replace(/Ã‰/g, 'É')
        .replace(/Ã“/g, 'Ó')
        .replace(/Ãš/g, 'Ú')
        .replace(/Ã‡/g, 'Ç')
        .replace(/Â·/g, '·')
        .replace(/â€”/g, '-')
        .replace(/â€“/g, '-')
        .replace(/â™§/g, '♧')
        .replace(/â”€/g, '─')
        .replace(/â€¢/g, '•')
        .replace(/â“˜/g, 'ⓘ')
        .replace(/NÃ£o/g, 'Não')
        .replace(/nÃ£o/g, 'não')
        .replace(/vocÃª/g, 'você')
        .replace(/VocÃª/g, 'Você')
        .replace(/Ãrvore/g, 'Árvore')
        .replace(/Ã¡rvore/g, 'árvore')
        .replace(/CriaÃ§Ã£o/g, 'Criação')
        .replace(/criaÃ§Ã£o/g, 'criação')
        .replace(/ReforÃ§o/g, 'Reforço')
        .replace(/reforÃ§o/g, 'reforço')
        .replace(/nÃ³/g, 'nó')
        .replace(/nÃ³s/g, 'nós')
        .replace(/disponÃ­vel/g, 'disponível')
        .replace(/disponÃ­veis/g, 'disponíveis')
        .replace(/aprovaÃ§Ã£o/g, 'aprovação')
        .replace(/AprovaÃ§Ã£o/g, 'Aprovação')
        .replace(/tÃ©cnica/g, 'técnica')
        .replace(/tÃ©cnico/g, 'técnico')
        .replace(/mÃ¡gica/g, 'mágica')
        .replace(/mÃ¡gico/g, 'mágico')
        .replace(/prÃ³ximo/g, 'próximo')
        .replace(/PrÃ³ximo/g, 'Próximo')
        .replace(/Ãºnico/g, 'único')
        .replace(/Ã¡rea/g, 'área')
        .replace(/\s+/g, ' ')
        .trim();
}

function treePrettySection(title) {
    return `_` + `\`─( ◆ )───── ${title}\`` + `_`;
}

function treeDisplayName(treeOrId) {
    const id = typeof treeOrId === 'string' ? treeOrId : treeOrId?.id;
    const names = {
        mana: 'Árvore de Mana',
        suporte: 'Árvore de Suporte',
        criacao: 'Árvore de Criação',
        reforco: 'Árvore de Reforço',
        fisico: 'Árvore Física',
    };
    return names[id] || treePrettyText(treeOrId?.name || 'Árvore');
}

function treeMessageHeader(title, subtitle = null) {
    return [
        `♧┃${title} 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫`,
        subtitle ? `     ──  ${subtitle}  ──` : null,
    ].filter(Boolean);
}

function treeRouteDisplayName(route) {
    const name = treePrettyText(route?.name || route || '-');
    const normalized = normalizeText(name);
    if (normalized.includes('percepcao')) return 'Rota da Percepção';
    if (normalized.includes('fluxo')) return 'Rota do Fluxo';
    if (normalized.includes('retencao')) return 'Rota da Retenção';
    if (normalized.includes('emissao')) return 'Rota da Emissão';
    return name;
}

function treeStatusLabel(status) {
    const labels = {
        owned: 'Comprado',
        available: 'Disponível',
        no_ph: 'Sem PH',
        approval: 'Aprovação narrativa',
        locked: 'Bloqueado',
    };
    return labels[status] || treePrettyText(status || 'Bloqueado');
}

function treeLineList(items, fallback = 'nenhum item registrado') {
    const list = (items || [])
        .map(treePrettyText)
        .filter(Boolean);

    if (!list.length) return `> ${fallback}`;
    return list.map((item) => `> ${item}`).join('\n');
}

uxBulletList = function uxBulletList(items, fallback) {
    return treeLineList(items, fallback || 'nenhum item registrado');
};

captionTitleForTreeV2 = function captionTitleForTreeV2Pretty(tree) {
    const id = typeof tree === 'string' ? tree : tree?.id;
    const titles = {
        mana: '𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐌𝐀𝐍𝐀',
        suporte: '𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐒𝐔𝐏𝐎𝐑𝐓𝐄',
        criacao: '𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐂𝐑𝐈𝐀𝐂̧𝐀̃𝐎',
        reforco: '𝐀́𝐑𝐕𝐎𝐑𝐄 𝐃𝐄 𝐑𝐄𝐅𝐎𝐑𝐂̧𝐎',
        fisico: '𝐀́𝐑𝐕𝐎𝐑𝐄 𝐅𝐈́𝐒𝐈𝐂𝐀',
    };
    return `♧┃${titles[id] || treeDisplayName(tree).toUpperCase()} 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫`;
};

captionSubtitleForTreeV2 = function captionSubtitleForTreeV2Pretty(tree) {
    const subtitles = {
        mana: 'progresso, leitura e manipulação de Mana',
        suporte: 'efeitos, condições e interferência',
        criacao: 'forma, estrutura e manifestação mágica',
        reforco: 'corpo, atributos e reforço mágico',
        fisico: 'corpo, vigor, leitura, instinto, Ki e Zetten',
    };
    return subtitles[tree?.id] || 'progresso e próximos nós';
};

nodeSummaryV2 = function nodeSummaryV2Pretty(node) {
    return treePrettyText(
        node?.metadata?.playerSummary
        || node?.shortEffect
        || node?.effect
        || 'Sem resumo cadastrado ainda.'
    );
};

captionNodeLinesV2 = function captionNodeLinesV2Pretty(item, options = {}) {
    const node = item.node;
    const status = item.status === 'available' ? 'Disponível' : treeStatusLabel(item.status);
    return [
        `*${treePrettyText(node.name)}*`,
        `> Custo: ${treeCostLabel(item, options.compactRanks)} · ${status}`,
        `> ${nodeSummaryV2(node)}`,
    ];
};

captionReminderForTreeV2 = function captionReminderForTreeV2Pretty(tree) {
    if (tree.id === 'criacao') {
        return [
            treePrettySection('𝗟𝗲𝗺𝗯𝗿𝗲𝘁𝗲'),
            '> Criação melhora manifestação mágica.',
            '> Não buffa o corpo.',
            '',
        ];
    }
    if (tree.id === 'reforco') {
        return [
            treePrettySection('𝗟𝗲𝗺𝗯𝗿𝗲𝘁𝗲'),
            '> Reforço melhora corpo, atributos físicos ou aliados.',
            '> Não melhora projétil/criação mágica sozinho.',
            '',
        ];
    }
    if (tree.id === 'suporte') {
        return [
            treePrettySection('𝗔𝘃𝗶𝘀𝗼'),
            '> Básicos podem ser comprados.',
            '> Magigramática e avançados pedem aprovação narrativa.',
            '',
        ];
    }
    if (tree.id === 'fisico') {
        return [
            treePrettySection('𝗟𝗲𝗺𝗯𝗿𝗲𝘁𝗲'),
            '> Físico não é Estilo de Luta.',
            '> Ki, Zetten e Ápice Físico pedem aprovação narrativa.',
            '',
        ];
    }
    return [];
};

renderTreeCaptionClean = function renderTreeCaptionCleanPretty(state, visualMode = 'compact') {
    const tree = state?.tree || getTree('mana') || { id: 'mana', name: 'Árvore de Mana', routes: [] };
    const available = state.availableNodes.slice(0, 4);
    const candidates = available.length ? available : getCaptionCandidatesV2(state, 4);
    const candidateTitle = available.length ? 'PODE COMPRAR AGORA' : 'PRÓXIMOS PASSOS';
    const discountLine = state.discount?.percent
        ? `*Desconto:* ${state.discount.percent}%${state.discount.sources?.length ? ` (${[...new Set(state.discount.sources)].join(' + ')})` : ''}`
        : null;

    const lines = [
        captionTitleForTreeV2(tree),
        `     ──  ${captionSubtitleForTreeV2(tree)}  ──`,
        '',
        treePrettySection('𝗥𝗲𝘀𝘂𝗺𝗼'),
        `*PH disponível:* ${state.ph.phAvailable}`,
        `*PH acumulado:* ${state.ph.phAccumulated}`,
        `*Progresso:* ${state.ownedCount}/${state.totalNodes} nós`,
        discountLine,
        tree.id === 'suporte' ? '*Suporte:* básicos liberados; avançados pedem aprovação.' : null,
        visualMode === 'complete' ? '*Modo:* completo' : null,
        '',
        treePrettySection(candidateTitle),
    ].filter(Boolean);

    if (candidates.length) {
        for (const item of candidates) {
            lines.push(...captionNodeLinesV2(item, {
                treeId: tree.id,
                compactRanks: tree.id === 'suporte',
            }));
        }
        if (available.length && state.availableNodes.length > available.length) {
            lines.push('', `ⓘ Existem outros nós disponíveis. Use *̣${COMMAND_PREFIX}arvore ${tree.id} texto* para ver mais.`);
        }
    } else {
        lines.push('> Nenhum próximo nó calculado agora.');
    }

    lines.push(
        '',
        ...captionReminderForTreeV2(tree),
        treePrettySection('𝗖𝗼𝗺𝗼 𝗨𝘀𝗮𝗿'),
        `*̣${COMMAND_PREFIX}no ${tree.id} <nó>*`,
        '> Ver detalhes de um nó.',
        `*̣${COMMAND_PREFIX}comprar ${tree.id} <nó>*`,
        '> Iniciar compra.',
        `*̣${COMMAND_PREFIX}arvore ${tree.id} texto*`,
        '> Ver a versão em texto.'
    );

    return lines.filter(Boolean).join('\n');
};

statusDetail = function statusDetailPretty(item) {
    if (!item?.node) return treeStatusLabel(item?.status);
    if (item.status === 'owned') return 'Comprado';
    return `${treeStatusLabel(item.status)} · ${treeCostLabel(item)}`;
};

renderTreeTextOverview = function renderTreeTextOverviewPretty(state) {
    const tree = state.tree;
    const nodeStatesById = Object.fromEntries(state.nodeStates.map((item) => [item.node.id, item]));
    const suggestions = [
        ...state.availableNodes,
        ...state.nodeStates.filter((item) => ['no_ph', 'approval', 'locked'].includes(item.status)),
    ].slice(0, 8);

    const lines = [
        captionTitleForTreeV2(tree),
        `     ──  ${captionSubtitleForTreeV2(tree)}  ──`,
        '',
        treePrettySection('𝗥𝗲𝘀𝘂𝗺𝗼'),
        `*PH disponível:* ${state.ph.phAvailable}`,
        `*PH acumulado:* ${state.ph.phAccumulated}`,
        `*Progresso:* ${state.ownedCount}/${state.totalNodes} nós`,
        state.discount?.percent
            ? `*Desconto:* ${state.discount.percent}%${state.discount.sources?.length ? ` (${[...new Set(state.discount.sources)].join(' + ')})` : ''}`
            : null,
        tree.id === 'suporte' ? '*Regra:* básicos compráveis; Magigramática e avançados pedem aprovação.' : null,
        '',
        treePrettySection('𝗥𝗼𝘁𝗮𝘀 𝗣𝗿𝗶𝗻𝗰𝗶𝗽𝗮𝗶𝘀'),
    ].filter(Boolean);

    if (tree.id === 'fisico') {
        lines.push(...FISICO_TEXT_TREE, '');
    }

    for (const progress of state.routeProgress.filter((item) => item.route.id !== 'base')) {
        const next = sortRouteNodes(progress.nodes)
            .map((node) => nodeStatesById[node.id])
            .find((item) => item?.status !== 'owned');
        lines.push(
            `${progress.route.symbol || '•'} *${treeRouteDisplayName(progress.route)}*`,
            `> Progresso: ${progress.owned}/${progress.total}`,
            next ? `> Próximo: ${treePrettyText(next.node.name)} · ${statusDetail(next)}` : '> Rota completa'
        );
    }

    lines.push('', treePrettySection('𝗡𝗼́𝘀 𝗠𝗮𝗶𝘀 𝗣𝗿𝗼́𝘅𝗶𝗺𝗼𝘀'));
    if (!suggestions.length) {
        lines.push('> Nenhum próximo nó calculado agora.');
    } else {
        for (const item of suggestions) {
            lines.push(
                `*${treePrettyText(item.node.name)}*`,
                `> Custo: ${treeCostLabel(item, tree.id === 'suporte')} · ${treeStatusLabel(item.status)}`,
                `> ${nodeSummaryV2(item.node)}`
            );
        }
    }

    lines.push(
        '',
        treePrettySection('𝗖𝗼𝗺𝗼 𝗨𝘀𝗮𝗿'),
        `*̣${COMMAND_PREFIX}no ${tree.id} <nó>*`,
        '> Ver detalhes de um nó.',
        `*̣${COMMAND_PREFIX}comprar ${tree.id} <nó>*`,
        '> Iniciar compra de um nó disponível.',
        `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
        '> Voltar para o visual.'
    );

    return lines.join('\n');
};

function renderNodeNotFoundForTreePretty(treeId = 'mana') {
    return [
        ...treeMessageHeader('𝐍𝐎́ 𝐍𝐀̃𝐎 𝐄𝐍𝐂𝐎𝐍𝐓𝐑𝐀𝐃𝐎', 'consulta de árvore'),
        '',
        'Não encontrei esse nó nessa árvore.',
        'Talvez o nome esteja escrito de outro jeito.',
        '',
        treePrettySection('𝗨𝘀𝗲'),
        `*̣${COMMAND_PREFIX}arvore ${treeId} texto*`,
        '> Ver os nomes disponíveis.',
    ].join('\n');
}

renderResolutionProblem = function renderResolutionProblemPretty(result) {
    const treeId = result.state?.tree?.id || 'mana';
    if (result.reason === 'ambiguous') {
        return [
            ...treeMessageHeader('𝐍𝐎́ 𝐀𝐌𝐁𝐈́𝐆𝐔𝐎', 'mais de um resultado'),
            '',
            'Encontrei mais de um nó com esse nome.',
            '',
            treePrettySection('𝗣𝗼𝗱𝗲 𝗦𝗲𝗿'),
            ...result.matches.map((node) => `*${treePrettyText(node.name)}*`),
            '',
            'Use um nome mais específico.',
            `Exemplo: *̣${COMMAND_PREFIX}no ${treeId} ${uxCommandNodeName(result.matches[0])}*`,
        ].join('\n');
    }

    if (result.reason === 'not_found' || result.reason === 'missing_input') {
        return renderNodeNotFoundForTreePretty(treeId);
    }

    return [
        ...treeMessageHeader('𝐍𝐎́ 𝐍𝐀̃𝐎 𝐄𝐍𝐂𝐎𝐍𝐓𝐑𝐀𝐃𝐎', 'consulta de árvore'),
        '',
        'Não consegui resolver esse nó.',
        result.suggestions?.length
            ? `Talvez você queira: ${result.suggestions.map(treePrettyText).join(', ')}.`
            : `Tente: *̣${COMMAND_PREFIX}arvore ${treeId} texto*`,
    ].join('\n');
};

nodeRankLineV2 = function nodeRankLineV2Pretty(node) {
    const metadata = node.metadata || {};
    const rankCosts = Array.isArray(metadata.rankCosts) ? metadata.rankCosts : [];
    if (rankCosts.length) {
        const rank = metadata.rank ? `${uxRoman(Number(metadata.rank) - 1)} de ${metadata.maxRank || rankCosts.length}` : `${rankCosts.length} ranks`;
        return [
            `*Rank:* ${rank}`,
            `*Ranks:* ${rankCosts.map((cost, index) => `Rank ${uxRoman(index)} ${cost} PH`).join(' · ')}`,
        ];
    }
    if (metadata.maxRank && Number(metadata.maxRank) > 1) {
        return [
            `*Rank:* ${metadata.rank ? uxRoman(Number(metadata.rank) - 1) : 'I'} de ${metadata.maxRank}`,
        ];
    }
    return ['*Rank:* único'];
};

nodeRequirementLinesV2 = function nodeRequirementLinesV2Pretty(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const requirements = node.requires.map((nodeId) => treePrettyText(tree.nodesById[nodeId]?.name || nodeId));
    const anyRequirements = (node.requiresAny || [])
        .map((group) => group.map((nodeId) => treePrettyText(tree.nodesById[nodeId]?.name || nodeId)).join(' ou '))
        .filter(Boolean);
    const allRequirements = [...requirements, ...anyRequirements];
    const missing = [
        ...(nodeState.missingRequirementLabels || []).map(treePrettyText),
        nodeState.missingPh > 0 ? `${nodeState.missingPh} PH` : null,
        nodeState.status === 'approval' ? 'aprovação narrativa' : null,
    ].filter(Boolean);

    return [
        `*Precisa:* ${allRequirements.length ? allRequirements.join(', ') : 'nenhum'}`,
        `*Faltando:* ${missing.length ? missing.join(', ') : 'nada'}`,
        `*Aprovação:* ${node.requiresApproval ? 'necessária' : 'não exigida'}`,
    ];
};

nodeTechnicalLinesV2 = function nodeTechnicalLinesV2Pretty(node) {
    const parts = [];
    const summary = nodeSummaryV2(node);
    const technical = treePrettyText(node.metadata?.technicalSummary || '');
    const effect = treePrettyText(node.effect || '');
    if (technical) parts.push(technical);
    if (effect && effect !== summary) parts.push(effect);
    if (node.metadata?.technicalWeight !== undefined) {
        parts.push(`Peso técnico: ${node.metadata.technicalWeight}.`);
    }
    return parts.length ? parts : ['Consulte a ADM para usos complexos.'];
};

uxNodeDescription = function uxNodeDescriptionPretty(node) {
    return `> ${nodeSummaryV2(node)}`;
};

uxNodeTechnicalReading = function uxNodeTechnicalReadingPretty(node) {
    return nodeTechnicalLinesV2(node).map((line) => `> ${line}`).join('\n');
};

uxNodeLimits = function uxNodeLimitsPretty(node, tree) {
    const metadata = node.metadata || {};
    const limits = [];
    if (metadata.notDoes) limits.push(metadata.notDoes);
    if (node.requiresApproval) limits.push('Usos complexos dependem de aprovação narrativa da ADM.');
    if (tree.id === 'criacao') limits.push('Criação não substitui Reforço nem buffa o corpo.');
    if (tree.id === 'reforco') limits.push('Reforço não melhora projétil/criação mágica sozinho.');
    if (tree.id === 'mana') limits.push('Mana continua limitada pelo Hexágono, custo, alcance, duração e controle de cena.');
    if (tree.id === 'suporte') limits.push('Usos avançados de Suporte dependem de aprovação narrativa.');

    return treeLineList(limits, 'Sem limite extra registrado além do Hexágono, custo e contexto.');
};

uxRequirementsBlock = function uxRequirementsBlockPretty(result) {
    return nodeRequirementLinesV2(result).join('\n');
};

function nodeUnlockLinePretty(unlocks) {
    if (!unlocks?.length) return '> Nenhum caminho direto cadastrado.';
    return unlocks.map((node) => `> ${treePrettyText(node.name)} (${treeCostLabel(node)})`).join('\n');
}

uxUnlocksBlock = function uxUnlocksBlockPretty(unlocks) {
    return nodeUnlockLinePretty(unlocks);
};

renderNodePurchaseAdviceUx = function renderNodePurchaseAdviceUxPretty(result) {
    const { node, nodeState, state } = result;
    const tree = state.tree;
    const commandName = uxCommandNodeName(node);

    if (nodeState.status === 'owned') {
        return [
            treePrettySection('𝗔𝗰̧𝗮̃𝗼'),
            `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
            '> Voltar para a árvore.',
            'ⓘ Você já possui este nó.',
        ].join('\n');
    }
    if (nodeState.status === 'available') {
        return [
            treePrettySection('𝗔𝗰̧𝗮̃𝗼'),
            `*̣${COMMAND_PREFIX}comprar ${tree.id} ${commandName}*`,
            '> Inicia a compra deste nó.',
            `*̣${COMMAND_PREFIX}arvore ${tree.id}*`,
            '> Voltar para a árvore.',
        ].join('\n');
    }
    if (nodeState.status === 'approval') {
        return [
            treePrettySection('𝗔𝗰̧𝗮̃𝗼'),
            '> Este nó exige aprovação narrativa da ADM.',
            '> A compra pode precisar de cena, treino, marco ou justificativa.',
        ].join('\n');
    }
    if (nodeState.status === 'no_ph') {
        return [
            treePrettySection('𝗔𝗰̧𝗮̃𝗼'),
            `> Este nó custa ${treeCostLabel(nodeState)} e ainda falta ${nodeState.missingPh} PH.`,
            `*̣${COMMAND_PREFIX}ph*`,
            '> Consultar Pontos de Habilidade.',
        ].join('\n');
    }
    return [
        treePrettySection('𝗔𝗰̧𝗮̃𝗼'),
        '> Este nó ainda não pode ser comprado.',
        '> Cumpra os requisitos primeiro.',
    ].join('\n');
};

renderNodeDetailsUx = function renderNodeDetailsUxPretty(result) {
    if (!result.ok) return renderResolutionProblem(result);

    const { node, nodeState, route, unlocks } = result;
    const tree = result.state.tree;
    const metadata = node.metadata || {};
    const routeName = `${route?.symbol || ''} ${treePrettyText(route?.name || node.route || '-')}`.trim();
    const missing = [
        ...(nodeState.missingRequirementLabels || []).map(treePrettyText),
        nodeState.missingPh > 0 ? `${nodeState.missingPh} PH` : null,
        nodeState.status === 'approval' ? 'aprovação narrativa' : null,
    ].filter(Boolean);

    return [
        ...treeMessageHeader('𝐍𝐎́ 𝐃𝐄 𝐀́𝐑𝐕𝐎𝐑𝐄', `${treeDisplayName(tree)} · ${routeName}`),
        '',
        `*${treePrettyText(node.name)}*`,
        `> ${nodeSummaryV2(node)}`,
        '',
        treePrettySection('𝗦𝗶𝘁𝘂𝗮𝗰̧𝗮̃𝗼'),
        `*Status:* ${treeStatusLabel(nodeState.status)}`,
        `*Custo:* ${treeCostLabel(nodeState)}`,
        `*Você tem:* ${result.state.ph.phAvailable} PH`,
        `*Falta:* ${missing.length ? missing.join(', ') : 'nada'}`,
        '',
        treePrettySection('𝗢 𝗤𝘂𝗲 𝗟𝗶𝗯𝗲𝗿𝗮'),
        ...nodeTechnicalLinesV2(node).map((line) => `> ${line}`),
        '',
        treePrettySection('𝗗𝗲𝘁𝗮𝗹𝗵𝗲𝘀'),
        ...nodeRankLineV2(node),
        metadata.technicalWeight !== undefined ? `*Peso técnico:* ${metadata.technicalWeight}` : null,
        `*Tipo:* ${treePrettyText(uxTypeLabel(metadata.type))}`,
        `*Risco:* ${treePrettyText(uxRiskLabel(metadata.risk))}`,
        `*Narrativo:* ${treePrettyText(uxNarrativeLabel(metadata.narrativeRequirement))}`,
        '',
        treePrettySection('𝗥𝗲𝗾𝘂𝗶𝘀𝗶𝘁𝗼𝘀'),
        ...nodeRequirementLinesV2(result),
        '',
        treePrettySection('𝗟𝗶𝗺𝗶𝘁𝗲𝘀'),
        uxNodeLimits(node, tree),
        '',
        treePrettySection('𝗖𝗮𝗺𝗶𝗻𝗵𝗼'),
        nodeUnlockLinePretty(unlocks),
        '',
        renderNodePurchaseAdviceUx(result),
    ].filter((line) => line !== null).join('\n');
};

renderTreesMenu = function renderTreesMenuPretty() {
    return [
        ...treeMessageHeader('𝐀́𝐑𝐕𝐎𝐑𝐄𝐒 𝐃𝐄 𝐏𝐑𝐎𝐆𝐑𝐄𝐒𝐒𝐎', 'caminhos de evolução do personagem'),
        '',
        treePrettySection('𝗠𝗮𝗻𝗮'),
        '*̣.#arvore mana*',
        '> Técnicas de manipulação, leitura, emissão e sustentação de Mana.',
        '',
        treePrettySection('𝗖𝗮𝗺𝗶𝗻𝗵𝗼𝘀 𝗱𝗲 𝗠𝗮𝗴𝗶𝗮'),
        '*̣.#arvore suporte*',
        '> Efeitos, condições, pragas, bênçãos, cura, buff e transmissão.',
        '*̣.#arvore criacao*',
        '> Manifestação mágica, formas, estrutura, densidade e precisão.',
        '*̣.#arvore reforco*',
        '> Buff mágico no corpo, atributos físicos e reforço avançado.',
        '',
        treePrettySection('𝗙𝗶́𝘀𝗶𝗰𝗼'),
        '*̣.#arvore fisico*',
        '> Corpo, vigor, controle corporal, leitura, instinto, Ki e Zetten.',
        '',
        treePrettySection('𝗡𝗼́𝘀'),
        '*̣.#no <árvore> <nó>*',
        '> Ver a descrição de um nó.',
        '*̣.#comprar <árvore> <nó>*',
        '> Iniciar a compra de um nó.',
        '',
        treePrettySection('𝗘𝘅𝗲𝗺𝗽𝗹𝗼'),
        '*̣.#no mana bala-de-mana-i*',
    ].join('\n');
};

renderPurchaseBlockedUx = function renderPurchaseBlockedUxPretty(result) {
    if (!result.ok && ['ambiguous', 'not_found', 'missing_input'].includes(result.reason)) {
        return renderResolutionProblem(result);
    }

    const details = result.details || result;
    const tree = details.state?.tree || result.state?.tree || getTree('mana');
    const node = details.node;
    const nodeState = details.nodeState;

    if (nodeState?.status === 'owned') {
        return [
            ...treeMessageHeader('𝐍𝐎́ 𝐉𝐀́ 𝐂𝐎𝐌𝐏𝐑𝐀𝐃𝐎', 'progresso registrado'),
            '',
            `*${treeDisplayName(tree)} · ${treePrettyText(node.name)}*`,
            '',
            '*̣.#arvore ' + tree.id + '*',
            '> Ver seu progresso.',
        ].join('\n');
    }
    if (nodeState?.status === 'approval') {
        return [
            ...treeMessageHeader('𝐀𝐏𝐑𝐎𝐕𝐀𝐂̧𝐀̃𝐎 𝐍𝐀𝐑𝐑𝐀𝐓𝐈𝐕𝐀', 'compra exige aval da ADM'),
            '',
            `*${treeDisplayName(tree)} · ${treePrettyText(node.name)}*`,
            '',
            '> Este nó exige aprovação narrativa da ADM.',
            '> A compra pode precisar de cena, treino, marco ou justificativa.',
            '',
            `*̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(node)}*`,
            '> Ver detalhes.',
        ].join('\n');
    }
    if (nodeState?.status === 'no_ph') {
        return [
            ...treeMessageHeader('𝐏𝐇 𝐈𝐍𝐒𝐔𝐅𝐈𝐂𝐈𝐄𝐍𝐓𝐄', 'compra bloqueada'),
            '',
            `*Nó:* ${treePrettyText(node.name)}`,
            `*Custo:* ${treeCostLabel(nodeState)}`,
            `*PH disponível:* ${details.state.ph.phAvailable} PH`,
            `*Falta:* ${nodeState.missingPh} PH`,
            '',
            '*̣.#ph*',
            '> Consultar seus Pontos de Habilidade.',
        ].join('\n');
    }
    if (nodeState?.status === 'locked') {
        const firstMissing = nodeState.missingRequirements?.[0];
        const missingNode = firstMissing ? tree.nodesById[firstMissing] : null;
        return [
            ...treeMessageHeader('𝐍𝐎́ 𝐁𝐋𝐎𝐐𝐔𝐄𝐀𝐃𝐎', 'requisitos pendentes'),
            '',
            `*${treeDisplayName(tree)} · ${treePrettyText(node.name)}*`,
            '',
            '> Você ainda não cumpriu os requisitos deste nó.',
            '',
            treePrettySection('𝗙𝗮𝗹𝘁𝗮'),
            treeLineList(nodeState.missingRequirementLabels, 'requisitos anteriores'),
            '',
            `*̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(missingNode || node)}*`,
            '> Entender o caminho anterior.',
        ].join('\n');
    }

    return [
        ...treeMessageHeader('𝐂𝐎𝐌𝐏𝐑𝐀 𝐈𝐍𝐃𝐈𝐒𝐏𝐎𝐍𝐈́𝐕𝐄𝐋', 'nó ainda não liberado'),
        '',
        '> Esse nó não está disponível para compra agora.',
        node ? `*̣${COMMAND_PREFIX}no ${tree.id} ${uxCommandNodeName(node)}*` : '*̣.#arvores*',
        '> Ver detalhes.',
    ].join('\n');
};

renderPurchasePreviewUx = function renderPurchasePreviewUxPretty(result) {
    const { details } = result;
    const cost = treeCostInfo(details.nodeState).effective;
    const after = Math.max(0, Number(details.state.ph.phAvailable || 0) - cost);
    const risk = details.node.metadata?.risk;
    const attention = [
        details.node.requiresApproval ? 'Este nó exige aprovação narrativa.' : null,
        risk === 'alto' || risk === 'extremo' ? 'Usos complexos deste nó dependem de contexto e ADM.' : null,
    ].filter(Boolean);

    return [
        ...treeMessageHeader('𝐂𝐎𝐌𝐏𝐑𝐀 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄', 'confirme antes de gastar PH'),
        '',
        `*Árvore:* ${treeDisplayName(details.state.tree)}`,
        `*Nó:* ${treePrettyText(details.node.name)}`,
        `*Custo:* ${treeCostLabel(details.nodeState)}`,
        `*PH disponível:* ${details.state.ph.phAvailable} PH`,
        `*PH após compra:* ${after} PH`,
        '',
        treePrettySection('𝗢 𝗤𝘂𝗲 𝗜𝘀𝘀𝗼 𝗟𝗶𝗯𝗲𝗿𝗮'),
        `> ${nodeSummaryV2(details.node)}`,
        '',
        treePrettySection('𝗔𝘁𝗲𝗻𝗰̧𝗮̃𝗼'),
        attention.length ? attention.map((line) => `> ${line}`).join('\n') : '> Compra comum. Nenhuma aprovação extra registrada para este nó.',
        '',
        treePrettySection('𝗖𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝗿'),
        '*̣.#confirmarcompra*',
        '> Confirmar a compra.',
        '*̣.#cancelarcompra*',
        '> Cancelar a compra.',
        '',
        'ⓘ Esta compra expira em 15 minutos.',
    ].join('\n');
};

renderPurchaseSuccessUx = function renderPurchaseSuccessUxPretty(result) {
    const cost = Number(result.cost || result.pending?.metadata?.cost || 0);
    const baseCost = Number(result.baseCost || result.pending?.metadata?.base_cost || result.node.cost || cost);
    const discountPercent = Number(result.discount?.percent || result.pending?.metadata?.discount_percent || 0);
    const costText = discountPercent > 0 && baseCost !== cost
        ? `${cost} PH (${baseCost} PH -${discountPercent}%)`
        : `${cost} PH`;

    return [
        ...treeMessageHeader('𝐍𝐎́ 𝐂𝐎𝐌𝐏𝐑𝐀𝐃𝐎', 'progresso atualizado'),
        '',
        `*${treeDisplayName(result.tree)} · ${treePrettyText(result.node.name)}*`,
        '',
        treePrettySection('𝗣𝗛'),
        `*Custo:* ${costText}`,
        `*PH restante:* ${result.spend.after.phAvailable} PH`,
        '',
        treePrettySection('𝗡𝗼𝘃𝗮 𝗖𝗮𝗽𝗮𝗰𝗶𝗱𝗮𝗱𝗲'),
        `> ${nodeSummaryV2(result.node)}`,
        result.node.requiresApproval ? '> Usos complexos deste nó ainda dependem de aprovação narrativa.' : null,
        '',
        '*̣.#capacidade*',
        '> Ver a leitura atualizada.',
    ].filter((line) => line !== null).join('\n');
};

function frontHeader(title, subtitle) {
    return [
        `*♧┃${title} 𖥔 CLOVER MULTICOLOR*`,
        `     ── ${subtitle} ──`,
    ];
}

function frontSection(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function frontTreeTitle(tree) {
    const titles = {
        mana: 'ÁRVORE DE MANA',
        criacao: 'ÁRVORE DE CRIAÇÃO',
        reforco: 'ÁRVORE DE REFORÇO',
        suporte: 'ÁRVORE DE SUPORTE',
        fisico: 'ÁRVORE FÍSICA',
    };
    return titles[tree?.id] || String(tree?.name || 'ÁRVORE').toUpperCase();
}

function frontTreeSubtitle(tree) {
    const subtitles = {
        mana: 'manipulação, fluxo e limite de mana',
        criacao: 'forma mágica e manifestação',
        reforco: 'buff mágico no corpo e em alvos',
        suporte: 'cura, condição, buff, debuff e selo',
        fisico: 'corpo, técnica e leitura',
    };
    return subtitles[tree?.id] || 'caminhos, nós e evolução';
}

function frontTreeReminder(tree) {
    const reminders = {
        mana: [
            '> A árvore mostra o que você sabe fazer com mana.',
            '> O Hexágono define alcance, duração, área, pressão e controle.',
        ],
        criacao: [
            '> Criação melhora a coisa manifestada.',
            '> Não buffa o corpo. Isso é Reforço.',
        ],
        reforco: [
            '> Reforço melhora corpo, atributo físico, aliado ou alvo reforçado.',
            '> Não melhora projétil ou criação mágica comum sozinho.',
        ],
        suporte: [
            '> Básicos podem ser comprados.',
            '> Magigramática e efeitos avançados pedem aprovação narrativa.',
        ],
        fisico: [
            '> Físico melhora como você usa atributo físico.',
            '> Não aumenta magia, projétil mágico, cura ou Reforço mágico.',
        ],
    };
    return reminders[tree?.id] || ['> Consulte o nó para ver uso e limite.'];
}

function frontCommand(commandText, description) {
    return [
        `*̣${commandText}*`,
        `> ${description}`,
    ];
}

function frontCost(item, compactRanks = false) {
    const node = item?.node || item;
    const rankCosts = node?.metadata?.rankCosts;
    if (compactRanks && Array.isArray(rankCosts) && rankCosts.length) return `${rankCosts.join('/')} PH`;
    const cost = Number(item?.effectiveCost ?? node?.cost ?? 0);
    return `${cost} PH`;
}

function frontStatus(item) {
    const labels = {
        owned: 'comprado',
        available: 'disponível',
        locked: 'bloqueado',
        no_ph: 'sem PH',
        approval: 'aprovação narrativa',
    };
    return labels[item?.status] || item?.status || 'bloqueado';
}

function frontNodeSummary(node) {
    return String(
        node?.metadata?.playerSummary
        || node?.shortEffect
        || node?.effect
        || 'Resumo ainda não cadastrado.'
    ).replace(/\s+/g, ' ').trim();
}

function frontCaptionCandidates(state, limit = 4) {
    const available = state.availableNodes.slice(0, limit);
    if (available.length) return { title: '𝑷𝒐𝒅𝒆 𝑪𝒐𝒎𝒑𝒓𝒂𝒓 𝑨𝒈𝒐𝒓𝒂', items: available };
    const items = state.nodeStates
        .filter((item) => ['no_ph', 'approval', 'locked'].includes(item.status))
        .sort((left, right) => {
            const order = { no_ph: 0, approval: 1, locked: 2 };
            if ((order[left.status] || 9) !== (order[right.status] || 9)) {
                return (order[left.status] || 9) - (order[right.status] || 9);
            }
            return Number(left.node.cost || 0) - Number(right.node.cost || 0);
        })
        .slice(0, limit);
    return { title: '𝑷𝒓𝒐́𝒙𝒊𝒎𝒐𝒔 𝑷𝒂𝒔𝒔𝒐𝒔', items };
}

renderApprovedMagicTreeText = function renderApprovedMagicTreeTextFront() {
    return [
        ...frontHeader('ÁRVORE DE MAGIA', 'criação, reforço e suporte'),
        '',
        frontSection('✓', '𝑨́𝒓𝒗𝒐𝒓𝒆𝒔'),
        '',
        ...frontCommand(`${COMMAND_PREFIX}arvore criacao`, 'Forma mágica, estrutura e manifestação.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore reforco`, 'Buff mágico no corpo e em alvos.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore suporte`, 'Cura, condição, buff, debuff e selo.'),
        '',
        frontSection('◆', '𝑮𝒖𝒊𝒂𝒔'),
        '',
        ...frontCommand(`${COMMAND_PREFIX}guia criacao`, 'Entender Criação.'),
        ...frontCommand(`${COMMAND_PREFIX}guia reforco`, 'Entender Reforço.'),
        ...frontCommand(`${COMMAND_PREFIX}guia suporte`, 'Entender Suporte.'),
    ].join('\n');
};

renderTreesMenu = function renderTreesMenuFront() {
    return [
        ...frontHeader('ÁRVORES DE PROGRESSO', 'caminhos, nós e evolução'),
        '',
        frontSection('✦', '𝑷𝒓𝒊𝒏𝒄𝒊𝒑𝒂𝒊𝒔'),
        '',
        ...frontCommand(`${COMMAND_PREFIX}arvore mana`, 'Manipulação, fluxo, emissão, retenção e percepção de mana.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore criacao`, 'Forma mágica, estrutura, densidade, precisão e manifestação.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore reforco`, 'Buff mágico no corpo, atributos físicos, aliados e reforço avançado.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore suporte`, 'Cura, bênção, praga, condição, selo, buff, debuff e transmissão.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore fisico`, 'Corpo, vigor, controle, sentidos, identidade física, Ki e Zetten.'),
        '',
        frontSection('◆', '𝑪𝒐𝒏𝒔𝒖𝒍𝒕𝒂𝒓'),
        '',
        ...frontCommand(`${COMMAND_PREFIX}no <arvore> <no>`, 'Ver um nó específico.'),
        ...frontCommand(`${COMMAND_PREFIX}comprar <arvore> <no>`, 'Iniciar compra de um nó disponível.'),
        ...frontCommand(`${COMMAND_PREFIX}guia <arvore>`, 'Entender como cada árvore funciona.'),
    ].join('\n');
};

renderTreeCaptionClean = function renderTreeCaptionFront(state, visualMode = 'compact') {
    const tree = state?.tree || getTree('mana') || { id: 'mana', name: 'Árvore de Mana' };
    const candidateBlock = frontCaptionCandidates(state, 4);
    const lines = [
        ...frontHeader(frontTreeTitle(tree), frontTreeSubtitle(tree)),
        '',
        frontSection('✓', '𝑹𝒆𝒔𝒖𝒎𝒐'),
        '',
        `*𝑷𝑯 𝒅𝒊𝒔𝒑𝒐𝒏𝒊́𝒗𝒆𝒍:* ${state.ph.phAvailable}`,
        `*𝑷𝑯 𝒂𝒄𝒖𝒎𝒖𝒍𝒂𝒅𝒐:* ${state.ph.phAccumulated}`,
        `*𝑷𝒓𝒐𝒈𝒓𝒆𝒔𝒔𝒐:* ${state.ownedCount}/${state.totalNodes} nós`,
        state.discount?.percent
            ? `*𝑫𝒆𝒔𝒄𝒐𝒏𝒕𝒐:* ${state.discount.percent}%`
            : null,
        visualMode === 'complete' ? '*𝑴𝒐𝒅𝒐:* completo' : null,
        '',
        frontSection('✦', candidateBlock.title),
        '',
    ].filter((line) => line !== null);

    if (candidateBlock.items.length) {
        for (const item of candidateBlock.items) {
            lines.push(
                `*${item.node.name}* \`${frontCost(item, tree.id === 'suporte')} · ${frontStatus(item)}\``,
                `> ${frontNodeSummary(item.node)}`
            );
        }
    } else {
        lines.push('> Nenhum próximo nó calculado agora.');
    }

    lines.push(
        '',
        frontSection('◇', '𝑳𝒆𝒎𝒃𝒓𝒆𝒕𝒆'),
        '',
        ...frontTreeReminder(tree),
        '',
        frontSection('■', '𝑼𝒔𝒂𝒓'),
        '',
        ...frontCommand(`${COMMAND_PREFIX}no ${tree.id} <no>`, 'Ver detalhes de um nó.'),
        ...frontCommand(`${COMMAND_PREFIX}comprar ${tree.id} <no>`, 'Iniciar compra.'),
        ...frontCommand(`${COMMAND_PREFIX}arvore ${tree.id} texto`, 'Ver a versão em texto.'),
    );

    return lines.join('\n');
};

module.exports = {
    nome: `${COMMAND_PREFIX}arvores`,
    aliases: [
        `${COMMAND_PREFIX}árvores`,
        `${COMMAND_PREFIX}arvore`,
        `${COMMAND_PREFIX}árvore`,
        `${COMMAND_PREFIX}rota`,
        `${COMMAND_PREFIX}no`,
        `${COMMAND_PREFIX}nó`,
        `${COMMAND_PREFIX}comprar`,
        `${COMMAND_PREFIX}confirmarcompra`,
        `${COMMAND_PREFIX}cancelarcompra`,
    ],
    descricao: 'Mostra e compra nós das árvores de habilidade Clover.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);
        if (!phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
            return;
        }

        const action = resolveAction(matchedCommand);

        if (action === 'menu') {
            await sendReply({ sock, idChat, m, text: renderTreesMenu() });
            return;
        }

        if (action === 'tree') {
            const { treeId, textOnly, visualMode } = parseTreeViewArgs(body);
            if (!treeId) {
                await sendReply({ sock, idChat, m, text: renderTreesMenu() });
                return;
            }
            if (isMagicTreeVisualAlias(treeId)) {
                await sendReply({ sock, idChat, m, text: renderApprovedMagicTreeText() });
                return;
            }
            const tree = getTree(treeId);
            if (!tree) {
                await sendReply({ sock, idChat, m, text: renderTreeNotFoundMessage() });
                return;
            }
            const state = await getTreeState(db, idJogador, tree.id);
            if (!textOnly) {
                try {
                    const rendered = await renderTreeVisualPngCached(db, idJogador, tree.id, { mode: visualMode });
                    await sendReply({
                        sock,
                        idChat,
                        m,
                        imagePath: rendered.path,
                        text: renderTreeCaptionClean(state, visualMode),
                    });
                    return;
                } catch (error) {
                    console.log('[clover-tree-render] falha ao gerar PNG:', error?.stack || error?.message || error);
                }
            }
            await sendReply({ sock, idChat, m, text: renderTreeOverview(state) });
            return;
        }

        if (action === 'route') {
            const { treeId, tail } = parseTreeAndTail(body);
            const state = await getTreeState(db, idJogador, treeId);
            await sendReply({ sock, idChat, m, text: renderRouteView(state, tail) });
            return;
        }

        if (action === 'node') {
            const { treeId, tail } = parseTreeAndTail(body, 'mana', { baseFallback: true });
            const details = await getNodeDetails(db, idJogador, treeId, tail);
            await sendReply({ sock, idChat, m, text: renderNodeDetailsUx(details) });
            return;
        }

        if (action === 'buy') {
            const { treeId, tail } = parseTreeAndTail(body, 'mana', { baseFallback: true });
            const result = await createPendingPurchase(db, idJogador, treeId, tail, idJogador, 'comando_comprar');
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok ? renderPurchasePreviewUx(result) : renderPurchaseBlockedUx(result),
            });
            return;
        }

        if (action === 'confirm') {
            const result = await confirmPendingPurchase(db, idJogador, idJogador);
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok ? renderPurchaseSuccessUx(result) : renderConfirmFailureUx(result),
            });
            return;
        }

        if (action === 'cancel') {
            const result = await cancelPendingPurchase(db, idJogador);
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok ? renderCancelSuccessUx() : renderCancelFailureUx(),
            });
        }
    },
};
