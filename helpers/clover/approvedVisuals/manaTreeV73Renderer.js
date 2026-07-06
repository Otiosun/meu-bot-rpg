const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const RENDERER_VERSION = 'mana-tree-v7-3-html-approved';
const CACHE_DIR = path.join(process.cwd(), 'cache', 'clover', 'trees');
const HTML_PATH = path.join(__dirname, 'mana_tree_v7_3.html');

const NODE_IDS = [
    'mana',
    'percepcao_de_mana',
    'fluxo_de_mana_i',
    'retencao_de_mana_i',
    'emissao_de_mana_i',
    'sentir_mana_i',
    'sentir_mana_ii',
    'sentir_mana_iii',
    'leitura_de_flutuacao',
    'assinatura_magica',
    'campo_de_mana_i',
    'campo_de_mana_ii',
    'campo_de_mana_iii',
    'circulacao',
    'estabilidade',
    'canalizacao',
    'ritmo_de_mana',
    'mana_skin_i',
    'mana_skin_ii',
    'mana_skin_iii',
    'manto_de_mana_i',
    'controle_fino_i',
    'controle_fino_ii',
    'controle_fino_iii',
    'compressao_de_mana',
    'voo_de_vassoura',
    'revestimento_de_objeto',
    'manutencao_simultanea',
    'economia_de_mana_i',
    'economia_de_mana_ii',
    'economia_de_mana_iii',
    'recuperacao_i',
    'recuperacao_ii',
    'recuperacao_iii',
    'ocultacao_de_mana',
    'nucleo_de_mana',
    'leitura_ambiental',
    'adaptacao_ambiental',
    'ambiente_de_mana_i',
    'ambiente_de_mana_ii',
    'ambiente_de_mana_iii',
    'ressonancia',
    'metodo_de_mana',
    'mana_bullet_i',
    'mana_bullet_ii',
    'mana_bullet_iii',
    'pulso_de_mana_i',
    'pulso_de_mana_ii',
    'pulso_de_mana_iii',
    'pressao_de_mana',
    'condutor',
    'reservatorio',
    'dominador',
    'mana_zone_i',
    'mana_zone_ii',
    'mana_zone_iii',
    'dominio_de_mana',
];

const STATUS_STYLE = {
    owned: { fill: '#d9ead7', stroke: '#2f6847', dot: '#2f6847', width: 4.2 },
    available: { stroke: '#2d6981', dot: '#2d6981', width: 4 },
    no_ph: { fill: '#f5ead1', stroke: '#9a6c1d', dot: '#9a6c1d', width: 4 },
    locked: { fill: '#ece9e2', stroke: '#8f8a82', dot: '#8f8a82', width: 2.2 },
    approval: { fill: '#eee3ef', stroke: '#744f7f', dot: '#744f7f', width: 4 },
};

function sanitizeFilePart(value) {
    return String(value || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'unknown';
}

function readHtml() {
    return fs.readFileSync(HTML_PATH, 'utf8');
}

function extractSvg() {
    const html = readHtml();
    const match = html.match(/<svg[\s\S]*?<\/svg>/i);
    if (!match) throw new Error(`SVG nao encontrado em ${HTML_PATH}`);
    return match[0];
}

function getApprovedMtime() {
    try {
        return fs.statSync(HTML_PATH).mtimeMs;
    } catch {
        return 0;
    }
}

function nodeStateById(payload) {
    return Object.fromEntries((payload?.nodeStates || []).map((item) => [item.node.id, item]));
}

function escapeSvg(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function statusForNode(nodeId, states) {
    return states[nodeId]?.status || 'locked';
}

function patchNodeGroup(group, nodeId, status) {
    const style = STATUS_STYLE[status] || STATUS_STYLE.locked;
    const rectMatch = group.match(/<rect\b[^>]*>/i);
    if (!rectMatch) return group;

    const originalRect = rectMatch[0];
    const originalFill = originalRect.match(/\bfill="([^"]+)"/i)?.[1] || '#fbfaf6';
    const x = Number(originalRect.match(/\bx="([^"]+)"/i)?.[1] || 0);
    const y = Number(originalRect.match(/\by="([^"]+)"/i)?.[1] || 0);
    const fill = style.fill || originalFill;
    const stroke = style.stroke || '#151515';
    const strokeWidth = style.width || 2.8;
    const patchedRect = originalRect
        .replace(/\bfill="[^"]*"/i, `fill="${fill}"`)
        .replace(/\bstroke="[^"]*"/i, `stroke="${stroke}"`)
        .replace(/\bstroke-width="[^"]*"/i, `stroke-width="${strokeWidth}"`);
    const dot = `<circle cx="${x + 22}" cy="${y + 20}" r="7" fill="${style.dot}" stroke="#151515" stroke-width="1.1"><title>${escapeSvg(nodeId)} - ${escapeSvg(status)}</title></circle>`;

    return group.replace(originalRect, `${patchedRect}\n  ${dot}`);
}

function renderLegend() {
    const items = [
        ['owned', 'Comprado'],
        ['available', 'Disponivel'],
        ['no_ph', 'Sem PH'],
        ['locked', 'Bloqueado'],
        ['approval', 'Aprovacao narrativa'],
    ];
    const x = 2860;
    const y = 188;
    return `<g id="mana-v73-status-legend">
  <text x="${x}" y="${y}" style="font-family:Arial, Helvetica, sans-serif;font-size:18px;font-weight:900;fill:#151515;">Status</text>
  ${items.map(([status, label], index) => {
        const style = STATUS_STYLE[status];
        const cx = x + 95 + index * 190;
        return `<g><circle cx="${cx}" cy="${y - 6}" r="9" fill="${style.dot}" stroke="#151515" stroke-width="1.1"/><text x="${cx + 16}" y="${y}" style="font-family:Arial, Helvetica, sans-serif;font-size:16px;font-weight:700;fill:#5d5a54;">${escapeSvg(label)}</text></g>`;
    }).join('\n  ')}
</g>`;
}

function renderManaV73Svg(payload = {}) {
    const states = nodeStateById(payload);
    let nodeIndex = 0;
    let svg = extractSvg().replace(/<g class="node [^"]+">[\s\S]*?<\/g>/g, (group) => {
        const nodeId = NODE_IDS[nodeIndex];
        nodeIndex += 1;
        if (!nodeId) return group;
        return patchNodeGroup(group, nodeId, statusForNode(nodeId, states));
    });

    if (nodeIndex !== NODE_IDS.length) {
        throw new Error(`Mana v7.3 HTML deveria ter ${NODE_IDS.length} nos, mas renderizou ${nodeIndex}.`);
    }

    svg = svg.replace('</svg>', `${renderLegend()}\n</svg>`);
    return svg;
}

function getManaV73RenderMeta() {
    return {
        mode: 'approved',
        layoutSource: 'approved:mana_tree_v7_3_html',
        model: 'mana_tree_v7_3',
        dimensions: { width: 4050, height: 2600 },
        nodeCount: { total: NODE_IDS.length, drawn: NODE_IDS.length },
        edgeCount: 67,
    };
}

function getManaV73CacheKey(payload = {}) {
    const hashPayload = {
        rendererVersion: RENDERER_VERSION,
        approvedVersion: getApprovedMtime(),
        mode: payload.mode || 'compact',
        playerId: payload.playerId,
        ownedIds: [...(payload.ownedIds || [])].sort(),
        statuses: (payload.nodeStates || []).map((item) => [
            item.node.id,
            item.status,
            item.missingPh || 0,
        ]).sort((left, right) => left[0].localeCompare(right[0])),
    };
    return crypto.createHash('sha1').update(JSON.stringify(hashPayload)).digest('hex').slice(0, 16);
}

function getManaV73CachePath(playerId, hash, mode = 'compact') {
    return path.join(
        CACHE_DIR,
        `${sanitizeFilePart(playerId)}_mana_v7_3_${sanitizeFilePart(mode)}_${hash}.png`
    );
}

async function renderManaV73Png(payload = {}) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    return sharp(Buffer.from(renderManaV73Svg(payload))).png().toBuffer();
}

async function renderManaV73PngCached(payload = {}) {
    if (process.env.CLOVER_FORCE_VISUAL_FAIL === '1') {
        throw new Error('Forced Clover visual render failure.');
    }
    const hash = getManaV73CacheKey(payload);
    const imagePath = getManaV73CachePath(payload.playerId, hash, payload.mode || 'compact');
    const meta = getManaV73RenderMeta();

    if (fs.existsSync(imagePath)) {
        return { cacheHit: true, path: imagePath, hash, ...meta };
    }

    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    const buffer = await renderManaV73Png(payload);
    fs.writeFileSync(imagePath, buffer);
    return { cacheHit: false, path: imagePath, hash, buffer, ...meta };
}

module.exports = {
    CACHE_DIR,
    HTML_PATH,
    NODE_IDS,
    RENDERER_VERSION,
    getManaV73CacheKey,
    getManaV73CachePath,
    getManaV73RenderMeta,
    renderManaV73Png,
    renderManaV73PngCached,
    renderManaV73Svg,
};
