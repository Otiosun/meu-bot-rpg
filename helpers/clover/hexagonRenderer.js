const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const approvedHexagon = require('./approvedVisuals/manaHexagonRenderer.v3.textSafe');

const RENDERER_VERSION = 'hexagon-v4-six-axes';
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'hexagons');

function sanitizeFilePart(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function normalizeHexagonValues(hexagon) {
    return {
        controle: Number(hexagon?.controle || 1),
        precisao: Number(hexagon?.precisao || 1),
        estabilidade: Number(hexagon?.estabilidade || 1),
        retencao: Number(hexagon?.retencao || 1),
        alcance: Number(hexagon?.alcance || 1),
        escala: Number(hexagon?.escala || 1),
    };
}

function getApprovedRendererMtime() {
    try {
        return fs.statSync(require.resolve('./approvedVisuals/manaHexagonRenderer.v3.textSafe')).mtimeMs;
    } catch {
        return 0;
    }
}

function renderHexagonSvg(hexagon) {
    return approvedHexagon.renderManaHexagonSvg(normalizeHexagonValues(hexagon));
}

function getHexagonCacheKey(playerId, hexagon) {
    const payload = {
        rendererVersion: RENDERER_VERSION,
        approvedRendererVersion: getApprovedRendererMtime(),
        playerId,
        values: normalizeHexagonValues(hexagon),
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function getHexagonCachePath(playerId, hash) {
    return path.join(CACHE_DIR, `${sanitizeFilePart(playerId)}_${hash}.png`);
}

async function renderHexagonPng(hexagon) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const svg = renderHexagonSvg(hexagon);
    return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderHexagonPngCached(playerId, hexagon) {
    const hash = getHexagonCacheKey(playerId, hexagon);
    const imagePath = getHexagonCachePath(playerId, hash);

    if (fs.existsSync(imagePath)) {
        return { cacheHit: true, path: imagePath, hash };
    }

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    const buffer = await renderHexagonPng(hexagon);
    fs.writeFileSync(imagePath, buffer);
    return { cacheHit: false, path: imagePath, hash, buffer };
}

module.exports = {
    AXES: approvedHexagon.AXES,
    CACHE_DIR,
    RENDERER_VERSION,
    getHexagonCacheKey,
    getHexagonCachePath,
    normalizeHexagonValues,
    renderHexagonPng,
    renderHexagonPngCached,
    renderHexagonSvg,
};
