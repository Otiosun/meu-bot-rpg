const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RENDERER_VERSION = 'magic-tree-stair-v3-approved';
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'trees');
const SVG_PATH = path.join(__dirname, 'magic_tree_stair_v3.svg');
const DATA_PATH = path.join(__dirname, 'magic_tree_stair_data_v3.json');
const LAYOUT_CHECK_PATH = path.join(__dirname, 'magic_tree_stair_v3.layout_check.json');

function sanitizeFilePart(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function statMtime(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function readJson(filePath, fallback = {}) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function renderMagicStairSvg() {
    return fs.readFileSync(SVG_PATH, 'utf8');
}

function getSvgDimensions(svg = renderMagicStairSvg()) {
    const width = Number(svg.match(/\bwidth="(\d+)"/)?.[1] || 5400);
    const height = Number(svg.match(/\bheight="(\d+)"/)?.[1] || 3050);
    return { width, height };
}

function getMagicStairRenderMeta() {
    const data = readJson(DATA_PATH);
    const layoutCheck = readJson(LAYOUT_CHECK_PATH, data.layoutCheck || {});
    const dimensions = getSvgDimensions();
    return {
        mode: 'approved',
        layoutSource: 'approved:magic_tree_stair_v3',
        model: 'magic_tree_stair_v3',
        dimensions,
        nodeCount: {
            total: Number(layoutCheck.node_count || data.layoutCheck?.node_count || data.nodes?.length || 0),
            drawn: Number(layoutCheck.node_count || data.layoutCheck?.node_count || data.nodes?.length || 0),
        },
        edgeCount: Number(layoutCheck.edge_count || data.layoutCheck?.edge_count || data.edges?.length || 0),
    };
}

function getMagicStairCacheKey() {
    const payload = {
        rendererVersion: RENDERER_VERSION,
        svgVersion: statMtime(SVG_PATH),
        dataVersion: statMtime(DATA_PATH),
        layoutCheckVersion: statMtime(LAYOUT_CHECK_PATH),
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function getMagicStairCachePath(hash) {
    return path.join(CACHE_DIR, `${sanitizeFilePart('approved_magic_tree_stair_v3')}_${hash}.png`);
}

async function renderMagicStairPng() {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    return sharp(Buffer.from(renderMagicStairSvg())).png().toBuffer();
}

async function renderMagicStairPngCached() {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const hash = getMagicStairCacheKey();
    const imagePath = getMagicStairCachePath(hash);
    const meta = getMagicStairRenderMeta();

    if (fs.existsSync(imagePath)) {
        return { cacheHit: true, path: imagePath, hash, ...meta };
    }

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    const buffer = await renderMagicStairPng();
    fs.writeFileSync(imagePath, buffer);
    return { cacheHit: false, path: imagePath, hash, buffer, ...meta };
}

module.exports = {
    CACHE_DIR,
    RENDERER_VERSION,
    SVG_PATH,
    DATA_PATH,
    LAYOUT_CHECK_PATH,
    getMagicStairCacheKey,
    getMagicStairCachePath,
    getMagicStairRenderMeta,
    renderMagicStairPng,
    renderMagicStairPngCached,
    renderMagicStairSvg,
};
