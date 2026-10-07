const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const WIDTH = 1448;
const HEIGHT = 1086;
const LEVELS = 5;
const CENTER = { x: 723, y: 549 };
const RADIUS = 242;
const MASTER_PATH = path.join(process.cwd(), 'assets', 'clover', 'hexagon', 'mana-hexagon-master-clean.webp');

const AXES = [
  { id: 'percepcao', angle: -90, value: [858, 170], dots: [[617,221],[642,221],[667,221],[693,221],[718,221]] },
  { id: 'emissao', angle: -30, value: [1321, 350], dots: [[1129,403],[1154,403],[1178,403],[1203,403],[1227,403]] },
  { id: 'alcance', angle: 30, value: [1321, 715], dots: [[1129,784],[1154,784],[1178,784],[1203,784],[1227,784]] },
  { id: 'retencao', angle: 90, value: [918, 902], dots: [[594,978],[619,978],[645,978],[670,978],[695,978]] },
  { id: 'controle', angle: 150, value: [381, 714], dots: [[172,786],[197,786],[221,786],[247,786],[272,786]] },
  { id: 'pressao', angle: 210, value: [379, 349], dots: [[155,403],[179,403],[203,403],[229,403],[253,403]] },
];

function clampLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(LEVELS, Math.round(number)));
}

function normalizeValues(values = {}) {
  return Object.fromEntries(AXES.map((axis) => [axis.id, clampLevel(values[axis.id])]));
}

function pointFor(axis, value) {
  const radians = axis.angle * Math.PI / 180;
  const radius = RADIUS * (clampLevel(value) / LEVELS);
  return [
    CENTER.x + Math.cos(radians) * radius,
    CENTER.y + Math.sin(radians) * radius,
  ];
}

function renderOverlaySvg(values = {}) {
  const normalized = normalizeValues(values);
  const vertices = AXES.map((axis) => pointFor(axis, normalized[axis.id]));
  const polygon = vertices.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const points = vertices.map(([x, y]) => (
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7.2" fill="#fff3b8" stroke="#18130d" stroke-width="2.1"/>`
  )).join('');

  const valuesSvg = AXES.map((axis) => {
    const value = normalized[axis.id];
    return `<text x="${axis.value[0]}" y="${axis.value[1]}" text-anchor="middle" dominant-baseline="middle" class="value">${value}/5</text>`;
  }).join('');

  const dots = AXES.flatMap((axis) => {
    const value = normalized[axis.id];
    return axis.dots.slice(0, value).map(([x, y]) => (
      `<circle cx="${x}" cy="${y}" r="7.4" fill="#d9aa32" stroke="#2a2011" stroke-width="1.35"/>`
      + `<circle cx="${x - 1.5}" cy="${y - 1.8}" r="2.1" fill="#f6dfa0" opacity="0.70"/>`
    ));
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <style>.value { font-family: Georgia, 'DejaVu Serif', serif; font-size: 27px; font-weight: 700; fill: #1a1713; }</style>
      <mask id="polygonHole"><rect width="100%" height="100%" fill="white"/><circle cx="${CENTER.x}" cy="${CENTER.y}" r="58" fill="black"/></mask>
      <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <polygon points="${polygon}" fill="#e4bf47" fill-opacity="0.25" stroke="#c89d2e" stroke-width="3.1" stroke-linejoin="round" mask="url(#polygonHole)"/>
    <polygon points="${polygon}" fill="none" stroke="#f1d87a" stroke-opacity="0.34" stroke-width="1.1" filter="url(#softGlow)" mask="url(#polygonHole)"/>
    ${points}${valuesSvg}${dots}
  </svg>`;
}

function getMasterPath(options = {}) {
  return options.masterPath || process.env.CLOVER_HEXAGON_MASTER_PATH || MASTER_PATH;
}

async function renderManaHexagonPng(values, options = {}) {
  const masterPath = getMasterPath(options);
  if (!fs.existsSync(masterPath)) {
    throw new Error(`Hexagon master art not found: ${masterPath}`);
  }

  const overlay = Buffer.from(renderOverlaySvg(values));
  const pipeline = sharp(masterPath).composite([{ input: overlay, top: 0, left: 0 }]).png({ compressionLevel: 9, adaptiveFiltering: true });

  if (options.outPath) {
    await pipeline.toFile(options.outPath);
    return options.outPath;
  }

  return pipeline.toBuffer();
}

module.exports = {
  WIDTH,
  HEIGHT,
  LEVELS,
  CENTER,
  RADIUS,
  MASTER_PATH,
  AXES,
  clampLevel,
  normalizeValues,
  pointFor,
  renderOverlaySvg,
  renderManaHexagonPng,
};
