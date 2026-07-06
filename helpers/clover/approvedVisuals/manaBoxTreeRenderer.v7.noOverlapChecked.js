const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const WIDTH = 4050;
const HEIGHT = 2600;

const COLORS = {
  "bg": "#f6f4ee",
  "ink": "#151515",
  "line": "#1f1f1f",
  "line_req": "#737373",
  "border": "#d5d0c6",
  "root": "#fff4bd",
  "percepcao": "#e8f6ff",
  "fluxo": "#e9fff0",
  "retencao": "#fff8d8",
  "emissao": "#fff0e5",
  "tecnica": "#f3eeff",
  "ambiente": "#f4ffe5",
  "zona": "#fff0dd",
  "final": "#fff8ca"
};
const NODES = [
  {
    "id": "mana",
    "label": "MANA",
    "x": 1870,
    "y": 2390,
    "w": 300,
    "h": 78,
    "branch": "root"
  },
  {
    "id": "percepcao",
    "label": "Percepção de Mana",
    "x": 360,
    "y": 2160,
    "w": 330,
    "h": 78,
    "branch": "percepcao"
  },
  {
    "id": "fluxo",
    "label": "Fluxo de Mana",
    "x": 1110,
    "y": 2160,
    "w": 300,
    "h": 78,
    "branch": "fluxo"
  },
  {
    "id": "retencao",
    "label": "Retenção de Mana",
    "x": 2130,
    "y": 2160,
    "w": 330,
    "h": 78,
    "branch": "retencao"
  },
  {
    "id": "emissao",
    "label": "Emissão de Mana",
    "x": 3200,
    "y": 2160,
    "w": 320,
    "h": 78,
    "branch": "emissao"
  },
  {
    "id": "sentir1",
    "label": "Sentir Mana I",
    "x": 90,
    "y": 1950,
    "w": 260,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "sentir2",
    "label": "Sentir Mana II",
    "x": 90,
    "y": 1760,
    "w": 260,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "sentir3",
    "label": "Sentir Mana III",
    "x": 90,
    "y": 1570,
    "w": 260,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "flutuacao",
    "label": "Leitura de Flutuação",
    "x": 440,
    "y": 1760,
    "w": 320,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "assinatura",
    "label": "Assinatura Mágica",
    "x": 440,
    "y": 1570,
    "w": 320,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "campo1",
    "label": "Campo de Mana I",
    "x": 770,
    "y": 1390,
    "w": 290,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "campo2",
    "label": "Campo de Mana II",
    "x": 770,
    "y": 1200,
    "w": 290,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "campo3",
    "label": "Campo de Mana III",
    "x": 770,
    "y": 1010,
    "w": 290,
    "h": 72,
    "branch": "percepcao"
  },
  {
    "id": "circulacao",
    "label": "Circulação",
    "x": 1010,
    "y": 1950,
    "w": 240,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "estabilidade",
    "label": "Estabilidade",
    "x": 1010,
    "y": 1760,
    "w": 240,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "canalizacao",
    "label": "Canalização",
    "x": 1010,
    "y": 1570,
    "w": 240,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "ritmo",
    "label": "Ritmo de Mana",
    "x": 1350,
    "y": 1760,
    "w": 280,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "pele1",
    "label": "Pele de Mana I",
    "x": 1350,
    "y": 1570,
    "w": 290,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "pele2",
    "label": "Pele de Mana II",
    "x": 1350,
    "y": 1380,
    "w": 290,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "pele3",
    "label": "Pele de Mana III",
    "x": 1350,
    "y": 1190,
    "w": 290,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "manto",
    "label": "Manto de Mana",
    "x": 1350,
    "y": 1000,
    "w": 290,
    "h": 72,
    "branch": "fluxo"
  },
  {
    "id": "controle1",
    "label": "Controle Fino I",
    "x": 1710,
    "y": 1460,
    "w": 280,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "controle2",
    "label": "Controle Fino II",
    "x": 1710,
    "y": 1270,
    "w": 280,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "controle3",
    "label": "Controle Fino III",
    "x": 1710,
    "y": 1080,
    "w": 280,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "compressao",
    "label": "Compressão de Mana",
    "x": 2040,
    "y": 1080,
    "w": 330,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "vassoura",
    "label": "Voo de Vassoura",
    "x": 1510,
    "y": 850,
    "w": 300,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "revest",
    "label": "Revestimento de Objeto",
    "x": 1900,
    "y": 850,
    "w": 350,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "manutencao",
    "label": "Manutenção Simultânea",
    "x": 1900,
    "y": 620,
    "w": 350,
    "h": 72,
    "branch": "tecnica"
  },
  {
    "id": "economia1",
    "label": "Economia I",
    "x": 2020,
    "y": 1950,
    "w": 240,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "economia2",
    "label": "Economia II",
    "x": 2020,
    "y": 1760,
    "w": 240,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "economia3",
    "label": "Economia III",
    "x": 2020,
    "y": 1570,
    "w": 240,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "recup1",
    "label": "Recuperação I",
    "x": 2350,
    "y": 1950,
    "w": 260,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "recup2",
    "label": "Recuperação II",
    "x": 2350,
    "y": 1760,
    "w": 260,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "recup3",
    "label": "Recuperação III",
    "x": 2350,
    "y": 1570,
    "w": 260,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "ocultacao",
    "label": "Ocultação de Mana",
    "x": 2350,
    "y": 1380,
    "w": 300,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "nucleo",
    "label": "Núcleo de Mana",
    "x": 2350,
    "y": 1190,
    "w": 290,
    "h": 72,
    "branch": "retencao"
  },
  {
    "id": "leituraAmb",
    "label": "Leitura Ambiental",
    "x": 2690,
    "y": 1080,
    "w": 290,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "adaptAmb",
    "label": "Adaptação Ambiental",
    "x": 2690,
    "y": 850,
    "w": 320,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "manaAmb1",
    "label": "Mana Ambiente I",
    "x": 3030,
    "y": 1080,
    "w": 290,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "manaAmb2",
    "label": "Mana Ambiente II",
    "x": 3030,
    "y": 850,
    "w": 290,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "manaAmb3",
    "label": "Mana Ambiente III",
    "x": 3030,
    "y": 620,
    "w": 290,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "ressonancia",
    "label": "Ressonância",
    "x": 3380,
    "y": 850,
    "w": 250,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "metodo",
    "label": "Método de Mana",
    "x": 3380,
    "y": 620,
    "w": 270,
    "h": 72,
    "branch": "ambiente"
  },
  {
    "id": "bala1",
    "label": "Bala de Mana I",
    "x": 2940,
    "y": 1950,
    "w": 270,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "bala2",
    "label": "Bala de Mana II",
    "x": 2940,
    "y": 1760,
    "w": 270,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "bala3",
    "label": "Bala de Mana III",
    "x": 2940,
    "y": 1570,
    "w": 270,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "pulso1",
    "label": "Pulso de Mana I",
    "x": 3300,
    "y": 1950,
    "w": 270,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "pulso2",
    "label": "Pulso de Mana II",
    "x": 3300,
    "y": 1760,
    "w": 270,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "pulso3",
    "label": "Pulso de Mana III",
    "x": 3300,
    "y": 1570,
    "w": 270,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "pressao",
    "label": "Pressão de Mana",
    "x": 3300,
    "y": 1380,
    "w": 290,
    "h": 72,
    "branch": "emissao"
  },
  {
    "id": "condutor",
    "label": "Condutor",
    "x": 850,
    "y": 450,
    "w": 250,
    "h": 72,
    "branch": "final"
  },
  {
    "id": "reservatorio",
    "label": "Reservatório",
    "x": 1580,
    "y": 360,
    "w": 280,
    "h": 72,
    "branch": "final"
  },
  {
    "id": "dominador",
    "label": "Dominador",
    "x": 2430,
    "y": 360,
    "w": 260,
    "h": 72,
    "branch": "final"
  },
  {
    "id": "zona1",
    "label": "Zona de Mana I",
    "x": 2900,
    "y": 310,
    "w": 280,
    "h": 72,
    "branch": "zona"
  },
  {
    "id": "zona2",
    "label": "Zona de Mana II",
    "x": 3220,
    "y": 310,
    "w": 280,
    "h": 72,
    "branch": "zona"
  },
  {
    "id": "zona3",
    "label": "Zona de Mana III",
    "x": 3540,
    "y": 310,
    "w": 280,
    "h": 72,
    "branch": "zona"
  },
  {
    "id": "dominio",
    "label": "DOMÍNIO DE MANA",
    "x": 1840,
    "y": 160,
    "w": 420,
    "h": 82,
    "branch": "root"
  }
];
const EDGES = [
  [
    "mana",
    "percepcao",
    "main"
  ],
  [
    "mana",
    "fluxo",
    "main"
  ],
  [
    "mana",
    "retencao",
    "main"
  ],
  [
    "mana",
    "emissao",
    "main"
  ],
  [
    "percepcao",
    "sentir1",
    "main"
  ],
  [
    "sentir1",
    "sentir2",
    "main"
  ],
  [
    "sentir2",
    "sentir3",
    "main"
  ],
  [
    "sentir2",
    "flutuacao",
    "req"
  ],
  [
    "flutuacao",
    "assinatura",
    "main"
  ],
  [
    "sentir3",
    "campo1",
    "main"
  ],
  [
    "campo1",
    "campo2",
    "main"
  ],
  [
    "campo2",
    "campo3",
    "main"
  ],
  [
    "fluxo",
    "circulacao",
    "main"
  ],
  [
    "circulacao",
    "estabilidade",
    "main"
  ],
  [
    "estabilidade",
    "canalizacao",
    "main"
  ],
  [
    "estabilidade",
    "ritmo",
    "req"
  ],
  [
    "canalizacao",
    "pele1",
    "main"
  ],
  [
    "pele1",
    "pele2",
    "main"
  ],
  [
    "pele2",
    "pele3",
    "main"
  ],
  [
    "pele3",
    "manto",
    "main"
  ],
  [
    "canalizacao",
    "controle1",
    "req"
  ],
  [
    "sentir2",
    "controle1",
    "req"
  ],
  [
    "controle1",
    "controle2",
    "main"
  ],
  [
    "controle2",
    "controle3",
    "main"
  ],
  [
    "controle3",
    "compressao",
    "main"
  ],
  [
    "controle3",
    "revest",
    "main"
  ],
  [
    "controle2",
    "vassoura",
    "main"
  ],
  [
    "controle3",
    "manutencao",
    "main"
  ],
  [
    "retencao",
    "economia1",
    "main"
  ],
  [
    "economia1",
    "economia2",
    "main"
  ],
  [
    "economia2",
    "economia3",
    "main"
  ],
  [
    "retencao",
    "recup1",
    "main"
  ],
  [
    "recup1",
    "recup2",
    "main"
  ],
  [
    "recup2",
    "recup3",
    "main"
  ],
  [
    "recup3",
    "ocultacao",
    "main"
  ],
  [
    "recup3",
    "nucleo",
    "main"
  ],
  [
    "sentir3",
    "leituraAmb",
    "req"
  ],
  [
    "recup2",
    "leituraAmb",
    "req"
  ],
  [
    "leituraAmb",
    "adaptAmb",
    "main"
  ],
  [
    "adaptAmb",
    "manaAmb1",
    "main"
  ],
  [
    "manaAmb1",
    "manaAmb2",
    "main"
  ],
  [
    "manaAmb2",
    "manaAmb3",
    "main"
  ],
  [
    "manaAmb2",
    "ressonancia",
    "main"
  ],
  [
    "manaAmb3",
    "metodo",
    "main"
  ],
  [
    "controle2",
    "metodo",
    "req"
  ],
  [
    "emissao",
    "bala1",
    "main"
  ],
  [
    "bala1",
    "bala2",
    "main"
  ],
  [
    "bala2",
    "bala3",
    "main"
  ],
  [
    "emissao",
    "pulso1",
    "main"
  ],
  [
    "pulso1",
    "pulso2",
    "main"
  ],
  [
    "pulso2",
    "pulso3",
    "main"
  ],
  [
    "pulso3",
    "pressao",
    "main"
  ],
  [
    "controle3",
    "condutor",
    "main"
  ],
  [
    "manutencao",
    "condutor",
    "req"
  ],
  [
    "nucleo",
    "reservatorio",
    "main"
  ],
  [
    "manto",
    "reservatorio",
    "req"
  ],
  [
    "pressao",
    "dominador",
    "main"
  ],
  [
    "campo3",
    "dominador",
    "req"
  ],
  [
    "manaAmb3",
    "dominador",
    "req"
  ],
  [
    "metodo",
    "dominador",
    "main"
  ],
  [
    "condutor",
    "zona1",
    "req"
  ],
  [
    "reservatorio",
    "zona1",
    "req"
  ],
  [
    "dominador",
    "zona1",
    "main"
  ],
  [
    "metodo",
    "zona1",
    "req"
  ],
  [
    "zona1",
    "zona2",
    "main"
  ],
  [
    "zona2",
    "zona3",
    "main"
  ],
  [
    "zona3",
    "dominio",
    "main"
  ]
];
const MANUAL_PATHS = {
  "mana|percepcao": "M 2020 2390 L 2020 2290 L 525 2290 L 525 2238",
  "mana|fluxo": "M 2020 2390 L 2020 2290 L 1260 2290 L 1260 2238",
  "mana|retencao": "M 2020 2390 L 2020 2290 L 2295 2290 L 2295 2238",
  "mana|emissao": "M 2020 2390 L 2020 2290 L 3360 2290 L 3360 2238",
  "canalizacao|controle1": "M 1250 1606 L 1600 1606 L 1600 1496 L 1710 1496",
  "sentir2|controle1": "M 350 1796 L 1600 1796 L 1600 1496 L 1710 1496",
  "controle2|metodo": "M 1990 1306 L 3720 1306 L 3720 656 L 3650 656",
  "sentir3|leituraAmb": "M 350 1606 L 2590 1606 L 2590 1116 L 2690 1116",
  "recup2|leituraAmb": "M 2610 1796 L 2590 1796 L 2590 1116 L 2690 1116",
  "campo3|dominador": "M 1060 1046 L 1060 540 L 2560 540 L 2560 432",
  "manto|reservatorio": "M 1640 1036 L 1640 735 L 1720 735 L 1720 432",
  "nucleo|reservatorio": "M 2495 1190 L 2495 735 L 1720 735 L 1720 432",
  "pressao|dominador": "M 3445 1380 L 3445 735 L 2560 735 L 2560 432",
  "manaAmb3|dominador": "M 3175 620 L 3175 540 L 2560 540 L 2560 432",
  "condutor|zona1": "M 1100 486 L 2800 486 L 2800 346 L 2900 346",
  "reservatorio|zona1": "M 1860 396 L 2800 396 L 2800 346 L 2900 346",
  "dominador|zona1": "M 2690 396 L 2800 396 L 2800 346 L 2900 346",
  "metodo|zona1": "M 3650 656 L 3780 656 L 3780 455 L 3040 455 L 3040 382",
  "zona3|dominio": "M 3680 310 L 3680 240 L 2050 240 L 2050 242"
};

function escapeSvg(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function nodeMap(nodes = NODES) {
  return Object.fromEntries(nodes.map((node) => [node.id, node]));
}

function port(node, side) {
  if (side === 'top') return [node.x + node.w / 2, node.y];
  if (side === 'bottom') return [node.x + node.w / 2, node.y + node.h];
  if (side === 'left') return [node.x, node.y + node.h / 2];
  if (side === 'right') return [node.x + node.w, node.y + node.h / 2];
  return [node.x + node.w / 2, node.y + node.h / 2];
}

function defaultPath(fromId, toId, nodesById = nodeMap()) {
  const from = nodesById[fromId];
  const to = nodesById[toId];
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;
  const toCx = to.x + to.w / 2;
  const toCy = to.y + to.h / 2;

  if (Math.abs(fromCy - toCy) < 120 && Math.abs(fromCx - toCx) > 160) {
    let ax, ay, bx, by;
    if (toCx > fromCx) {
      [ax, ay] = port(from, 'right');
      [bx, by] = port(to, 'left');
    } else {
      [ax, ay] = port(from, 'left');
      [bx, by] = port(to, 'right');
    }
    const midX = (ax + bx) / 2;
    return `M ${ax} ${ay} L ${midX} ${ay} L ${midX} ${by} L ${bx} ${by}`;
  }

  let ax, ay, bx, by;
  if (toCy < fromCy) {
    [ax, ay] = port(from, 'top');
    [bx, by] = port(to, 'bottom');
  } else {
    [ax, ay] = port(from, 'bottom');
    [bx, by] = port(to, 'top');
  }

  const midY = (ay + by) / 2;
  return `M ${ax} ${ay} L ${ax} ${midY} L ${bx} ${midY} L ${bx} ${by}`;
}

function edgePath(fromId, toId, nodesById = nodeMap()) {
  const key = `${fromId}|${toId}`;
  return MANUAL_PATHS[key] || defaultPath(fromId, toId, nodesById);
}

function wrapLabel(label, maxChars) {
  const words = String(label).split(/\s+/g);
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

function renderNode(node) {
  const maxChars = node.w >= 320 ? 22 : 18;
  const lines = wrapLabel(node.label, maxChars);
  const textY = node.y + node.h / 2 - (lines.length - 1) * 10;
  const tspans = lines.map((line, index) => {
    return `<tspan x="${node.x + node.w / 2}" dy="${index === 0 ? 0 : 23}">${escapeSvg(line)}</tspan>`;
  }).join('');

  return `<g class="node ${node.branch}">
  <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="16" ry="16" fill="${COLORS[node.branch]}" stroke="${COLORS.ink}" stroke-width="2.8"/>
  <text x="${node.x + node.w / 2}" y="${textY}" text-anchor="middle" dominant-baseline="middle" class="nodeText">${tspans}</text>
</g>`;
}

function renderEdge(edge, nodesById) {
  const [from, to, kind] = edge;
  const cls = kind === 'req' ? 'edge req' : 'edge main';
  return `<path d="${edgePath(from, to, nodesById)}" class="${cls}"/>`;
}

function renderManaBoxTreeSvg() {
  const nodesById = nodeMap();
  const edges = EDGES.map((edge) => renderEdge(edge, nodesById)).join('\n');
  const nodes = NODES.map(renderNode).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>
  <style>
    .title {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 58px;
      font-weight: 900;
      letter-spacing: 5px;
      fill: ${COLORS.ink};
    }
    .edge {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .edge.main {
      stroke: ${COLORS.line};
      stroke-width: 3.4;
      opacity: 0.82;
    }
    .edge.req {
      stroke: ${COLORS.line_req};
      stroke-width: 2.6;
      opacity: 0.54;
      stroke-dasharray: 12 10;
    }
    .nodeText {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 23px;
      font-weight: 740;
      fill: ${COLORS.ink};
    }
    .root .nodeText, .final .nodeText, .zona .nodeText {
      font-size: 25px;
      font-weight: 860;
    }
  </style>
</defs>
<rect width="100%" height="100%" fill="${COLORS.bg}"/>
<rect x="46" y="46" width="${WIDTH - 92}" height="${HEIGHT - 92}" rx="40" ry="40" fill="${COLORS.bg}" stroke="${COLORS.border}" stroke-width="2"/>
<text x="78" y="112" class="title">ÁRVORE DE MANA</text>
<g id="edges">${edges}</g>
<g id="nodes">${nodes}</g>
</svg>`;
}

async function renderManaBoxTreePng(options = {}) {
  const outDir = options.outDir || path.join(process.cwd(), 'cache', 'clover', 'trees');
  await fs.mkdir(outDir, { recursive: true });

  const svg = renderManaBoxTreeSvg();
  const outPath = path.join(outDir, options.fileName || 'mana-tree-box-layout-v7-no-overlap-checked.png');
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return outPath;
}

module.exports = {
  WIDTH,
  HEIGHT,
  COLORS,
  NODES,
  EDGES,
  MANUAL_PATHS,
  renderManaBoxTreeSvg,
  renderManaBoxTreePng,
};
