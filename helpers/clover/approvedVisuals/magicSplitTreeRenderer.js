const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RENDERER_VERSION = 'magic-split-html-approved-v1';
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'trees');
const APPROVED_DIR = path.join(__dirname, 'magic_split');

const TREE_HTML_FILES = {
    suporte: 'arvore_suporte_separada.html',
    criacao: 'arvore_criacao_separada.html',
    reforco: 'arvore_reforco_separada.html',
};

const STATUS_META = {
    owned: {
        label: 'Comprado',
        fill: '#d9ead7',
        stroke: '#2f6847',
        dot: '#2f6847',
    },
    available: {
        label: 'Disponivel',
        fill: '#dcecf2',
        stroke: '#2d6981',
        dot: '#2d6981',
    },
    no_ph: {
        label: 'Sem PH',
        fill: '#f5ead1',
        stroke: '#9a6c1d',
        dot: '#9a6c1d',
    },
    locked: {
        label: 'Bloqueado',
        fill: '#ece9e2',
        stroke: '#7d766d',
        dot: '#7d766d',
    },
    approval: {
        label: 'Aprovacao narrativa',
        fill: '#eee3ef',
        stroke: '#744f7f',
        dot: '#744f7f',
    },
};

const STATUS_ORDER = ['owned', 'available', 'no_ph', 'locked', 'approval'];

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

function isMagicSplitTreeId(treeId) {
    return Boolean(TREE_HTML_FILES[String(treeId || '').toLowerCase()]);
}

function getMagicSplitHtmlPath(treeId) {
    const key = String(treeId || '').toLowerCase();
    const fileName = TREE_HTML_FILES[key];
    if (!fileName) {
        throw new Error(`Arvore de magia separada sem HTML aprovado: ${treeId}`);
    }
    return path.join(APPROVED_DIR, fileName);
}

function statMtime(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function getTreeJsonMtime(treeId) {
    return statMtime(path.join(process.cwd(), 'data', 'clover', 'trees', `${treeId}.json`));
}

function readApprovedHtml(treeId) {
    const filePath = getMagicSplitHtmlPath(treeId);
    return {
        filePath,
        html: fs.readFileSync(filePath, 'utf8'),
    };
}

function extractStyle(html) {
    return html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] || '';
}

function extractSvg(html) {
    const match = html.match(/<svg\b[\s\S]*?<\/svg>/i);
    if (!match) throw new Error('HTML aprovado sem SVG interno.');
    return match[0];
}

function injectSvgStyle(svg, style) {
    if (!style.trim()) return svg;
    return svg.replace(
        /(<svg\b[^>]*>)/i,
        `$1\n<defs><style><![CDATA[\n${style}\ntext { letter-spacing: 0; }\n]]></style></defs>`
    );
}

function getSvgDimensions(svg) {
    const width = Number(svg.match(/\bwidth="(\d+)"/)?.[1] || 0);
    const height = Number(svg.match(/\bheight="(\d+)"/)?.[1] || 0);
    if (!width || !height) {
        const viewBox = svg.match(/\bviewBox="[^"]*\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/);
        return {
            width: Number(viewBox?.[1] || 0),
            height: Number(viewBox?.[2] || 0),
        };
    }
    return { width, height };
}

function countNodeGroups(svg) {
    return (svg.match(/<g class="node">/g) || []).length;
}

function statusMeta(status) {
    return STATUS_META[status] || STATUS_META.locked;
}

function setSvgAttribute(tag, name, value) {
    const pattern = new RegExp(`\\s${name}="[^"]*"`);
    if (pattern.test(tag)) return tag.replace(pattern, ` ${name}="${value}"`);
    return tag.replace(/\/>$/, ` ${name}="${value}"/>`);
}

function patchNodeRect(rect, item) {
    const meta = statusMeta(item?.status);
    let patched = rect;
    patched = setSvgAttribute(patched, 'fill', meta.fill);
    patched = setSvgAttribute(patched, 'stroke', meta.stroke);
    patched = setSvgAttribute(patched, 'stroke-width', item?.status === 'owned' ? '3.4' : '2.5');
    return patched;
}

function decorateNodeGroup(group, item) {
    const title = item?.node
        ? `<title>${escapeSvg(item.node.name)} - ${escapeSvg(statusMeta(item.status).label)}</title>`
        : '';
    const opened = group.replace('<g class="node">', `<g class="node" data-node-id="${escapeSvg(item?.node?.id || '')}" data-status="${escapeSvg(item?.status || 'locked')}">${title}`);
    return opened.replace(/<rect\b[^>]*\/>/, (rect) => patchNodeRect(rect, item));
}

function injectStatusIntoNodes(svg, payload) {
    const nodeStates = payload.nodeStates || [];
    let index = 0;
    return svg.replace(/<g class="node">[\s\S]*?<\/g>/g, (group) => {
        const item = nodeStates[index] || null;
        index += 1;
        return decorateNodeGroup(group, item);
    });
}

function injectLegend(svg, payload) {
    const dimensions = getSvgDimensions(svg);
    const x = Math.max(70, dimensions.width - 1200);
    const y = 54;
    const itemWidth = 222;
    const legend = `
<g id="clover-status-legend" transform="translate(${x} ${y})">
  <rect x="0" y="0" width="1130" height="78" rx="0" ry="0" fill="#fbfbf8" stroke="#171717" stroke-width="2" opacity="0.92"/>
  <text x="24" y="48" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="900" fill="#171717">STATUS</text>
  ${STATUS_ORDER.map((status, index) => {
        const meta = statusMeta(status);
        const itemX = 140 + index * itemWidth;
        return `
  <g transform="translate(${itemX} 0)">
    <circle cx="0" cy="39" r="12" fill="${meta.dot}" stroke="#171717" stroke-width="1.2"/>
    <text x="22" y="46" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="800" fill="#171717">${escapeSvg(meta.label)}</text>
  </g>`;
    }).join('')}
  <text x="1108" y="68" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="14" font-weight="700" fill="#5c5850">${escapeSvg(payload.playerName || payload.playerId || '')}</text>
</g>`;
    return svg.replace('</svg>', `${legend}\n</svg>`);
}

function renderMagicSplitTreeSvg(payload) {
    const treeId = payload?.tree?.id;
    if (!isMagicSplitTreeId(treeId)) {
        throw new Error(`Arvore nao usa visual separado aprovado: ${treeId}`);
    }
    const { html } = readApprovedHtml(treeId);
    const baseSvg = injectSvgStyle(extractSvg(html), extractStyle(html));
    const withStatuses = injectStatusIntoNodes(baseSvg, payload);
    return injectLegend(withStatuses, payload);
}

async function renderMagicSplitTreePng(payload) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    return sharp(Buffer.from(renderMagicSplitTreeSvg(payload))).png().toBuffer();
}

function getMagicSplitTreeRenderMeta(payload) {
    const treeId = payload?.tree?.id;
    const { filePath, html } = readApprovedHtml(treeId);
    const svg = extractSvg(html);
    const dimensions = getSvgDimensions(svg);
    const drawn = countNodeGroups(svg);
    const total = Number(payload?.tree?.nodes?.length || 0);
    return {
        mode: 'approved',
        layoutSource: `approved:magic_split_html:${treeId}`,
        model: `magic_split_${treeId}`,
        approvedPath: filePath,
        dimensions,
        nodeCount: {
            total,
            drawn,
        },
        edgeCount: (svg.match(/<path\b/g) || []).length,
    };
}

function getMagicSplitTreeCacheKey(payload) {
    const treeId = payload?.tree?.id;
    const hashPayload = {
        rendererVersion: RENDERER_VERSION,
        treeId,
        htmlVersion: statMtime(getMagicSplitHtmlPath(treeId)),
        treeVersion: getTreeJsonMtime(treeId),
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

function getMagicSplitTreeCachePath(playerId, treeId, hash) {
    return path.join(
        CACHE_DIR,
        `${sanitizeFilePart(playerId)}_${sanitizeFilePart(treeId)}_magic_split_${hash}.png`
    );
}

async function renderMagicSplitTreePngCached(payload) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const hash = getMagicSplitTreeCacheKey(payload);
    const imagePath = getMagicSplitTreeCachePath(payload.playerId, payload.tree.id, hash);
    const meta = getMagicSplitTreeRenderMeta(payload);
    if (fs.existsSync(imagePath)) {
        return { cacheHit: true, path: imagePath, hash, payload, ...meta };
    }

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    const buffer = await renderMagicSplitTreePng(payload);
    fs.writeFileSync(imagePath, buffer);
    return { cacheHit: false, path: imagePath, hash, payload, buffer, ...meta };
}

module.exports = {
    APPROVED_DIR,
    CACHE_DIR,
    RENDERER_VERSION,
    TREE_HTML_FILES,
    getMagicSplitHtmlPath,
    getMagicSplitTreeCacheKey,
    getMagicSplitTreeCachePath,
    getMagicSplitTreeRenderMeta,
    isMagicSplitTreeId,
    renderMagicSplitTreePng,
    renderMagicSplitTreePngCached,
    renderMagicSplitTreeSvg,
};
