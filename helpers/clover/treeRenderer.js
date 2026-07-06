const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { getTreeState } = require('./skillTreeService');

const RENDERER_VERSION = 5;
const WIDTH = 1200;
const HEIGHT = 1800;
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'trees');

const ROUTE_LAYOUT = {
    percepcao: { x: 90, y: 360 },
    fluxo: { x: 650, y: 360 },
    emissao: { x: 90, y: 705 },
    retencao: { x: 650, y: 705 },
};

const ROUTE_COPY = {
    percepcao: 'Sentir fluxos, ler sinais e perceber o campo ao redor.',
    fluxo: 'Conduzir mana pelo corpo com estabilidade e resposta.',
    emissao: 'Projetar mana para fora com pressão, forma e alcance.',
    retencao: 'Sustentar efeitos e reduzir desperdício de mana.',
};

const CONVERGENCES = [
    {
        id: 'mana_skin_i',
        formula: 'Fluxo + Retenção',
        name: 'Mana Skin',
        x: 260,
        y: 1210,
    },
    {
        id: 'campo_de_mana_i',
        formula: 'Percepção + Fluxo',
        name: 'Campo de Mana',
        x: 620,
        y: 1210,
    },
    {
        id: 'pulso_de_mana_i',
        formula: 'Percepção + Emissão',
        name: 'Pulso de Mana',
        x: 980,
        y: 1210,
    },
    {
        id: 'ambiente_de_mana_i',
        formula: 'Percepção + Fluxo + Retenção',
        name: 'Ambiente de Mana',
        x: 420,
        y: 1412,
    },
    {
        id: 'mana_zone_i',
        formula: 'Ambiente de Mana + Provação',
        name: 'Mana Zone',
        x: 780,
        y: 1412,
        major: true,
    },
];

const STATUS_META = {
    owned: {
        label: 'Comprado',
        fill: '#214b36',
        stroke: '#4fd091',
        text: '#f4fff5',
        muted: '#b7f0cf',
        symbol: '◆',
    },
    available: {
        label: 'Disponível',
        fill: '#193f50',
        stroke: '#69d8ef',
        text: '#f5fdff',
        muted: '#bdefff',
        symbol: '✦',
    },
    no_ph: {
        label: 'Sem PH',
        fill: '#523c19',
        stroke: '#e2b84d',
        text: '#fff7df',
        muted: '#f3d888',
        symbol: '◇',
    },
    locked: {
        label: 'Bloqueado',
        fill: '#342f36',
        stroke: '#8a7f88',
        text: '#eee7df',
        muted: '#c1b6ae',
        symbol: '◇',
    },
    approval: {
        label: 'Provação',
        fill: '#44284c',
        stroke: '#d5a84d',
        text: '#fff3dc',
        muted: '#e9c8ff',
        symbol: '✧',
    },
};

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function sanitizeFilePart(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function wrapWords(value, maxChars = 28, maxLines = 3) {
    const words = String(value || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';

    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length > maxChars && current) {
            lines.push(current);
            current = word;
        } else {
            current = next;
        }
    }

    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;

    const trimmed = lines.slice(0, maxLines);
    trimmed[maxLines - 1] = `${trimmed[maxLines - 1].replace(/\.+$/g, '')}...`;
    return trimmed;
}

function textBlock(lines, x, y, options = {}) {
    const size = options.size || 28;
    const fill = options.fill || '#f7ead1';
    const weight = options.weight || 500;
    const anchor = options.anchor || 'start';
    const family = options.family || 'Georgia, Times New Roman, serif';
    const lineHeight = options.lineHeight || Math.round(size * 1.28);

    return [
        `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">`,
        ...lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`),
        '</text>',
    ].join('');
}

function displayTreeName(tree) {
    if (tree?.id === 'mana') return 'ÁRVORE DE MANA';
    return String(tree?.name || 'Árvore').toUpperCase();
}

function statusMeta(status) {
    return STATUS_META[status] || STATUS_META.locked;
}

function statusLine(item) {
    const meta = statusMeta(item?.status);
    if (!item?.node) return meta.label;
    if (item.status === 'owned') return meta.label;
    return `${meta.label} · ${Number(item.node.cost || 0)} PH`;
}

function getStatusByNodeId(payload) {
    return Object.fromEntries((payload.nodeStatuses || []).map((item) => [item.node.id, item]));
}

function getRouteProgressById(payload) {
    return Object.fromEntries((payload.routeProgress || []).map((item) => [item.route.id, item]));
}

function sortRouteNodes(nodes) {
    return [...nodes].sort((left, right) => {
        if (Number(left.tier || 0) !== Number(right.tier || 0)) return Number(left.tier || 0) - Number(right.tier || 0);
        return Number(left.cost || 0) - Number(right.cost || 0) || left.name.localeCompare(right.name);
    });
}

function nextRouteNode(payload, routeId) {
    const statusByNodeId = getStatusByNodeId(payload);
    const routeNodes = sortRouteNodes(payload.tree.nodes.filter((node) => (
        node.route === routeId && !(node.tags || []).includes('convergencia')
    )));
    return routeNodes.map((node) => statusByNodeId[node.id]).find((item) => item?.status !== 'owned') || null;
}

function renderBackground() {
    return `
        <defs>
            <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#21170f"/>
                <stop offset="48%" stop-color="#332418"/>
                <stop offset="100%" stop-color="#17100b"/>
            </linearGradient>
            <radialGradient id="inkWash" cx="50%" cy="45%" r="75%">
                <stop offset="0%" stop-color="#715334" stop-opacity="0.32"/>
                <stop offset="72%" stop-color="#160f0a" stop-opacity="0"/>
            </radialGradient>
            <linearGradient id="goldStroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stop-color="#8f6b2b"/>
                <stop offset="48%" stop-color="#f0d07a"/>
                <stop offset="100%" stop-color="#8f6b2b"/>
            </linearGradient>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000000" flood-opacity="0.34"/>
            </filter>
            <filter id="manaGlow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="5" result="blur"/>
                <feMerge>
                    <feMergeNode in="blur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
            <pattern id="grain" width="80" height="80" patternUnits="userSpaceOnUse">
                <path d="M6 18 C24 8 42 18 62 9" fill="none" stroke="#f0d7a0" stroke-opacity="0.035" stroke-width="2"/>
                <path d="M12 58 C28 48 42 65 70 49" fill="none" stroke="#050302" stroke-opacity="0.06" stroke-width="2"/>
            </pattern>
        </defs>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#page)"/>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#inkWash)"/>
        <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grain)"/>
        <rect x="34" y="34" width="${WIDTH - 68}" height="${HEIGHT - 68}" rx="44" fill="none" stroke="url(#goldStroke)" stroke-width="4" stroke-opacity="0.82"/>
        <rect x="54" y="54" width="${WIDTH - 108}" height="${HEIGHT - 108}" rx="34" fill="none" stroke="#d9b86f" stroke-width="1.5" stroke-opacity="0.36"/>
        <path d="M90 178 C260 115 385 176 560 132 C755 84 930 122 1110 90" fill="none" stroke="#e8c66d" stroke-opacity="0.18" stroke-width="2"/>
        <path d="M92 1632 C260 1568 402 1636 606 1588 C810 1542 955 1582 1106 1518" fill="none" stroke="#e8c66d" stroke-opacity="0.16" stroke-width="2"/>
    `;
}

function renderHeader(payload) {
    return `
        ${textBlock([displayTreeName(payload.tree)], WIDTH / 2, 112, { size: 56, weight: 900, fill: '#fff0bf', anchor: 'middle' })}
        ${textBlock(['Clover Multicolor · mapa de rotas e convergências'], WIDTH / 2, 158, { size: 26, weight: 700, fill: '#e6c982', anchor: 'middle' })}
        <path d="M245 194 H955" stroke="url(#goldStroke)" stroke-width="3" stroke-linecap="round" opacity="0.86"/>
        <g transform="translate(92 222)">
            <rect x="0" y="0" width="1016" height="96" rx="26" fill="#21150d" stroke="#ba9147" stroke-width="2" stroke-opacity="0.72"/>
            ${renderMetric('Personagem', payload.characterName || payload.playerId, 38, 38, 26)}
            ${renderMetric('PH', `${payload.phAvailable}/${payload.phAccumulated}`, 370, 38, 28)}
            ${renderMetric('Estágio', payload.stageLabel, 590, 38, 28)}
            ${renderMetric('Mana', `${payload.ownedNodeIds.length}/${payload.tree.nodes.length} nós`, 810, 38, 28)}
        </g>
    `;
}

function renderMetric(label, value, x, y, size = 26) {
    return `
        ${textBlock([label], x, y, { size: 18, fill: '#b89c66', weight: 800, family: 'Arial, Helvetica, sans-serif' })}
        ${textBlock([String(value)], x, y + 36, { size, fill: '#fff2ce', weight: 900 })}
    `;
}

function renderRouteCard(payload, route) {
    const position = ROUTE_LAYOUT[route.id] || { x: 90, y: 360 };
    const progress = getRouteProgressById(payload)[route.id] || { owned: 0, total: 0 };
    const next = nextRouteNode(payload, route.id);
    const nextMeta = next ? statusMeta(next.status) : STATUS_META.owned;
    const short = ROUTE_COPY[route.id] || route.shortDescription || '';
    const nextName = next ? next.node.name : 'Rota completa';
    const nextLine = next ? statusLine(next) : 'Todos os nós base comprados';

    return `
        <g filter="url(#shadow)">
            <path d="M${position.x + 26} ${position.y}
                     H${position.x + 424}
                     Q${position.x + 470} ${position.y} ${position.x + 470} ${position.y + 46}
                     V${position.y + 246}
                     Q${position.x + 470} ${position.y + 292} ${position.x + 424} ${position.y + 292}
                     H${position.x + 26}
                     Q${position.x} ${position.y + 292} ${position.x} ${position.y + 246}
                     V${position.y + 46}
                     Q${position.x} ${position.y} ${position.x + 26} ${position.y} Z"
                  fill="#2a1c12" stroke="#c09b52" stroke-width="3" stroke-opacity="0.88"/>
            <path d="M${position.x + 22} ${position.y + 32} C${position.x + 116} ${position.y + 8} ${position.x + 258} ${position.y + 10} ${position.x + 448} ${position.y + 31}"
                  fill="none" stroke="#e8cb82" stroke-opacity="0.28" stroke-width="2"/>
            ${textBlock([route.symbol], position.x + 56, position.y + 82, { size: 54, fill: '#f7df9c', weight: 900, anchor: 'middle' })}
            ${textBlock([route.name], position.x + 112, position.y + 62, { size: 35, fill: '#fff2c8', weight: 900 })}
            ${textBlock([`${progress.owned}/${progress.total}`], position.x + 418, position.y + 62, { size: 28, fill: '#f1d37b', weight: 900, anchor: 'middle' })}
            ${textBlock(wrapWords(short, 34, 2), position.x + 54, position.y + 128, { size: 23, fill: '#dcc7a4', weight: 600, lineHeight: 30 })}
            <path d="M${position.x + 52} ${position.y + 176} H${position.x + 418}" stroke="#c79d55" stroke-opacity="0.34" stroke-width="2"/>
            ${textBlock(['Próximo selo'], position.x + 54, position.y + 213, { size: 18, fill: '#ad9165', weight: 900, family: 'Arial, Helvetica, sans-serif' })}
            <circle cx="${position.x + 75}" cy="${position.y + 250}" r="18" fill="${nextMeta.fill}" stroke="${nextMeta.stroke}" stroke-width="3"/>
            ${textBlock([nextMeta.symbol], position.x + 75, position.y + 258, { size: 18, fill: nextMeta.text, weight: 900, anchor: 'middle' })}
            ${textBlock(wrapWords(nextName, 26, 1), position.x + 106, position.y + 244, { size: 24, fill: '#fff6de', weight: 900 })}
            ${textBlock([nextLine], position.x + 106, position.y + 272, { size: 20, fill: nextMeta.muted, weight: 800, family: 'Arial, Helvetica, sans-serif' })}
        </g>
    `;
}

function renderManaVeins() {
    return `
        <g filter="url(#manaGlow)" opacity="0.88">
            <path d="M325 652 C360 790 455 920 600 1054" fill="none" stroke="#63d89c" stroke-width="5" stroke-linecap="round" stroke-opacity="0.74"/>
            <path d="M875 652 C838 790 742 920 600 1054" fill="none" stroke="#63d89c" stroke-width="5" stroke-linecap="round" stroke-opacity="0.74"/>
            <path d="M325 1000 C430 1038 510 1078 600 1054" fill="none" stroke="#68d8ef" stroke-width="5" stroke-linecap="round" stroke-opacity="0.74"/>
            <path d="M875 1000 C770 1038 692 1078 600 1054" fill="none" stroke="#68d8ef" stroke-width="5" stroke-linecap="round" stroke-opacity="0.74"/>
            <path d="M600 1115 C600 1180 600 1270 600 1328" fill="none" stroke="#e4bd5b" stroke-width="4" stroke-linecap="round" stroke-opacity="0.64"/>
        </g>
    `;
}

function renderCenterSeal() {
    return `
        <g transform="translate(600 1054)" filter="url(#manaGlow)">
            <circle r="84" fill="#24180f" stroke="#d3aa54" stroke-width="4" stroke-opacity="0.9"/>
            <circle r="62" fill="none" stroke="#e5c16c" stroke-width="2" stroke-opacity="0.58"/>
            <circle r="34" fill="none" stroke="#6fd8ef" stroke-width="2" stroke-opacity="0.44"/>
            <path d="M0 -74 L22 -22 L76 -20 L32 12 L48 66 L0 36 L-48 66 L-32 12 L-76 -20 L-22 -22 Z"
                  fill="none" stroke="#efd37e" stroke-width="2.5" stroke-opacity="0.54"/>
            ${textBlock(['CONVERGÊNCIAS'], 0, -2, { size: 18, fill: '#fff2ca', weight: 900, anchor: 'middle', family: 'Arial, Helvetica, sans-serif' })}
            ${textBlock(['de mana'], 0, 24, { size: 19, fill: '#d9bb75', weight: 700, anchor: 'middle' })}
        </g>
    `;
}

function renderConvergenceSeal(payload, item) {
    const status = getStatusByNodeId(payload)[item.id] || { status: 'locked', node: { cost: 0 } };
    const meta = statusMeta(status.status);
    const radius = item.major ? 92 : 78;

    return `
        <g transform="translate(${item.x} ${item.y})" filter="url(#shadow)">
            <circle r="${radius}" fill="${meta.fill}" stroke="${meta.stroke}" stroke-width="4"/>
            <circle r="${radius - 14}" fill="none" stroke="#f4dfad" stroke-width="1.5" stroke-opacity="0.38"/>
            <path d="M0 -${radius - 18} L${radius - 24} 0 L0 ${radius - 18} L-${radius - 24} 0 Z"
                  fill="none" stroke="#f4dfad" stroke-width="1.5" stroke-opacity="0.30"/>
            ${textBlock([meta.symbol], 0, -30, { size: 24, fill: meta.text, weight: 900, anchor: 'middle' })}
            ${textBlock(wrapWords(item.name, 16, 2), 0, 4, { size: item.major ? 26 : 23, fill: meta.text, weight: 900, anchor: 'middle', lineHeight: 28 })}
            ${textBlock(wrapWords(item.formula, 22, 2), 0, item.major ? 64 : 58, { size: 16, fill: meta.muted, weight: 800, anchor: 'middle', family: 'Arial, Helvetica, sans-serif', lineHeight: 20 })}
            ${textBlock([statusLine(status)], 0, item.major ? 104 : 94, { size: 18, fill: '#fff0c8', weight: 800, anchor: 'middle', family: 'Arial, Helvetica, sans-serif' })}
        </g>
    `;
}

function renderLegend() {
    const items = ['owned', 'available', 'no_ph', 'locked', 'approval'];
    return `
        <g transform="translate(98 1540)">
            <path d="M0 0 H1004 Q1030 0 1030 26 V118 Q1030 144 1004 144 H0 Q-26 144 -26 118 V26 Q-26 0 0 0 Z"
                  fill="#21150d" stroke="#aa8444" stroke-width="2" stroke-opacity="0.72"/>
            ${textBlock(['Legenda dos selos'], 18, 38, { size: 22, fill: '#e7c674', weight: 900 })}
            ${items.map((status, index) => {
                const meta = STATUS_META[status];
                const x = 28 + index * 196;
                return `
                    <g transform="translate(${x} 82)">
                        <circle cx="0" cy="0" r="17" fill="${meta.fill}" stroke="${meta.stroke}" stroke-width="3"/>
                        ${textBlock([meta.symbol], 0, 7, { size: 17, fill: meta.text, weight: 900, anchor: 'middle' })}
                        ${textBlock([meta.label], 28, 8, { size: 22, fill: '#f4e5c4', weight: 800, family: 'Arial, Helvetica, sans-serif' })}
                    </g>
                `;
            }).join('')}
        </g>
    `;
}

function renderFooter() {
    return textBlock(['Rotas grandes mostram o próximo selo. Use .#rota mana <rota> para ver o caminho completo.'], WIDTH / 2, 1720, {
        size: 22,
        fill: '#c7a96c',
        weight: 700,
        anchor: 'middle',
        family: 'Arial, Helvetica, sans-serif',
    });
}

function buildPayloadFromState(dbPlayer, treeState) {
    const nodeStatuses = treeState.nodeStates || [];
    return {
        tree: treeState.tree,
        treeState,
        playerId: treeState.playerId,
        characterName: dbPlayer?.personagem_nome && dbPlayer.personagem_nome !== '-'
            ? dbPlayer.personagem_nome
            : dbPlayer?.nome || treeState.playerId,
        phAvailable: treeState.ph.phAvailable,
        phAccumulated: treeState.ph.phAccumulated,
        stageLabel: treeState.ph.stageName,
        ownedNodeIds: treeState.ownedIds || [],
        nodeStatuses,
        routeProgress: treeState.routeProgress || [],
        availableNodes: treeState.availableNodes || [],
        goals: treeState.tree.goals || [],
    };
}

function getTreeJsonMtime(treeId) {
    const filePath = path.join(process.cwd(), 'data', 'clover', 'trees', `${treeId}.json`);
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function getTreeRenderCacheKey(payload) {
    const hashPayload = {
        rendererVersion: RENDERER_VERSION,
        treeId: payload.tree.id,
        treeVersion: getTreeJsonMtime(payload.tree.id),
        phAvailable: payload.phAvailable,
        phAccumulated: payload.phAccumulated,
        stageLabel: payload.stageLabel,
        ownedNodeIds: [...(payload.ownedNodeIds || [])].sort(),
        nodeStatuses: (payload.nodeStatuses || [])
            .map((item) => [item.node.id, item.status, item.missingPh || 0, ...(item.missingRequirements || [])])
            .sort((left, right) => left[0].localeCompare(right[0])),
    };

    return crypto
        .createHash('sha1')
        .update(JSON.stringify(hashPayload))
        .digest('hex')
        .slice(0, 16);
}

function getTreeRenderCachePath(playerId, treeId, hash) {
    return path.join(CACHE_DIR, `${sanitizeFilePart(playerId)}_${sanitizeFilePart(treeId)}_${hash}.png`);
}

function renderTreeSvg(payload) {
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        renderBackground(),
        renderHeader(payload),
        renderManaVeins(),
        payload.tree.routes.map((route) => renderRouteCard(payload, route)).join(''),
        renderCenterSeal(),
        CONVERGENCES.map((item) => renderConvergenceSeal(payload, item)).join(''),
        renderLegend(),
        renderFooter(),
        '</svg>',
    ].join('\n');
}

async function renderTreePng(payload) {
    const svg = renderTreeSvg(payload);
    return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderTreePngCached(db, playerId, treeId = 'mana') {
    const treeState = await getTreeState(db, playerId, treeId);
    const player = await db.get('SELECT id, nome, personagem_nome FROM jogadores WHERE id = ?', [playerId]);
    const payload = buildPayloadFromState(player, treeState);
    const hash = getTreeRenderCacheKey(payload);
    const imagePath = getTreeRenderCachePath(playerId, treeState.tree.id, hash);

    if (fs.existsSync(imagePath)) {
        return {
            cacheHit: true,
            path: imagePath,
            payload,
            hash,
        };
    }

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    const buffer = await renderTreePng(payload);
    fs.writeFileSync(imagePath, buffer);

    return {
        cacheHit: false,
        path: imagePath,
        payload,
        hash,
        buffer,
    };
}

module.exports = {
    buildPayloadFromState,
    getTreeRenderCacheKey,
    getTreeRenderCachePath,
    renderTreePng,
    renderTreePngCached,
    renderTreeSvg,
};
