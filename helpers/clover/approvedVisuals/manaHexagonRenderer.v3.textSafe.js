const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const WIDTH = 2800;
const HEIGHT = 1850;
const LEVELS = 5;
const CENTER = [1400, 965];
const RADIUS = 455;

const COLORS = {
  "bg": "#f6f4ee",
  "ink": "#151515",
  "muted": "#625f59",
  "border": "#d5d0c6",
  "grid": "#c9c4b8",
  "gridStrong": "#9e9788",
  "axis": "#7c7569",
  "fill": "#e8d986",
  "fillStroke": "#c7a94c",
  "point": "#fff4bd",
  "root": "#fff4bd",
  "percepcao": "#e8f6ff",
  "retencao": "#fff8d8",
  "emissao": "#fff0e5",
  "controle": "#f3eeff",
  "pressao": "#ffe8e2",
  "alcance": "#f4ffe5"
};
const AXES = [
  {
    "id": "percepcao",
    "label": "Percepção",
    "short": "PER",
    "desc": "Sentir, ler, detectar e prever mana.",
    "value": 3,
    "cardX": 1080,
    "cardY": 180,
    "cardW": 640,
    "cardH": 158,
    "color": "#e8f6ff"
  },
  {
    "id": "emissao",
    "label": "Emissão",
    "short": "EMI",
    "desc": "Lançar, liberar, impulsionar e projetar mana.",
    "value": 2,
    "cardX": 1985,
    "cardY": 555,
    "cardW": 670,
    "cardH": 158,
    "color": "#fff0e5"
  },
  {
    "id": "alcance",
    "label": "Alcance",
    "short": "ALC",
    "desc": "Distância, área, campo e zona.",
    "value": 2,
    "cardX": 1985,
    "cardY": 1210,
    "cardW": 670,
    "cardH": 158,
    "color": "#f4ffe5"
  },
  {
    "id": "retencao",
    "label": "Retenção",
    "short": "RET",
    "desc": "Guardar, economizar, ocultar e durar mais.",
    "value": 4,
    "cardX": 1080,
    "cardY": 1530,
    "cardW": 640,
    "cardH": 158,
    "color": "#fff8d8"
  },
  {
    "id": "controle",
    "label": "Controle",
    "short": "CON",
    "desc": "Moldar, dividir, manter e ajustar mana.",
    "value": 3,
    "cardX": 145,
    "cardY": 1210,
    "cardW": 670,
    "cardH": 158,
    "color": "#f3eeff"
  },
  {
    "id": "pressao",
    "label": "Pressão",
    "short": "PRE",
    "desc": "Potência, impacto e imposição da mana.",
    "value": 1,
    "cardX": 145,
    "cardY": 555,
    "cardW": 670,
    "cardH": 158,
    "color": "#ffe8e2"
  }
];

function escapeSvg(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function axisAngle(index) {
  return -Math.PI / 2 + index * (2 * Math.PI / AXES.length);
}

function pointForAxis(index, radius) {
  const angle = axisAngle(index);
  return [
    CENTER[0] + Math.cos(angle) * radius,
    CENTER[1] + Math.sin(angle) * radius,
  ];
}

function polygonPoints(radius) {
  return AXES.map((_, index) => {
    const [x, y] = pointForAxis(index, radius);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function valuePoints(values) {
  return AXES.map((axis, index) => {
    const value = Math.max(0, Math.min(LEVELS, Number(values?.[axis.id] ?? axis.value ?? 0)));
    const [x, y] = pointForAxis(index, RADIUS * (value / LEVELS));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function wrapText(text, maxChars = 48) {
  const words = String(text).split(/\s+/g);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = `${current} ${word}`.trim();
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function renderCard(axis, value) {
  const x = axis.cardX;
  const y = axis.cardY;
  const w = axis.cardW;
  const h = axis.cardH;

  const descTspans = wrapText(axis.desc, 52).map((line, index) => {
    return `<tspan x="${x + 30}" dy="${index === 0 ? 0 : 25}">${escapeSvg(line)}</tspan>`;
  }).join('');

  let dots = '';
  const dotStart = x + 30;
  const dotY = y + h - 30;

  for (let i = 1; i <= LEVELS; i++) {
    const cx = dotStart + (i - 1) * 35;
    const fill = i <= value ? COLORS.fillStroke : '#f5f2e9';
    const stroke = i <= value ? COLORS.ink : COLORS.gridStrong;
    dots += `<circle cx="${cx}" cy="${dotY}" r="11" fill="${fill}" stroke="${stroke}" stroke-width="2.2"/>`;
  }

  return `<g class="axis-card">
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="20" fill="${axis.color}" stroke="${COLORS.ink}" stroke-width="2.8"/>
  <text x="${x + 30}" y="${y + 49}" class="card-title">${escapeSvg(axis.label)}</text>
  <text x="${x + w - 34}" y="${y + 49}" class="card-value">${value}/5</text>
  <text x="${x + 30}" y="${y + 88}" class="card-desc">${descTspans}</text>
  <text x="${x + w - 225}" y="${dotY + 8}" class="dots-label">nível</text>
  ${dots}
</g>`;
}

function renderManaHexagonSvg(values = Object.fromEntries(AXES.map((axis) => [axis.id, axis.value ?? 0]))) {
  const gridPolys = Array.from({ length: LEVELS }, (_, index) => {
    const level = index + 1;
    return `<polygon points="${polygonPoints(RADIUS * level / LEVELS)}" fill="none" stroke="${level === LEVELS ? COLORS.gridStrong : COLORS.grid}" stroke-width="${level === LEVELS ? 3 : 2}" opacity="${level === LEVELS ? 0.86 : 0.68}"/>`;
  }).join('\n');

  const axisLines = AXES.map((_, index) => {
    const [x, y] = pointForAxis(index, RADIUS);
    return `<line x1="${CENTER[0]}" y1="${CENTER[1]}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${COLORS.axis}" stroke-width="2.5" opacity="0.72"/>`;
  }).join('\n');

  const points = AXES.map((axis, index) => {
    const value = Math.max(0, Math.min(LEVELS, Number(values?.[axis.id] ?? axis.value ?? 0)));
    const [x, y] = pointForAxis(index, RADIUS * (value / LEVELS));
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="${COLORS.point}" stroke="${COLORS.ink}" stroke-width="3"/>`;
  }).join('\n');

  const labels = AXES.map((axis, index) => {
    const [x, y] = pointForAxis(index, RADIUS + 64);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="axis-label" text-anchor="middle" dominant-baseline="middle">${escapeSvg(axis.short)}</text>`;
  }).join('\n');

  const cards = AXES.map((axis) => {
    const value = Math.max(0, Math.min(LEVELS, Number(values?.[axis.id] ?? axis.value ?? 0)));
    return renderCard(axis, value);
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>
  <style>
    .title { font-family: Arial, Helvetica, sans-serif; font-size: 60px; font-weight: 900; letter-spacing: 5px; fill: ${COLORS.ink}; }
    .subtitle { font-family: Arial, Helvetica, sans-serif; font-size: 24px; font-weight: 620; fill: ${COLORS.muted}; }
    .center-title { font-family: Arial, Helvetica, sans-serif; font-size: 31px; font-weight: 900; letter-spacing: 2px; fill: ${COLORS.ink}; }
    .center-sub { font-family: Arial, Helvetica, sans-serif; font-size: 20px; font-weight: 650; fill: ${COLORS.muted}; }
    .axis-label { font-family: Arial, Helvetica, sans-serif; font-size: 29px; font-weight: 900; letter-spacing: 2px; fill: ${COLORS.ink}; }
    .card-title { font-family: Arial, Helvetica, sans-serif; font-size: 33px; font-weight: 900; letter-spacing: 1.5px; fill: ${COLORS.ink}; }
    .card-desc { font-family: Arial, Helvetica, sans-serif; font-size: 22px; font-weight: 650; fill: ${COLORS.muted}; }
    .card-value { font-family: Arial, Helvetica, sans-serif; font-size: 33px; font-weight: 900; fill: ${COLORS.ink}; text-anchor: end; }
    .dots-label { font-family: Arial, Helvetica, sans-serif; font-size: 18px; font-weight: 800; fill: ${COLORS.muted}; text-anchor: end; letter-spacing: 1px; }
  </style>
</defs>
<rect width="100%" height="100%" fill="${COLORS.bg}"/>
<rect x="50" y="50" width="${WIDTH - 100}" height="${HEIGHT - 100}" rx="42" ry="42" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="2"/>
<text x="92" y="122" class="title">HEXÁGONO DE MANA</text>
<text x="96" y="166" class="subtitle">Sistema complementar · estilo, eficiência e forma de uso</text>
<g id="hex-grid">
  ${gridPolys}
  ${axisLines}
  <polygon points="${valuePoints(values)}" fill="${COLORS.fill}" stroke="${COLORS.fillStroke}" stroke-width="5" opacity="0.72"/>
  ${points}
  ${labels}
  <circle cx="${CENTER[0]}" cy="${CENTER[1]}" r="84" fill="${COLORS.root}" stroke="${COLORS.ink}" stroke-width="3"/>
  <text x="${CENTER[0]}" y="${CENTER[1] - 8}" class="center-title" text-anchor="middle">MANA</text>
  <text x="${CENTER[0]}" y="${CENTER[1] + 30}" class="center-sub" text-anchor="middle">Domínio técnico</text>
</g>
<g id="cards">${cards}</g>
</svg>`;
}

async function renderManaHexagonPng(options = {}) {
  const outDir = options.outDir || path.join(process.cwd(), 'cache', 'clover', 'hexagons');
  await fs.mkdir(outDir, { recursive: true });

  const svg = renderManaHexagonSvg(options.values);
  const outPath = path.join(outDir, options.fileName || 'mana-hexagon-v3-text-safe.png');
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = {
  WIDTH,
  HEIGHT,
  LEVELS,
  CENTER,
  RADIUS,
  COLORS,
  AXES,
  renderManaHexagonSvg,
  renderManaHexagonPng,
};
