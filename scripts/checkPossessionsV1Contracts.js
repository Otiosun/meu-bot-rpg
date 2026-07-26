'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requireText(source, expected, label) {
    if (!source.includes(expected)) {
        throw new Error(`Possessions V1: ${label} não encontrado.`);
    }
}

const schema = read('helpers/clover/possessionsSchema.js');
const titles = read('helpers/clover/titleService.js');
const redemptions = read('helpers/clover/itemRedemptionService.js');
const receipts = read('helpers/clover/boxReceiptService.js');
const possessions = read('helpers/clover/possessionsService.js');
const siteApi = read('helpers/clover/siteApiServerBase.js');
const admin = read('helpers/clover/adminPlayerDetailService.js');
const packageJson = JSON.parse(read('package.json'));

requireText(schema, 'WHERE active = 1', 'índice parcial de Títulos');
requireText(schema, 'clover_title_history', 'histórico de Títulos');
requireText(titles, "'none'", 'opção Nenhum Título');
requireText(titles, "action: 'activated'", 'registro de ativação');
requireText(titles, "action: 'deactivated'", 'registro de desativação');
requireText(siteApi, 'POST /economy/titles/deactivate', 'rota HTTP explícita de desativação de Título');
requireText(siteApi, 'deactivatePlayerTitle(db, playerId)', 'serviço de desativação usado pela rota HTTP');
requireText(redemptions, 'resolution_note_required', 'nota de resolução obrigatória');
requireText(redemptions, "action.mode !== 'review_request'", 'separação entre resgate e uso contextual');
requireText(receipts, "recoverable: true", 'recibo recuperável');
requireText(receipts, "destination: { key: 'inventory'", 'destino Inventário');
requireText(possessions, "status: 'not_consolidated'", 'capacidade pessoal não consolidada');
requireText(admin, 'modules: {', 'módulos da Central ADM');
requireText(admin, 'possessions,', 'módulo de posses da Central ADM');

if (!packageJson.scripts?.['test:possessions-v1']) {
    throw new Error('Possessions V1: script de testes não registrado.');
}

console.log('Possessions V1 contracts: OK');
