'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let createDb;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    createDb = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => raw.prepare(sql).run(...params),
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const { MANA_HEXAGON_V4_MIGRATION } = require('../helpers/clover/manaHexagonV4Migration');
const {
    HEXAGON_SIDES,
    applyPendingHexagonUpgrade,
    assertHexagonValue,
    createPendingHexagonUpgrade,
    getHexagonDerivedLimits,
    getUpgradeCost,
    requiresUpgradeApproval,
} = require('../helpers/clover/hexagonService');
const { addPh, getPhSummary } = require('../helpers/clover/phService');
const { AXES, renderHexagonSvg } = require('../helpers/clover/hexagonRenderer');

async function createLegacyHexagon(db) {
    await db.exec(`
        CREATE TABLE clover_mana_hexagon (
            player_id TEXT PRIMARY KEY,
            percepcao INTEGER DEFAULT 1 CHECK (percepcao BETWEEN 1 AND 5),
            retencao INTEGER DEFAULT 1 CHECK (retencao BETWEEN 1 AND 5),
            emissao INTEGER DEFAULT 1 CHECK (emissao BETWEEN 1 AND 5),
            controle INTEGER DEFAULT 1 CHECK (controle BETWEEN 1 AND 5),
            pressao INTEGER DEFAULT 1 CHECK (pressao BETWEEN 1 AND 5),
            alcance INTEGER DEFAULT 1 CHECK (alcance BETWEEN 1 AND 5),
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_by TEXT DEFAULT NULL
        );
        CREATE TABLE clover_mana_hexagon_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL,
            side TEXT NOT NULL, old_value INTEGER, new_value INTEGER NOT NULL,
            reason TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_pending_hexagon_upgrades (
            player_id TEXT PRIMARY KEY, side TEXT NOT NULL, old_value INTEGER NOT NULL,
            new_value INTEGER NOT NULL, cost INTEGER NOT NULL, requires_approval INTEGER DEFAULT 0,
            created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, metadata_json TEXT
        );
        INSERT INTO clover_mana_hexagon
            (player_id, percepcao, retencao, emissao, controle, pressao, alcance)
        VALUES ('legacy', 5, 4, 3, 2, 5, 3);
    `);
}

test('migration preserva eixos antigos sem mapea-los para os novos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await createLegacyHexagon(db);
    await MANA_HEXAGON_V4_MIGRATION.up(db);

    const row = await db.get("SELECT * FROM clover_mana_hexagon WHERE player_id='legacy'");
    assert.equal(row.controle, 2);
    assert.equal(row.retencao, 4);
    assert.equal(row.alcance, 3);
    assert.equal(row.precisao, 1);
    assert.equal(row.estabilidade, 1);
    assert.equal(row.escala, 1);
    assert.equal(row.percepcao, 5);
    assert.equal(row.emissao, 3);
    assert.equal(row.pressao, 5);

    await db.run("UPDATE clover_mana_hexagon SET controle=7, precisao=7, estabilidade=7, retencao=7, alcance=7, escala=7 WHERE player_id='legacy'");
    await assert.rejects(() => db.run("UPDATE clover_mana_hexagon SET escala=8 WHERE player_id='legacy'"));

    await MANA_HEXAGON_V4_MIGRATION.up(db);
    const retried = await db.get("SELECT * FROM clover_mana_hexagon WHERE player_id='legacy'");
    assert.equal(retried.controle, 7);
    assert.equal(retried.percepcao, 5);
});

test('migration cria schema moderno quando o Hexagono ainda nao existe', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await MANA_HEXAGON_V4_MIGRATION.up(db);
    const columns = await db.all('PRAGMA table_info(clover_mana_hexagon)');
    assert.deepEqual(columns.map((column) => column.name), [
        'player_id', 'percepcao', 'retencao', 'emissao', 'controle', 'pressao', 'alcance',
        'precisao', 'estabilidade', 'escala', 'updated_at', 'updated_by',
    ]);
});

test('contrato ativo tem seis eixos, escala 1-7 e novos custos sem gate generico', () => {
    assert.deepEqual(HEXAGON_SIDES.map(({ key }) => key), [
        'controle', 'precisao', 'estabilidade', 'retencao', 'alcance', 'escala',
    ]);
    assert.deepEqual([2, 3, 4, 5, 6, 7].map(getUpgradeCost), [50, 100, 200, 300, 500, 800]);
    assert.equal(assertHexagonValue(7), 7);
    assert.throws(() => assertHexagonValue(8));
    assert.equal(requiresUpgradeApproval(7), false);

    const limits = getHexagonDerivedLimits({
        controle: 7, precisao: 6, estabilidade: 5, retencao: 4, alcance: 7, escala: 3,
    });
    assert.equal(limits.alcanceLabel, '250 m+ conforme técnica e contexto');
    assert.equal(limits.duracaoLabel, 'até 5 ciclos');
    assert.match(limits.precisaoLabel, /finesse extrema/i);
    assert.match(limits.estabilidadeLabel, /alta resistência/i);
    assert.match(limits.escalaLabel, /sala pequena/i);
});

test('renderer usa somente os seis eixos ativos e escala visual 1-7', () => {
    assert.deepEqual(new Set(AXES.map((axis) => axis.id)), new Set([
        'controle', 'precisao', 'estabilidade', 'retencao', 'alcance', 'escala',
    ]));
    const svg = renderHexagonSvg({ controle: 7, precisao: 6, estabilidade: 5, retencao: 4, alcance: 3, escala: 2 });
    assert.match(svg, />7\/7</);
    assert.doesNotMatch(svg, /Percepção|Emissão|Pressão/);
});

test('upgrade e debito sao atomicos e PH insuficiente nao cria pedido', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await db.exec(`CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT DEFAULT '-');`);
    await db.run("INSERT INTO jogadores (id, nome) VALUES ('player', 'Player')");

    const insufficient = await createPendingHexagonUpgrade(db, 'player', 'precisao', 'player');
    assert.equal(insufficient.ok, false);
    assert.equal(insufficient.reason, 'insufficient_ph');
    assert.equal(await db.get("SELECT COUNT(*) AS total FROM clover_pending_hexagon_upgrades WHERE player_id='player'").then((r) => r.total), 0);
    assert.equal(await db.get("SELECT COUNT(*) AS total FROM clover_mana_hexagon_ledger WHERE player_id='player'").then((r) => r.total), 0);
    assert.equal((await db.get("SELECT precisao FROM clover_mana_hexagon WHERE player_id='player'")).precisao, 1);

    await addPh(db, 'player', 1000, 'test', 'hexagon test', 'admin');
    await createPendingHexagonUpgrade(db, 'player', 'precisao', 'player');
    const applied = await applyPendingHexagonUpgrade(db, 'player', 'player');
    assert.equal(applied.ok, true);
    assert.equal(applied.hexagon.precisao, 2);
    assert.equal((await getPhSummary(db, 'player')).phAvailable, 965);

    await createPendingHexagonUpgrade(db, 'player', 'precisao', 'player');
    await db.exec(`CREATE TRIGGER fail_hexagon_ledger BEFORE INSERT ON clover_mana_hexagon_ledger
        BEGIN SELECT RAISE(ABORT, 'forced_hexagon_failure'); END;`);
    await assert.rejects(() => applyPendingHexagonUpgrade(db, 'player', 'player'), /forced_hexagon_failure/);
    assert.equal((await db.get("SELECT precisao FROM clover_mana_hexagon WHERE player_id='player'")).precisao, 2);
    assert.equal((await getPhSummary(db, 'player')).phAvailable, 965);
});
