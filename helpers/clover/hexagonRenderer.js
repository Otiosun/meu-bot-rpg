const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const legacyHexagon = require('./approvedVisuals/manaHexagonRenderer.v3.textSafe');
const masterOverlay = require('./approvedVisuals/manaHexagonRenderer.v4.masterOverlay');

const RENDERER_VERSION = 'hexagon-v4-master-overlay';
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
        percepcao: Number(hexagon?.percepcao || 1),
        retencao: Number(hexagon?.retencao || 1),
        emissao: Number(hexagon?.emissao || 1),
        controle: Number(hexagon?.controle || 1),
        pressao: Number(hexagon?.pressao || 1),
        alcance: Number(hexagon?.alcance || 1),
    };
}

function hasMasterArt() {
    const masterPath = process.env.CLOVER_HEXAGON_MASTER_PATH || masterOverlay.MASTER_PATH;
    return fs.existsSync(masterPath);
}

function renderHexagonSvg(hexagon) {
    // Compatibilidade para testes/ferramentas que ainda consomem SVG completo.
    // O PNG enviado pelo comando usa a arte-master v4 quando ela está disponível.
    return legacyHexagon.renderManaHexagonSvg(normalizeHexagonValues(hexagon));
}

function getHexagonCacheKey(playerId, hexagon) {
    const payload = {
        rendererVersion: RENDERER_VERSION,
        masterMode: hasMasterArt(),
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

    const values = normalizeHexagonValues(hexagon);
    if (hasMasterArt()) {
        return masterOverlay.renderManaHexagonPng(values);
    }

    const svg = legacyHexagon.renderManaHexagonSvg(values);
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
    AXES: masterOverlay.AXES,
    CACHE_DIR,
    RENDERER_VERSION,
    getHexagonCacheKey,
    getHexagonCachePath,
    normalizeHexagonValues,
    renderHexagonPng,
    renderHexagonPngCached,
    renderHexagonSvg,
};
