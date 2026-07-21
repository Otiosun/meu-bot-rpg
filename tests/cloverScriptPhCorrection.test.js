'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
} = require('../database');
const {
    addPh,
    adminAdjustPh,
    ensurePhState,
    getPhSummary,
    removeAvailablePh,
} = require('../helpers/clover/phService');
const { previewAction } = require('../helpers/clover/cloverScriptService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-'
        )
    `);
    await db.run(
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome)
         VALUES ('player@lid', 'Player', 'Player', 'Personagem')`
    );
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensurePhState(db, 'player@lid');
    return db;
}

test('PH negativo do CloverScript corrige disponível e acumulado sem apagar histórico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addPh(
        db,
        'player@lid',
        100,
        'evento',
        'recompensa de teste',
        'owner@lid'
    );

    const before = await getPhSummary(db, 'player@lid');
    assert.equal(before.phAccumulated, 115);
    assert.equal(before.phAvailable, 115);

    const preview = await previewAction(
        db,
        { id: 'player@lid', personagem_nome: 'Personagem' },
        { type: 'ph', amount: -40, source: 'outro', cap: '', reason: 'correção' },
        { ph: new Map() }
    );
    assert.match(preview, /disp\. 115 -> 75/);
    assert.match(preview, /acum\. 115 -> 75/);

    const correction = await adminAdjustPh(
        db,
        'player@lid',
        -40,
        'correção administrativa',
        'owner@lid',
        {
            source: 'cloverscript:outro',
            relatedId: 'cloverscript:99:1:player@lid',
            affectAccumulated: true,
            metadata: {
                cloverscript_run_id: 99,
                correction_scope: 'available_and_accumulated',
            },
        }
    );

    assert.equal(correction.before.phAccumulated, 115);
    assert.equal(correction.after.phAccumulated, 75);
    assert.equal(correction.after.phAvailable, 75);

    const ledger = await db.get(
        `SELECT *
         FROM clover_ph_ledger
         WHERE player_id = 'player@lid'
         ORDER BY id DESC
         LIMIT 1`
    );
    const metadata = JSON.parse(ledger.metadata_json || '{}');

    assert.equal(ledger.kind, 'ajuste_admin');
    assert.equal(Number(ledger.amount), -40);
    assert.equal(ledger.source, 'cloverscript:outro');
    assert.equal(ledger.related_id, 'cloverscript:99:1:player@lid');
    assert.equal(metadata.affects_accumulated, true);
    assert.equal(metadata.correction_scope, 'available_and_accumulated');

    const historyCount = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_ph_ledger
         WHERE player_id = 'player@lid'`
    );
    assert.equal(Number(historyCount.total), 3);
});

test('gasto comum continua reduzindo apenas PH disponível', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addPh(db, 'player@lid', 100, 'evento', 'recompensa', 'owner@lid');
    const result = await removeAvailablePh(
        db,
        'player@lid',
        10,
        'consumo',
        'uso normal',
        'owner@lid'
    );

    assert.equal(result.after.phAccumulated, 115);
    assert.equal(result.after.phAvailable, 105);
});

test('prévia do CloverScript não volta a preservar progresso em PH negativo', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'helpers', 'clover', 'cloverScriptService.js'),
        'utf8'
    );
    assert.match(
        source,
        /const afterAccumulated = beforeAccumulated \+ Number\(action\.amount \|\| 0\);/
    );
});
