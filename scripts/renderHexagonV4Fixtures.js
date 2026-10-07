const fs = require('fs/promises');
const path = require('path');
const renderer = require('../helpers/clover/approvedVisuals/manaHexagonRenderer.v4.masterOverlay');

const PROFILES = {
  min: { percepcao: 1, emissao: 1, alcance: 1, retencao: 1, controle: 1, pressao: 1 },
  max: { percepcao: 5, emissao: 5, alcance: 5, retencao: 5, controle: 5, pressao: 5 },
  zig_a: { percepcao: 5, emissao: 1, alcance: 5, retencao: 1, controle: 5, pressao: 1 },
  zig_b: { percepcao: 1, emissao: 5, alcance: 1, retencao: 5, controle: 1, pressao: 5 },
  sample: { percepcao: 3, emissao: 2, alcance: 2, retencao: 4, controle: 3, pressao: 1 },
};

async function main() {
  const outDir = path.join(process.cwd(), 'tmp', 'hexagono-v4-fixtures');
  await fs.mkdir(outDir, { recursive: true });

  for (const [name, values] of Object.entries(PROFILES)) {
    const outPath = path.join(outDir, `${name}.png`);
    await renderer.renderManaHexagonPng(values, { outPath });
    console.log(`${name}: ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
