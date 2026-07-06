const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RENDERER_VERSION = 'fisico-tree-rework-v1-html-approved';
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'trees');
const HTML_PATH = path.join(__dirname, 'fisico_tree_v8.html');

const STATUS_STYLE = {
    owned: { fill: '#d9ead7', stroke: '#2f6847', dot: '#2f6847', width: 5.1 },
    available: { fill: '#dcecf2', stroke: '#2d6981', dot: '#2d6981', width: 4.6 },
    no_ph: { fill: '#f5ead1', stroke: '#9a6c1d', dot: '#9a6c1d', width: 4.2 },
    locked: { fill: '#ece9e2', stroke: '#8f8a82', dot: '#8f8a82', width: 2.6 },
    approval: { fill: '#eee3ef', stroke: '#744f7f', dot: '#744f7f', width: 4.8 },
};

function sanitizeFilePart(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function escapeSvg(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function statMtime(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function getTreeJsonMtime() {
    return statMtime(path.join(process.cwd(), 'data', 'clover', 'trees', 'fisico.json'));
}

function readHtml() {
    return fs.readFileSync(HTML_PATH, 'utf8');
}

function extractSvg() {
    const match = readHtml().match(/<svg\b[\s\S]*?<\/svg>/i);
    if (!match) throw new Error(`SVG nao encontrado em ${HTML_PATH}`);
    return match[0];
}

function getHtmlNodeIds(svg = extractSvg()) {
    return [...svg.matchAll(/<g class="node[^"]*"[^>]*\sdata-node-id="([^"]+)"/g)]
        .map((match) => match[1]);
}

function nodeStateById(payload) {
    return Object.fromEntries((payload?.nodeStates || []).map((item) => [item.node.id, item]));
}

function statusMeta(status) {
    return STATUS_STYLE[status] || STATUS_STYLE.locked;
}

function setSvgAttribute(tag, name, value) {
    const pattern = new RegExp(`\\s${name}="[^"]*"`);
    if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${value}"`);
    return tag.replace(/\/?>$/, (suffix) => ` ${name}="${value}"${suffix}`);
}

function patchNodeGroup(group, nodeId, item) {
    const style = statusMeta(item?.status || 'locked');
    const title = item?.node?.name || nodeId;
    const status = item?.status || 'locked';

    let patched = group.replace(
        /<g class="node([^"]*)"([^>]*)>/,
        (tag, classSuffix, attrs) => {
            let next = `<g class="node${classSuffix}"${attrs}>`;
            next = setSvgAttribute(next, 'data-node-id', escapeSvg(nodeId));
            next = setSvgAttribute(next, 'data-status', escapeSvg(status));
            return `${next}<title>${escapeSvg(title)} - ${escapeSvg(status)}</title>`;
        }
    );

    patched = patched.replace(/<rect\b[^>]*\/?>/i, (rect) => {
        let next = rect;
        next = setSvgAttribute(next, 'fill', style.fill);
        next = setSvgAttribute(next, 'stroke', style.stroke);
        next = setSvgAttribute(next, 'stroke-width', style.width);
        return next;
    });

    const dot = `<circle cx="26" cy="26" r="9" fill="${style.dot}" stroke="#171717" stroke-width="1.2"/>`;
    return patched.replace(/(<rect\b[^>]*\/?>)/i, `$1\n${dot}`);
}

function renderLegend() {
    const items = [
        ['owned', 'Comprado'],
        ['available', 'Disponível'],
        ['no_ph', 'Sem PH'],
        ['locked', 'Bloqueado'],
        ['approval', 'Aprovação narrativa'],
    ];

    return `
<g id="fisico-v8-status-legend" transform="translate(4080 300)">
  <rect x="0" y="0" width="2040" height="92" rx="20" ry="20" fill="#fffdf8" stroke="#171717" stroke-width="2" opacity="0.94"/>
  <text x="32" y="57" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="900" fill="#171717">STATUS</text>
  ${items.map(([status, label], index) => {
        const style = statusMeta(status);
        const x = 170 + index * 360;
        return `<g transform="translate(${x} 0)"><circle cx="0" cy="47" r="13" fill="${style.dot}" stroke="#171717" stroke-width="1.2"/><text x="22" y="55" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="800" fill="#171717">${escapeSvg(label)}</text></g>`;
    }).join('\n  ')}
</g>`;
}

function validatePayloadNodeCount(payload, htmlNodeIds) {
    const total = Number(payload?.tree?.nodes?.length || 0);
    if (total !== htmlNodeIds.length) {
        throw new Error(`Fisico rework esperava ${htmlNodeIds.length} nos no JSON, mas recebeu ${total}.`);
    }

    const ids = new Set(payload.tree.nodes.map((node) => node.id));
    const missing = htmlNodeIds.filter((nodeId) => !ids.has(nodeId));
    if (missing.length) {
        throw new Error(`Fisico rework HTML mapeia nos ausentes no JSON: ${missing.join(', ')}.`);
    }
}

function renderFisicoV8Svg(payload = {}) {
    const baseSvg = extractSvg();
    const htmlNodeIds = getHtmlNodeIds(baseSvg);
    validatePayloadNodeCount(payload, htmlNodeIds);
    const states = nodeStateById(payload);
    let nodeIndex = 0;
    let svg = baseSvg.replace(/<g class="node[^"]*"[^>]*>[\s\S]*?<\/g>/g, (group) => {
        const nodeId = htmlNodeIds[nodeIndex];
        nodeIndex += 1;
        if (!nodeId) return group;
        return patchNodeGroup(group, nodeId, states[nodeId]);
    });

    if (nodeIndex !== htmlNodeIds.length) {
        throw new Error(`Fisico rework HTML deveria ter ${htmlNodeIds.length} nos, mas renderizou ${nodeIndex}.`);
    }

    return svg.replace('</svg>', `${renderLegend()}\n</svg>`);
}

async function renderFisicoV8Png(payload = {}) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    return sharp(Buffer.from(renderFisicoV8Svg(payload))).png().toBuffer();
}

function getFisicoV8RenderMeta() {
    const svg = extractSvg();
    const nodeIds = getHtmlNodeIds(svg);
    return {
        mode: 'approved',
        layoutSource: 'approved:fisico_tree_rework_v1_html',
        model: 'fisico_tree_rework_v1',
        approvedPath: HTML_PATH,
        dimensions: { width: 6400, height: 4100 },
        nodeCount: {
            total: nodeIds.length,
            drawn: nodeIds.length,
        },
        edgeCount: (svg.match(/<path\b/g) || []).length,
    };
}

function getFisicoV8CacheKey(payload = {}) {
    const hashPayload = {
        rendererVersion: RENDERER_VERSION,
        htmlVersion: statMtime(HTML_PATH),
        treeVersion: getTreeJsonMtime(),
        playerId: payload.playerId,
        phAvailable: payload.ph?.phAvailable,
        phAccumulated: payload.ph?.phAccumulated,
        ownedIds: [...(payload.ownedIds || [])].sort(),
        nodeStatuses: (payload.nodeStates || [])
            .map((item) => [
                item.node.id,
                item.status,
                item.missingPh || 0,
                ...(item.missingRequirements || []),
            ])
            .sort((left, right) => left[0].localeCompare(right[0])),
    };
    return crypto.createHash('sha1').update(JSON.stringify(hashPayload)).digest('hex').slice(0, 16);
}

function getFisicoV8CachePath(playerId, hash) {
    return path.join(
        CACHE_DIR,
        `${sanitizeFilePart(playerId)}_fisico_v8_${hash}.png`
    );
}

module.exports = {
    CACHE_DIR,
    HTML_PATH,
    NODE_IDS: getHtmlNodeIds(),
    RENDERER_VERSION,
    getFisicoV8CacheKey,
    getFisicoV8CachePath,
    getFisicoV8RenderMeta,
    renderFisicoV8Png,
    renderFisicoV8Svg,
};
