'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function loadSquadService() {
    const filename = path.resolve(__dirname, '../helpers/clover/squadService.js');
    const source = fs.readFileSync(filename, 'utf8');
    const loaded = { exports: {} };
    const mocks = {
        '../../database': {
            ensureCloverSquadSchema: async () => {},
        },
        '../groupAccess': {
            isSameUser: (left, right) => Boolean(left && right && left === right),
            normalizeJid: (value) => value || null,
        },
        '../textUtils': {
            normalizeText: normalize,
        },
        './cavalierService': {
            formatStars: (value) => String(Number(value || 0)),
            normalizeSquadKey: (value) => normalize(value)
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, ''),
        },
    };
    const localRequire = (request) => {
        if (Object.hasOwn(mocks, request)) return mocks[request];
        throw new Error(`Dependência não permitida no teste hermético: ${request}`);
    };
    const wrapper = vm.runInThisContext(Module.wrap(source), { filename });
    wrapper(loaded.exports, localRequire, loaded, filename, path.dirname(filename));
    return loaded.exports;
}

function squadRow() {
    return {
        squad_key: 'coringas_magenta',
        name: 'Coringas Magenta',
        group_id: '120363000000000000@g.us',
        phrase: 'Rir diante do impossível',
        captain_name: null,
        captain_player_id: null,
        vice_captain_player_id: null,
        historical_stars: 31,
        current_stars: 14,
        black_stars: 1,
        description_synced_at: null,
        description_sync_status: null,
        description_sync_error: null,
        updated_at: null,
    };
}

test('chamada direta é fail-closed sem tocar ledger ou agregados', async () => {
    const service = loadSquadService();
    const sql = [];
    const db = {
        get: async (statement) => {
            sql.push({ method: 'get', statement });
            if (statement.includes('SELECT * FROM clover_squads WHERE squad_key')) return squadRow();
            throw new Error(`SQL inesperado: ${statement}`);
        },
        all: async (statement) => {
            sql.push({ method: 'all', statement });
            throw new Error(`Leitura inesperada: ${statement}`);
        },
        run: async (statement) => {
            sql.push({ method: 'run', statement });
            throw new Error(`Escrita inesperada: ${statement}`);
        },
    };

    const result = await service.reconcileSquadStars(db, 'coringas_magenta');

    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'legacy_reconcile_disabled');
    assert.deepEqual(result.before, { currentStars: 14, historicalStars: 31 });
    assert.deepEqual(result.after, result.before);
    assert.equal(sql.some((entry) => /clover_squad_star_ledger/i.test(entry.statement)), false);
    assert.equal(sql.some((entry) => /UPDATE\s+clover_squads/i.test(entry.statement)), false);
});

test('sincronização visual continua e limita escrita aos metadados da descrição', async () => {
    const service = loadSquadService();
    const sql = [];
    const descriptions = [];
    const db = {
        all: async (statement) => {
            sql.push({ method: 'all', statement });
            if (statement.includes('FROM clover_squads')) return [squadRow()];
            if (statement.includes('FROM jogadores')) {
                return [{
                    id: 'member@lid',
                    nome: '-',
                    display_name: '-',
                    personagem_nome: 'Membro Um',
                    esquadrao: 'Coringas Magenta',
                    estrelas: 8,
                    ficha_status: 'aprovada',
                    jogo_status: 'liberado',
                }];
            }
            throw new Error(`SQL inesperado: ${statement}`);
        },
        get: async (statement) => {
            sql.push({ method: 'get', statement });
            if (statement.includes('SELECT * FROM clover_squads WHERE squad_key')) return squadRow();
            throw new Error(`SQL inesperado: ${statement}`);
        },
        run: async (statement, params) => {
            sql.push({ method: 'run', statement, params });
            if (statement.includes('description_sync_status')) return { changes: 1 };
            throw new Error(`Escrita econômica inesperada: ${statement}`);
        },
    };
    const sock = {
        groupUpdateDescription: async (groupId, description) => {
            descriptions.push({ groupId, description });
        },
    };

    const result = await service.syncAllSquadGroupDescriptions({
        sock,
        db,
        withGroupOnly: true,
        pauseMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.synced, 1);
    assert.equal(result.reconciled, 0);
    assert.equal(result.reconciliationBlocked, 1);
    assert.equal(descriptions.length, 1);
    assert.match(descriptions[0].description, /Coringas Magenta/);
    assert.equal(sql.some((entry) => /clover_squad_star_ledger/i.test(entry.statement)), false);
    assert.equal(sql.some((entry) => /current_stars\s*=|historical_stars\s*=/i.test(entry.statement)), false);
    const writes = sql.filter((entry) => entry.method === 'run');
    assert.equal(writes.length, 1);
    assert.match(writes[0].statement, /description_sync_status/);
});
