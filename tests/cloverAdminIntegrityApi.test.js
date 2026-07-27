'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { handleAdminApiSupport } = require('../helpers/clover/adminApiSupport');
const { diagnoseDatabaseIntegrity } = require('../helpers/clover/databaseIntegrityService');

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value || '');
        },
    };
}

function request(url = '/admin/integrity/summary') {
    return {
        method: 'GET',
        url,
        headers: { authorization: 'Bearer test' },
    };
}

function authorizedOptions(capabilities) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({
            ok: true,
            player: { id: '222@lid', personagem_nome: 'Avaliador' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: {
                id: '222@lid',
                role: 'admin',
                capabilities,
            },
        }),
    };
}

async function createIntegrityDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            esquadrao TEXT DEFAULT '-',
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL
        );
    `);
    await db.run(
        'INSERT INTO jogadores (id, nome, display_name, personagem_nome, canonical_player_id) VALUES (?, ?, ?, ?, ?)',
        ['222@lid', 'Jogador', 'Jogador', 'Heroi', '222@lid']
    );
    await db.run(
        'INSERT INTO clover_inventory_items (player_id, item_name) VALUES (?, ?)',
        ['222@lid', 'Item de teste']
    );
    return db;
}

async function tableCounts(db) {
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const result = {};
    for (const table of tables) {
        const row = await db.get(`SELECT COUNT(*) AS total FROM ${table.name}`);
        result[table.name] = Number(row.total || 0);
    }
    return result;
}

test('resumo de integridade usa rota readonly protegida por integrity.view', async () => {
    const db = await createIntegrityDb();
    const beforeCounts = await tableCounts(db);
    const res = responseRecorder();
    await handleAdminApiSupport(request('/admin/integrity/summary?sampleLimit=3'), res, {
        ...authorizedOptions(['integrity.view']),
        getDb: () => db,
        integritySummary: diagnoseDatabaseIntegrity,
    });
    const afterCounts = await tableCounts(db);
    await db.close();

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.readOnly, true);
    assert.equal(payload.summary.total, 0);
    assert.deepEqual(afterCounts, beforeCounts);
});

test('bloqueia resumo de integridade sem capability especifica', async () => {
    const res = responseRecorder();
    await handleAdminApiSupport(request(), res, {
        ...authorizedOptions(['operation.view']),
        integritySummary: async () => {
            throw new Error('nao deveria executar');
        },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'missing_capability');
});
