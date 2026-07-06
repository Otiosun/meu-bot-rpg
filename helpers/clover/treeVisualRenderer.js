const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { getTreeState } = require('./skillTreeService');
const {
    getManaV73CacheKey,
    getManaV73CachePath,
    getManaV73RenderMeta,
    renderManaV73Png,
    renderManaV73Svg,
} = require('./approvedVisuals/manaTreeV73Renderer');
const {
    getMagicSplitTreeCacheKey,
    getMagicSplitTreeCachePath,
    getMagicSplitTreeRenderMeta,
    isMagicSplitTreeId,
    renderMagicSplitTreePng,
    renderMagicSplitTreeSvg,
} = require('./approvedVisuals/magicSplitTreeRenderer');
const {
    getFisicoV8CacheKey,
    getFisicoV8CachePath,
    getFisicoV8RenderMeta,
    renderFisicoV8Png,
    renderFisicoV8Svg,
} = require('./approvedVisuals/fisicoTreeV8Renderer');

const RENDERER_VERSION = 'tree-visual-approved-models-clover-2';
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'trees');
const LAYOUT_MANIFEST_DIR = path.join(process.cwd(), 'data', 'clover', 'tree-layouts');

const COMPACT_LAYOUT = {
    marginX: 135,
    marginTop: 150,
    routeTop: 270,
    nodesTop: 485,
    routeWidth: 430,
    routeGap: 95,
    nodeWidth: 380,
    nodeHeight: 96,
    rowGap: 48,
    footerHeight: 205,
    routeTitleMaxChars: 16,
    routeTitleMaxLines: 2,
    routeDescriptionMaxChars: 24,
    routeDescriptionMaxLines: 2,
    routeTitleSingleSize: 29,
    routeTitleWrappedSize: 24,
    routeCounterY: 103,
    nodeTitleMaxChars: 31,
    nodeTitleMaxLines: 2,
    nodeTitleSize: 23,
    nodeTitleLineHeight: 26,
    nodeStatusSize: 17,
};

const COMPLETE_LAYOUT = {
    marginX: 150,
    marginTop: 150,
    routeTop: 285,
    nodesTop: 520,
    routeWidth: 560,
    routeGap: 120,
    nodeWidth: 510,
    nodeHeight: 124,
    rowGap: 68,
    footerHeight: 220,
    routeTitleMaxChars: 24,
    routeTitleMaxLines: 2,
    routeDescriptionMaxChars: 36,
    routeDescriptionMaxLines: 2,
    routeTitleSingleSize: 30,
    routeTitleWrappedSize: 25,
    routeCounterY: 103,
    nodeTitleMaxChars: 36,
    nodeTitleMaxLines: 3,
    nodeTitleSize: 23,
    nodeTitleLineHeight: 25,
    nodeStatusSize: 18,
};

const RENDER_MODES = new Set(['compact', 'complete']);
const layoutManifestCache = new Map();

const COLORS = {
    bg: '#f6f4ee',
    ink: '#151515',
    muted: '#625f59',
    line: '#8d8577',
    lineReq: '#737373',
    border: '#d8d0c2',
    card: '#fbfaf6',
    route: '#efe9da',
    root: '#fff4bd',
};

const STATUS_META = {
    owned: {
        label: 'Comprado',
        fill: '#d9ead7',
        stroke: '#2f6847',
        dot: '#2f6847',
        text: '#152719',
    },
    available: {
        label: 'Disponivel',
        fill: '#dcecf2',
        stroke: '#2d6981',
        dot: '#2d6981',
        text: '#13272f',
    },
    no_ph: {
        label: 'Sem PH',
        fill: '#f5ead1',
        stroke: '#9a6c1d',
        dot: '#9a6c1d',
        text: '#2f2515',
    },
    locked: {
        label: 'Bloqueado',
        fill: '#ece9e2',
        stroke: '#7d766d',
        dot: '#7d766d',
        text: '#25221f',
    },
    approval: {
        label: 'Aprovacao',
        fill: '#eee3ef',
        stroke: '#744f7f',
        dot: '#744f7f',
        text: '#2b1c30',
    },
};

const TREE_DISPLAY = {
    mana: 'ARVORE DE MANA',
    suporte: 'ARVORE DE SUPORTE',
    criacao: 'ARVORE DE CRIACAO',
    reforco: 'ARVORE DE REFORCO',
    fisico: 'ARVORE FISICA',
};

const COMPLETE_BOX_LAYOUT = {
    minWidth: 4050,
    minHeight: 2600,
    marginX: 90,
    marginTop: 150,
    routeGap: 96,
    laneMinWidth: 650,
    nodeWidth: 330,
    nodeHeight: 92,
    nodeGapX: 48,
    rowGap: 118,
    tierGap: 34,
    maxNodesPerRow: 3,
    routeAnchorWidth: 330,
    routeAnchorHeight: 78,
    rootWidth: 300,
    rootHeight: 78,
    bottomMargin: 120,
    routeAnchorGap: 155,
    nodeTitleMaxChars: 22,
    nodeTitleMaxLines: 2,
};

const COMPLETE_BRANCH_COLORS = {
    root: '#fff4bd',
    base: '#fff4bd',
    percepcao: '#e8f6ff',
    fluxo: '#e9fff0',
    retencao: '#fff8d8',
    emissao: '#fff0e5',
    controle: '#f3eeff',
    estrutura: '#fff8d8',
    juncao: '#f4ffe5',
    intensidade: '#fff0e5',
    estabilidade: '#fff8d8',
    foco: '#e8f6ff',
    invencivel: '#e9fff0',
    invicto: '#f3eeff',
    tecnica: '#f3eeff',
    ambiente: '#f4ffe5',
    final: '#fff8ca',
};

const COMPACT_MAX_NODES_PER_ROUTE = 4;
const COMPACT_MIN_NODES_PER_ROUTE = 2;
const COMPACT_MILESTONE_TAGS = new Set(['aprovacao', 'avancado', 'base', 'convergencia', 'juncao']);

function escapeSvg(value) {
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

function statusMeta(status) {
    return STATUS_META[status] || STATUS_META.locked;
}

function displayTreeName(tree) {
    return TREE_DISPLAY[tree?.id] || String(tree?.name || 'ARVORE').toUpperCase();
}

function normalizeMode(mode = 'compact') {
    const normalized = String(mode || 'compact').toLowerCase().trim();
    return RENDER_MODES.has(normalized) ? normalized : 'compact';
}

function getLayoutConfig(mode = 'compact') {
    return normalizeMode(mode) === 'complete' ? COMPLETE_LAYOUT : COMPACT_LAYOUT;
}

function approvedModelForTreeId(treeId) {
    if (treeId === 'mana') return 'mana_tree_v7_3';
    if (isMagicSplitTreeId(treeId)) return `magic_split_${treeId}`;
    if (treeId === 'fisico') return 'fisico_tree_rework_v1';
    return null;
}

function getApprovedTreeVisualMeta(payload) {
    const model = approvedModelForTreeId(payload?.tree?.id);
    if (model === 'mana_tree_v7_3') return getManaV73RenderMeta();
    if (model?.startsWith('magic_split_')) return getMagicSplitTreeRenderMeta(payload);
    if (model === 'fisico_tree_rework_v1') return getFisicoV8RenderMeta(payload);
    return null;
}

function renderApprovedTreeVisualSvg(payload) {
    const model = approvedModelForTreeId(payload?.tree?.id);
    if (model === 'mana_tree_v7_3') return renderManaV73Svg(payload);
    if (model?.startsWith('magic_split_')) return renderMagicSplitTreeSvg(payload);
    if (model === 'fisico_tree_rework_v1') return renderFisicoV8Svg(payload);
    return null;
}

async function renderApprovedTreeVisualPng(payload) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const model = approvedModelForTreeId(payload?.tree?.id);
    if (model === 'mana_tree_v7_3') return renderManaV73Png(payload);
    if (model?.startsWith('magic_split_')) return renderMagicSplitTreePng(payload);
    if (model === 'fisico_tree_rework_v1') return renderFisicoV8Png(payload);
    return null;
}

function approvedTreeVisualCacheKey(payload) {
    const model = approvedModelForTreeId(payload?.tree?.id);
    if (!model) return null;
    if (model === 'mana_tree_v7_3') return getManaV73CacheKey(payload);
    if (model?.startsWith('magic_split_')) return getMagicSplitTreeCacheKey(payload);
    if (model === 'fisico_tree_rework_v1') return getFisicoV8CacheKey(payload);
    return null;
}

function approvedTreeVisualCachePath(treeId, hash, playerId = 'tree_visual', mode = 'compact') {
    const model = approvedModelForTreeId(treeId);
    if (model === 'mana_tree_v7_3') return getManaV73CachePath(playerId, hash, mode);
    if (model?.startsWith('magic_split_')) return getMagicSplitTreeCachePath(playerId, treeId, hash);
    if (model === 'fisico_tree_rework_v1') return getFisicoV8CachePath(playerId, hash);
    return path.join(CACHE_DIR, `${sanitizeFilePart(model || treeId)}_${sanitizeFilePart(treeId)}_${hash}.png`);
}

function getCompleteLayoutManifestPath(treeId) {
    return path.join(LAYOUT_MANIFEST_DIR, `${sanitizeFilePart(treeId)}.complete.json`);
}

function getCompleteLayoutManifestMtime(treeId) {
    const filePath = getCompleteLayoutManifestPath(treeId);
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function readCompleteLayoutManifest(treeId) {
    const filePath = getCompleteLayoutManifestPath(treeId);
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw new Error(`Manifest de layout completo ausente para ${treeId}: ${filePath}`);
    }

    const cacheKey = `${treeId}:${stat.mtimeMs}`;
    const cached = layoutManifestCache.get(cacheKey);
    if (cached) return cached;

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`Manifest de layout completo invalido para ${treeId}: ${error.message}`);
    }

    const loaded = {
        filePath,
        manifest,
        mtimeMs: stat.mtimeMs,
    };
    layoutManifestCache.set(cacheKey, loaded);
    return loaded;
}

function manifestNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`Manifest de layout completo invalido: ${label} precisa ser numerico.`);
    }
    return number;
}

function manifestBox(spec, label) {
    if (!spec || typeof spec !== 'object') {
        throw new Error(`Manifest de layout completo invalido: caixa ausente em ${label}.`);
    }
    const box = {
        x: manifestNumber(spec.x, `${label}.x`),
        y: manifestNumber(spec.y, `${label}.y`),
        w: manifestNumber(spec.w, `${label}.w`),
        h: manifestNumber(spec.h, `${label}.h`),
    };
    if (box.w <= 0 || box.h <= 0) {
        throw new Error(`Manifest de layout completo invalido: ${label} precisa ter largura e altura positivas.`);
    }
    return box;
}

function sortNodes(nodes) {
    return [...nodes].sort((left, right) => {
        if (Number(left.tier || 0) !== Number(right.tier || 0)) {
            return Number(left.tier || 0) - Number(right.tier || 0);
        }
        if (Number(left.cost || 0) !== Number(right.cost || 0)) {
            return Number(left.cost || 0) - Number(right.cost || 0);
        }
        return String(left.name || left.id).localeCompare(String(right.name || right.id));
    });
}

function nodeTags(node) {
    return Array.isArray(node?.tags) ? node.tags : [];
}

function hasAnyCompactMilestoneTag(node) {
    return nodeTags(node).some((tag) => COMPACT_MILESTONE_TAGS.has(tag));
}

function compactNodeRank(node, item) {
    if (item?.status === 'owned') return 0;
    if (item?.status === 'available') return 10;
    if (item?.status === 'no_ph') return 20;
    if (item?.status === 'approval' || node.requiresApproval) return 25;
    if (!Array.isArray(node.requires) || node.requires.length === 0) return 30;
    if (hasAnyCompactMilestoneTag(node)) return 35;
    return 50;
}

function selectCompactRouteNodes(routeNodes, payload, stateById) {
    const selected = new Map();
    const add = (node) => {
        if (node?.id) selected.set(node.id, node);
    };

    for (const node of routeNodes) {
        const item = stateById[node.id];
        const isStarter = !Array.isArray(node.requires) || node.requires.length === 0;
        const isImportant = hasAnyCompactMilestoneTag(node) || node.requiresApproval;
        const isRelevantStatus = ['owned', 'available', 'approval'].includes(item?.status);

        if (isStarter || isImportant || isRelevantStatus) add(node);
    }

    const firstPending = routeNodes.find((node) => stateById[node.id]?.status !== 'owned');
    if (firstPending) add(firstPending);
    const firstNoPh = routeNodes.find((node) => stateById[node.id]?.status === 'no_ph');
    if (firstNoPh) add(firstNoPh);
    if (!selected.size && routeNodes.length) add(routeNodes[0]);

    for (const node of routeNodes) {
        if (selected.size >= COMPACT_MIN_NODES_PER_ROUTE) break;
        add(node);
    }

    const selectedNodes = [...selected.values()];
    const protectedNodes = selectedNodes.filter((node) => (
        ['owned', 'available'].includes(stateById[node.id]?.status)
    ));
    const optionalNodes = selectedNodes
        .filter((node) => !protectedNodes.some((protectedNode) => protectedNode.id === node.id))
        .sort((left, right) => {
            const leftRank = compactNodeRank(left, stateById[left.id]);
            const rightRank = compactNodeRank(right, stateById[right.id]);
            if (leftRank !== rightRank) return leftRank - rightRank;
            if (Number(left.tier || 0) !== Number(right.tier || 0)) return Number(left.tier || 0) - Number(right.tier || 0);
            return Number(left.cost || 0) - Number(right.cost || 0);
        });

    if (protectedNodes.length >= COMPACT_MAX_NODES_PER_ROUTE) {
        return sortNodes(protectedNodes);
    }

    return sortNodes([
        ...protectedNodes,
        ...optionalNodes.slice(0, Math.max(0, COMPACT_MAX_NODES_PER_ROUTE - protectedNodes.length)),
    ]);
}

function selectRouteNodesForMode(tree, route, payload, mode, stateById) {
    const routeNodes = sortNodes(tree.nodes.filter((node) => node.route === route.id));
    if (mode === 'complete') return routeNodes;
    return selectCompactRouteNodes(routeNodes, payload, stateById);
}

function chunkItems(items, chunkSize) {
    const chunks = [];
    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
}

function groupRouteNodesIntoRows(nodes) {
    const byTier = new Map();
    for (const node of sortNodes(nodes)) {
        const tier = Number(node.tier || 0);
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(node);
    }

    const rows = [];
    for (const tier of [...byTier.keys()].sort((left, right) => left - right)) {
        const chunks = chunkItems(sortNodes(byTier.get(tier)), COMPLETE_BOX_LAYOUT.maxNodesPerRow);
        chunks.forEach((chunk, chunkIndex) => {
            rows.push({
                tier,
                tierChunkIndex: chunkIndex,
                nodes: chunk,
            });
        });
    }
    return rows;
}

function branchColor(routeId, status = null) {
    if (status === 'locked') return STATUS_META.locked.fill;
    if (status === 'no_ph') return STATUS_META.no_ph.fill;
    if (status === 'approval') return STATUS_META.approval.fill;
    return COMPLETE_BRANCH_COLORS[routeId] || COLORS.card;
}

function completeNodeStroke(status = null) {
    if (status === 'owned') return COLORS.ink;
    if (status === 'available') return STATUS_META.available.stroke;
    if (status === 'no_ph') return STATUS_META.no_ph.stroke;
    if (status === 'approval') return STATUS_META.approval.stroke;
    return '#8f8a82';
}

function buildCompleteBoxLayout(payload) {
    const tree = payload.tree;
    const routes = tree.routes || [];
    const { manifest, filePath, mtimeMs } = readCompleteLayoutManifest(tree.id);

    if (manifest.treeId !== tree.id) {
        throw new Error(`Manifest de layout completo errado: esperado ${tree.id}, recebido ${manifest.treeId || 'N/A'}.`);
    }

    const canvas = manifest.canvas || {};
    const width = manifestNumber(canvas.width, 'canvas.width');
    const height = manifestNumber(canvas.height, 'canvas.height');
    if (width <= 0 || height <= 0) {
        throw new Error('Manifest de layout completo invalido: canvas precisa ter largura e altura positivas.');
    }

    const rootSpec = manifestBox(manifest.root, 'root');
    const rootBox = {
        id: `tree:${tree.id}:root`,
        label: String(tree.id || 'ARVORE').toUpperCase(),
        ...rootSpec,
    };

    const missingRoutes = [];
    const routeAnchors = {};
    for (const route of routes) {
        const routeSpec = manifest.routes?.[route.id];
        if (!routeSpec) {
            missingRoutes.push(route.id);
            continue;
        }
        routeAnchors[route.id] = {
            id: `route:${route.id}`,
            label: route.name || route.id,
            route,
            branch: routeSpec.branch || route.id,
            ...manifestBox(routeSpec, `routes.${route.id}`),
        };
    }

    const missingNodes = [];
    const positions = {};
    for (const node of tree.nodes || []) {
        const nodeSpec = manifest.nodes?.[node.id];
        if (!nodeSpec) {
            missingNodes.push(node.id);
            continue;
        }
        positions[node.id] = {
            branch: nodeSpec.branch || node.route || 'base',
            ...manifestBox(nodeSpec, `nodes.${node.id}`),
        };
    }

    if (missingRoutes.length || missingNodes.length) {
        throw new Error([
            `Manifest de layout completo incompleto para ${tree.id}:`,
            missingRoutes.length ? `rotas sem posicao: ${missingRoutes.join(', ')}` : null,
            missingNodes.length ? `nos sem posicao: ${missingNodes.join(', ')}` : null,
        ].filter(Boolean).join(' '));
    }

    const nodesByRoute = {};
    for (const route of routes) {
        nodesByRoute[route.id] = sortNodes(tree.nodes.filter((node) => node.route === route.id));
    }

    return {
        mode: 'complete',
        style: 'box',
        layoutSource: 'manifest',
        manifestPath: filePath,
        manifestVersion: manifest.version || 'complete-box-manifest-v1',
        manifestMtime: mtimeMs,
        config: {
            ...COMPLETE_BOX_LAYOUT,
        },
        width,
        height,
        routes,
        routeLayouts: [],
        routeAnchors,
        rootBox,
        nodesByRoute,
        positions,
        totalNodeCount: tree.nodes.length,
        drawnNodeCount: tree.nodes.filter((node) => positions[node.id]).length,
    };
}

function wrapWords(value, maxChars = 28, maxLines = 2) {
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

function textLines(lines, x, y, options = {}) {
    const size = options.size || 24;
    const weight = options.weight || 600;
    const fill = options.fill || COLORS.ink;
    const anchor = options.anchor || 'start';
    const lineHeight = options.lineHeight || Math.round(size * 1.23);
    const family = options.family || 'Arial, Helvetica, sans-serif';

    return [
        `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">`,
        ...lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeSvg(line)}</tspan>`),
        '</text>',
    ].join('');
}

function buildPayloadFromState(player, state, options = {}) {
    return {
        mode: normalizeMode(options.mode),
        playerId: state.playerId,
        playerName: player?.personagem_nome && player.personagem_nome !== '-'
            ? player.personagem_nome
            : player?.nome || state.playerId,
        tree: state.tree,
        ph: state.ph,
        ownedIds: state.ownedIds || [],
        nodeStates: state.nodeStates || [],
        routeProgress: state.routeProgress || [],
        availableNodes: state.availableNodes || [],
        ownedCount: state.ownedCount || 0,
        totalNodes: state.totalNodes || state.tree.nodes.length,
    };
}

function buildLayout(payload, options = {}) {
    const mode = normalizeMode(options.mode || payload.mode);
    if (mode === 'complete') {
        return buildCompleteBoxLayout(payload);
    }

    const layoutConfig = getLayoutConfig(mode);
    const tree = payload.tree;
    const routes = tree.routes || [];
    const routeCount = Math.max(1, routes.length);
    const stateById = getStateByNodeId(payload);
    const columns = {};
    const nodesByRoute = {};
    let maxRows = 1;

    routes.forEach((route, index) => {
        const x = layoutConfig.marginX + index * (layoutConfig.routeWidth + layoutConfig.routeGap);
        columns[route.id] = {
            route,
            x,
            centerX: x + layoutConfig.routeWidth / 2,
        };
        const routeNodes = selectRouteNodesForMode(tree, route, payload, mode, stateById);
        nodesByRoute[route.id] = routeNodes;
        maxRows = Math.max(maxRows, routeNodes.length);
    });

    const drawnNodeCount = Object.values(nodesByRoute)
        .reduce((sum, routeNodes) => sum + routeNodes.length, 0);

    const width = Math.max(
        1600,
        layoutConfig.marginX * 2 + routeCount * layoutConfig.routeWidth + (routeCount - 1) * layoutConfig.routeGap
    );
    const height = Math.max(
        1750,
        layoutConfig.nodesTop + maxRows * (layoutConfig.nodeHeight + layoutConfig.rowGap) + layoutConfig.footerHeight
    );

    const positions = {};
    routes.forEach((route) => {
        const column = columns[route.id];
        nodesByRoute[route.id].forEach((node, index) => {
            positions[node.id] = {
                x: column.x + (layoutConfig.routeWidth - layoutConfig.nodeWidth) / 2,
                y: layoutConfig.nodesTop + index * (layoutConfig.nodeHeight + layoutConfig.rowGap),
                w: layoutConfig.nodeWidth,
                h: layoutConfig.nodeHeight,
            };
        });
    });

    return {
        mode,
        layoutSource: 'compact-filter',
        config: layoutConfig,
        width,
        height,
        columns,
        nodesByRoute,
        positions,
        totalNodeCount: tree.nodes.length,
        drawnNodeCount,
    };
}

function renderBackground(layout) {
    return `
<rect width="${layout.width}" height="${layout.height}" fill="${COLORS.bg}"/>
<rect x="42" y="42" width="${layout.width - 84}" height="${layout.height - 84}" rx="38" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="2"/>
<path d="M92 206 H${layout.width - 92}" stroke="${COLORS.border}" stroke-width="2"/>
<path d="M92 ${layout.height - 175} H${layout.width - 92}" stroke="${COLORS.border}" stroke-width="2"/>`;
}

function renderHeader(payload, layout) {
    const subtitle = payload.tree.subtitle || payload.tree.description || 'rotas tecnicas Clover';
    return `
${textLines([displayTreeName(payload.tree)], 92, 118, { size: 60, weight: 900, fill: COLORS.ink })}
${textLines(wrapWords(subtitle, 92, 1), 96, 165, { size: 24, weight: 650, fill: COLORS.muted })}
${textLines([String(payload.playerName || payload.playerId)], layout.width - 94, 112, { size: 32, weight: 850, fill: COLORS.ink, anchor: 'end' })}
${textLines([`PH ${payload.ph.phAvailable}/${payload.ph.phAccumulated}  |  ${payload.ownedCount}/${payload.totalNodes} nos`], layout.width - 94, 153, { size: 23, weight: 750, fill: COLORS.muted, anchor: 'end' })}`;
}

function renderRouteHeader(payload, route, layout) {
    const layoutConfig = layout.config;
    const column = layout.columns[route.id];
    const progress = payload.routeProgress.find((item) => item.route.id === route.id);
    const routeName = route.name || route.id;
    const titleLines = wrapWords(routeName, layoutConfig.routeTitleMaxChars, layoutConfig.routeTitleMaxLines);
    const titleSize = titleLines.length > 1 ? layoutConfig.routeTitleWrappedSize : layoutConfig.routeTitleSingleSize;

    return `
<g>
  <rect x="${column.x}" y="${layoutConfig.routeTop}" width="${layoutConfig.routeWidth}" height="132" rx="18" fill="${COLORS.route}" stroke="${COLORS.ink}" stroke-width="2.4"/>
  ${textLines([String(route.symbol || '#')], column.x + 34, layoutConfig.routeTop + 55, { size: 36, weight: 900, anchor: 'middle' })}
  ${textLines(titleLines, column.x + 68, layoutConfig.routeTop + 45, { size: titleSize, weight: 900, lineHeight: 27 })}
  <rect x="${column.x + layoutConfig.routeWidth - 88}" y="${layoutConfig.routeTop + 78}" width="62" height="34" rx="8" fill="${COLORS.route}"/>
  ${textLines([`${progress?.owned || 0}/${progress?.total || 0}`], column.x + layoutConfig.routeWidth - 28, layoutConfig.routeTop + layoutConfig.routeCounterY, { size: 24, weight: 900, anchor: 'end' })}
  ${textLines(wrapWords(route.shortDescription || route.description || '', layoutConfig.routeDescriptionMaxChars, layoutConfig.routeDescriptionMaxLines), column.x + 28, layoutConfig.routeTop + 88, { size: 18, weight: 650, fill: COLORS.muted, lineHeight: 23 })}
</g>`;
}

function getStateByNodeId(payload) {
    return Object.fromEntries(payload.nodeStates.map((item) => [item.node.id, item]));
}

function nodeStatusLine(item) {
    const meta = statusMeta(item?.status);
    if (!item?.node) return meta.label;
    if (item.status === 'owned') return meta.label;
    if (item.status === 'approval') return `Aprovacao narrativa - ${Number(item.node.cost || 0)} PH`;
    return `${meta.label} - ${Number(item.node.cost || 0)} PH`;
}

function renderNode(item, position, layout) {
    const layoutConfig = layout.config;
    const node = item.node;
    const meta = statusMeta(item.status);
    const titleLines = wrapWords(node.name || node.id, layoutConfig.nodeTitleMaxChars, layoutConfig.nodeTitleMaxLines);
    const status = nodeStatusLine(item);

    return `
<g>
  <rect x="${position.x}" y="${position.y}" width="${position.w}" height="${position.h}" rx="14" fill="${meta.fill}" stroke="${meta.stroke}" stroke-width="2.8"/>
  <circle cx="${position.x + 26}" cy="${position.y + 28}" r="10" fill="${meta.dot}" stroke="${COLORS.ink}" stroke-width="1.4"/>
  ${textLines(titleLines, position.x + 48, position.y + 30, { size: layoutConfig.nodeTitleSize, weight: 900, fill: meta.text, lineHeight: layoutConfig.nodeTitleLineHeight })}
  ${textLines([status], position.x + 48, position.y + position.h - 17, { size: layoutConfig.nodeStatusSize, weight: 800, fill: meta.text })}
  ${node.requiresApproval ? textLines(['narrativa'], position.x + position.w - 22, position.y + position.h - 17, { size: 15, weight: 900, fill: meta.text, anchor: 'end' }) : ''}
</g>`;
}

function edgePath(from, to, index) {
    const startX = from.x + from.w / 2;
    const startY = from.y + from.h;
    const endX = to.x + to.w / 2;
    const endY = to.y;
    const offset = (index % 5 - 2) * 8;

    if (Math.abs(startX - endX) < 4) {
        return `M${startX} ${startY} V${endY}`;
    }

    const midY = Math.min(endY - 22, startY + Math.max(36, (endY - startY) / 2)) + offset;
    return `M${startX} ${startY} V${midY} H${endX} V${endY}`;
}

function renderEdges(payload, layout) {
    const stateById = getStateByNodeId(payload);
    return (payload.tree.edges || []).map((edge, index) => {
        const from = layout.positions[edge.from];
        const to = layout.positions[edge.to];
        if (!from || !to) return '';
        const toState = stateById[edge.to];
        const meta = statusMeta(toState?.status);
        return `<path d="${edgePath(from, to, index)}" fill="none" stroke="${meta.stroke}" stroke-width="3" stroke-opacity="0.56" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('\n');
}

function boxPort(box, side) {
    if (side === 'top') return [box.x + box.w / 2, box.y];
    if (side === 'bottom') return [box.x + box.w / 2, box.y + box.h];
    if (side === 'left') return [box.x, box.y + box.h / 2];
    if (side === 'right') return [box.x + box.w, box.y + box.h / 2];
    return [box.x + box.w / 2, box.y + box.h / 2];
}

function completeBoxPath(from, to, index = 0) {
    const fromCenterX = from.x + from.w / 2;
    const fromCenterY = from.y + from.h / 2;
    const toCenterX = to.x + to.w / 2;
    const toCenterY = to.y + to.h / 2;
    const offset = (index % 5 - 2) * 9;

    if (Math.abs(fromCenterY - toCenterY) < 105 && Math.abs(fromCenterX - toCenterX) > 150) {
        const [startX, startY] = boxPort(from, toCenterX > fromCenterX ? 'right' : 'left');
        const [endX, endY] = boxPort(to, toCenterX > fromCenterX ? 'left' : 'right');
        const midX = (startX + endX) / 2 + offset;
        return `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;
    }

    const [startX, startY] = boxPort(from, toCenterY < fromCenterY ? 'top' : 'bottom');
    const [endX, endY] = boxPort(to, toCenterY < fromCenterY ? 'bottom' : 'top');
    const midY = (startY + endY) / 2 + offset;
    return `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
}

function renderCompleteBoxText(lines, x, y, options = {}) {
    const size = options.size || 23;
    const weight = options.weight || 740;
    const fill = options.fill || COLORS.ink;
    const lineHeight = options.lineHeight || Math.round(size * 1.18);
    const family = options.family || 'Arial, Helvetica, sans-serif';
    const tspans = lines.map((line, index) => (
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeSvg(line)}</tspan>`
    )).join('');

    return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`;
}

function completeNodeStatusLine(item) {
    if (!item?.node) return 'Bloqueado';
    const meta = statusMeta(item.status);
    if (item.status === 'owned') return meta.label;
    if (item.status === 'approval') return `Aprovacao narrativa - ${Number(item.node.cost || 0)} PH`;
    return `${meta.label} - ${Number(item.node.cost || 0)} PH`;
}

function renderCompleteBoxNode(item, position) {
    const node = item.node;
    const routeId = node.route || 'base';
    const status = item.status || 'locked';
    const titleLines = wrapWords(node.name || node.id, COMPLETE_BOX_LAYOUT.nodeTitleMaxChars, COMPLETE_BOX_LAYOUT.nodeTitleMaxLines);
    const statusText = completeNodeStatusLine(item);
    const fill = branchColor(routeId, status);
    const stroke = completeNodeStroke(status);
    const strokeWidth = status === 'owned' ? 3.4 : 2.8;
    const textFill = status === 'locked' ? '#393631' : COLORS.ink;
    const titleY = position.y + position.h / 2 - (titleLines.length > 1 ? 11 : 7);

    return `<g>
  <rect x="${position.x}" y="${position.y}" width="${position.w}" height="${position.h}" rx="16" ry="16" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>
  ${renderCompleteBoxText(titleLines, position.x + position.w / 2, titleY, { size: 23, weight: status === 'owned' ? 860 : 760, fill: textFill, lineHeight: 23 })}
  ${renderCompleteBoxText([statusText], position.x + position.w / 2, position.y + position.h - 15, { size: 15, weight: 760, fill: statusMeta(status).text })}
</g>`;
}

function renderCompleteRouteAnchor(anchor) {
    const routeId = anchor.route?.id || 'base';
    return `<g>
  <rect x="${anchor.x}" y="${anchor.y}" width="${anchor.w}" height="${anchor.h}" rx="16" ry="16" fill="${branchColor(routeId)}" stroke="${COLORS.ink}" stroke-width="2.8"/>
  ${renderCompleteBoxText(wrapWords(anchor.label, 22, 2), anchor.x + anchor.w / 2, anchor.y + anchor.h / 2, { size: 24, weight: 860 })}
</g>`;
}

function renderCompleteRootBox(layout, payload) {
    const root = layout.rootBox;
    return `<g>
  <rect x="${root.x}" y="${root.y}" width="${root.w}" height="${root.h}" rx="16" ry="16" fill="${COLORS.root}" stroke="${COLORS.ink}" stroke-width="3.2"/>
  ${renderCompleteBoxText([String(payload.tree.id || 'ARVORE').toUpperCase()], root.x + root.w / 2, root.y + root.h / 2, { size: 25, weight: 900 })}
</g>`;
}

function renderCompleteGuideEdges(layout) {
    const routeEdges = Object.values(layout.routeAnchors).map((anchor, index) => {
        const pathData = completeBoxPath(layout.rootBox, anchor, index);
        return `<path d="${pathData}" class="edge guide"/>`;
    });

    const routeRootEdges = Object.values(layout.nodesByRoute).flatMap((routeNodes) => (
        routeNodes
            .filter((node) => !Array.isArray(node.requires) || node.requires.length === 0)
            .map((node, index) => {
                const anchor = layout.routeAnchors[node.route];
                const position = layout.positions[node.id];
                if (!anchor || !position) return '';
                return `<path d="${completeBoxPath(anchor, position, index)}" class="edge guide"/>`;
            })
    ));

    return [...routeEdges, ...routeRootEdges].join('\n');
}

function renderCompleteRealEdges(payload, layout) {
    const stateById = getStateByNodeId(payload);
    return (payload.tree.edges || []).map((edge, index) => {
        const from = layout.positions[edge.from];
        const to = layout.positions[edge.to];
        if (!from || !to) return '';
        const fromNode = payload.tree.nodesById?.[edge.from];
        const toNode = payload.tree.nodesById?.[edge.to];
        const isRequirement = Boolean(edge.label) || (fromNode && toNode && fromNode.route !== toNode.route);
        const toState = stateById[edge.to];
        const stroke = toState?.status === 'locked'
            ? COLORS.lineReq
            : completeNodeStroke(toState?.status);
        return `<path d="${completeBoxPath(from, to, index)}" class="edge ${isRequirement ? 'req' : 'main'}" stroke="${stroke}"/>`;
    }).join('\n');
}

function renderCompleteBoxTreeSvg(payload, layout) {
    const stateById = getStateByNodeId(payload);
    const subtitle = payload.tree.subtitle || payload.tree.description || 'rotas tecnicas Clover';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
<defs>
  <style>
    text { letter-spacing: 0; }
    .title {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 58px;
      font-weight: 900;
      fill: ${COLORS.ink};
    }
    .subtitle {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 23px;
      font-weight: 650;
      fill: ${COLORS.muted};
    }
    .edge {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .edge.main {
      stroke-width: 3.4;
      opacity: 0.76;
    }
    .edge.req {
      stroke-width: 2.6;
      opacity: 0.50;
      stroke-dasharray: 12 10;
    }
    .edge.guide {
      stroke: ${COLORS.line};
      stroke-width: 2.4;
      opacity: 0.28;
    }
  </style>
</defs>
<rect width="100%" height="100%" fill="${COLORS.bg}"/>
<rect x="46" y="46" width="${layout.width - 92}" height="${layout.height - 92}" rx="40" ry="40" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="2"/>
<text x="78" y="112" class="title">${escapeSvg(displayTreeName(payload.tree))}</text>
<text x="82" y="154" class="subtitle">${escapeSvg(wrapWords(subtitle, 92, 1)[0] || '')}</text>
${textLines([String(payload.playerName || payload.playerId)], layout.width - 84, 106, { size: 30, weight: 850, fill: COLORS.ink, anchor: 'end' })}
${textLines([`PH ${payload.ph.phAvailable}/${payload.ph.phAccumulated}  |  ${payload.ownedCount}/${payload.totalNodes} nos`], layout.width - 84, 146, { size: 22, weight: 750, fill: COLORS.muted, anchor: 'end' })}
<g id="edges">
${renderCompleteGuideEdges(layout)}
${renderCompleteRealEdges(payload, layout)}
</g>
<g id="routes">
${Object.values(layout.routeAnchors).map((anchor) => renderCompleteRouteAnchor(anchor)).join('\n')}
</g>
${renderCompleteRootBox(layout, payload)}
<g id="nodes">
${payload.tree.routes.map((route) => (
        layout.nodesByRoute[route.id]
            .map((node) => renderCompleteBoxNode(stateById[node.id], layout.positions[node.id]))
            .join('\n')
    )).join('\n')}
</g>
</svg>`;
}

function renderLegend(layout) {
    const items = ['owned', 'available', 'no_ph', 'locked', 'approval'];
    const y = layout.height - 126;
    const startX = 112;
    return `
<g>
  ${textLines(['Legenda'], startX, y, { size: 25, weight: 900 })}
  ${items.map((status, index) => {
        const meta = STATUS_META[status];
        const x = startX + 140 + index * 220;
        return `
  <g>
    <circle cx="${x}" cy="${y - 7}" r="12" fill="${meta.dot}" stroke="${COLORS.ink}" stroke-width="1.2"/>
    ${textLines([meta.label], x + 24, y, { size: 20, weight: 750, fill: COLORS.muted })}
  </g>`;
    }).join('')}
  ${textLines(['Use .#arvore <id> texto para forcar a versao textual. .#rota continua textual.'], layout.width - 96, y + 58, { size: 20, weight: 650, fill: COLORS.muted, anchor: 'end' })}
</g>`;
}

function renderTreeVisualSvg(payload, options = {}) {
    const mode = normalizeMode(options.mode || payload.mode);
    const approvedSvg = renderApprovedTreeVisualSvg(payload);
    if (approvedSvg) return approvedSvg;

    const layout = buildLayout(payload, { mode });
    const stateById = getStateByNodeId(payload);

    if (mode === 'complete') {
        return renderCompleteBoxTreeSvg(payload, layout);
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
<defs>
  <style>
    text { letter-spacing: 0; }
  </style>
</defs>
${renderBackground(layout)}
${renderHeader(payload, layout)}
${payload.tree.routes.map((route) => renderRouteHeader(payload, route, layout)).join('\n')}
<g opacity="0.92">${renderEdges(payload, layout)}</g>
${payload.tree.routes.map((route) => (
        layout.nodesByRoute[route.id]
            .map((node) => renderNode(stateById[node.id], layout.positions[node.id], layout))
            .join('\n')
    )).join('\n')}
${renderLegend(layout)}
</svg>`;
}

async function renderTreeVisualPng(payload, options = {}) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const approvedPng = await renderApprovedTreeVisualPng(payload);
    if (approvedPng) return approvedPng;

    const svg = renderTreeVisualSvg(payload, options);
    return sharp(Buffer.from(svg)).png().toBuffer();
}

function getTreeVisualRenderMeta(payload, options = {}) {
    const mode = normalizeMode(options.mode || payload.mode);
    const approvedMeta = getApprovedTreeVisualMeta(payload);
    if (approvedMeta) return approvedMeta;

    const layout = buildLayout(payload, { mode });

    return {
        mode,
        layoutSource: layout.layoutSource || (mode === 'complete' ? 'manifest' : 'compact-filter'),
        manifestPath: layout.manifestPath || null,
        manifestVersion: layout.manifestVersion || null,
        dimensions: {
            width: layout.width,
            height: layout.height,
        },
        nodeCount: {
            total: layout.totalNodeCount,
            drawn: layout.drawnNodeCount,
        },
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

function getTreeVisualCacheKey(payload, options = {}) {
    const mode = normalizeMode(options.mode || payload.mode);
    const hashPayload = {
        rendererVersion: RENDERER_VERSION,
        mode,
        playerId: payload.playerId,
        treeId: payload.tree.id,
        treeVersion: getTreeJsonMtime(payload.tree.id),
        layoutManifestVersion: mode === 'complete'
            ? getCompleteLayoutManifestMtime(payload.tree.id)
            : null,
        phAvailable: payload.ph.phAvailable,
        phAccumulated: payload.ph.phAccumulated,
        ownedIds: [...payload.ownedIds].sort(),
        nodeStatuses: payload.nodeStates
            .map((item) => [
                item.node.id,
                item.status,
                item.missingPh || 0,
                ...(item.missingRequirements || []),
            ])
            .sort((left, right) => left[0].localeCompare(right[0])),
    };

    return crypto.createHash('sha1')
        .update(JSON.stringify(hashPayload))
        .digest('hex')
        .slice(0, 16);
}

function getTreeVisualCachePath(playerId, treeId, hash, mode = 'compact') {
    return path.join(
        CACHE_DIR,
        `${sanitizeFilePart(playerId)}_${sanitizeFilePart(treeId)}_${sanitizeFilePart(normalizeMode(mode))}_${hash}.png`
    );
}

async function renderTreeVisualPngCached(db, playerId, treeId = 'mana', options = {}) {
    const mode = normalizeMode(options.mode);
    const state = await getTreeState(db, playerId, treeId);
    const player = await db.get('SELECT id, nome, personagem_nome FROM jogadores WHERE id = ?', [playerId]);
    const payload = buildPayloadFromState(player, state, { mode });
    const meta = getTreeVisualRenderMeta(payload, { mode });
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const approvedHash = approvedTreeVisualCacheKey(payload);
    if (approvedHash) {
        const imagePath = approvedTreeVisualCachePath(payload.tree.id, approvedHash, playerId, mode);
        if (fs.existsSync(imagePath)) {
            return {
                cacheHit: true,
                path: imagePath,
                hash: approvedHash,
                payload,
                ...meta,
            };
        }

        fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        const buffer = await renderTreeVisualPng(payload, { mode });
        fs.writeFileSync(imagePath, buffer);
        return {
            cacheHit: false,
            path: imagePath,
            hash: approvedHash,
            payload,
            ...meta,
            buffer,
        };
    }

    const hash = getTreeVisualCacheKey(payload, { mode });
    const imagePath = getTreeVisualCachePath(playerId, payload.tree.id, hash, mode);

    if (fs.existsSync(imagePath)) {
        return {
            cacheHit: true,
            path: imagePath,
            hash,
            payload,
            ...meta,
        };
    }

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    const buffer = await renderTreeVisualPng(payload, { mode });
    fs.writeFileSync(imagePath, buffer);

    return {
        cacheHit: false,
        path: imagePath,
        hash,
        payload,
        ...meta,
        buffer,
    };
}

module.exports = {
    CACHE_DIR,
    RENDERER_VERSION,
    buildLayout,
    buildPayloadFromState,
    getTreeVisualRenderMeta,
    getTreeVisualCacheKey,
    getTreeVisualCachePath,
    renderTreeVisualPng,
    renderTreeVisualPngCached,
    renderTreeVisualSvg,
};
