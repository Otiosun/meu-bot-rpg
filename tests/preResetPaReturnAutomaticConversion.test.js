'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { ensurePhState, getPhLedgerAuthoritySnapshot } = require('../helpers/clover/phService');
const { readAvailablePa } = require('../helpers/clover/paShopService');
const { getReturnPointsBalance } = require('../helpers/clover/returnPointsService');
const {
    PA_RETURN_ITEM_KEY,
    PA_RETURN_RESET_POLICY_VERSION,
    convertPaToReturnForReset,
} = require('../helpers/clover/paReturnResetConversionService');
const {
    convertPhToReturnForReset,
} = require('../helpers/clover/phReturnResetConversionService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-pa-return-'));
    const db = await database.criarBanco({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function player(db, id, characterName) {
    await db.run(
        `INSERT INTO jogadores
         (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
         VALUES (?,?,'aprovada','liberado',?,?,'approved')`,
        [id, `Player ${id}`, characterName, `Aparencia ${characterName}`]
    );
}

async function addPa(db, evaluatorId, points, paidPoints, status, weekKey) {
    await db.run(
        `INSERT INTO clover_admin_service_entries
         (evaluator_id, target_player_id, modality_key, modality_label, weight,
          points, paid_points, status, service_week_key, scene_week_key, created_by)
         VALUES (?, ?, 'fixture', 'Fixture PA', 1, ?, ?, ?, ?, ?, ?)`,
        [evaluatorId, evaluatorId, points, paidPoints, status, weekKey, weekKey, 'admin-pa-return-test']
    );
}

test('fresh DB migra a loja e converte PH + PA disponivel 1:1 em PR sem duplicar', async (t) => {
    const db = await fixture(t);
    await player(db, 'reset-pa', 'Reset PA');

    await ensurePhState(db, 'reset-pa');
    const phBefore = await getPhLedgerAuthoritySnapshot(db, 'reset-pa');
    assert.equal(phBefore.available, 15, 'PH inicial canônico');

    await addPa(db, 'reset-pa', 9, 0, 'pending', '2026-08-17');
    await addPa(db, 'reset-pa', 4, 1, 'partial', '2026-08-24');
    assert.equal(await readAvailablePa(db, 'reset-pa'), 12);
    assert.equal(await getReturnPointsBalance(db, 'reset-pa'), 0);

    const conversion = await convertPhToReturnForReset(
        db,
        'reset-pa',
        'mythic_launch_v1',
        'admin-pa-return-test'
    );

    assert.equal(conversion.calculatedReturnPoints, 15);
    assert.equal(conversion.paConversion.calculatedReturnPoints, 12);
    assert.equal(conversion.paConversion.duplicate, false);
    assert.equal(await getReturnPointsBalance(db, 'reset-pa'), 27);
    assert.equal(await readAvailablePa(db, 'reset-pa'), 0, 'PA convertido foi explicitamente consumido');

    const entries = await db.all(
        `SELECT points,paid_points,status
         FROM clover_admin_service_entries
         WHERE evaluator_id='reset-pa'
         ORDER BY id`
    );
    assert.deepEqual(entries.map((row) => [row.points, row.paid_points, row.status]), [
        [9, 9, 'paid'],
        [4, 4, 'paid'],
    ]);

    const audit = await db.get(
        `SELECT * FROM clover_pa_shop_purchases
         WHERE evaluator_id='reset-pa'
           AND item_key=?
           AND source='prereset_pa_return_conversion'`,
        [PA_RETURN_ITEM_KEY]
    );
    assert.ok(audit);
    assert.equal(audit.quantity, 12);
    assert.equal(audit.pa_cost, 12);
    assert.match(audit.metadata_json, new RegExp(PA_RETURN_RESET_POLICY_VERSION));

    const replay = await convertPhToReturnForReset(
        db,
        'reset-pa',
        'mythic_launch_v1',
        'admin-pa-return-test'
    );
    assert.equal(replay.duplicate, true, 'PH claim foi reaproveitado');
    assert.equal(replay.paConversion.duplicate, true, 'PA claim foi reaproveitado');
    assert.equal(replay.calculatedReturnPoints, 15);
    assert.equal(replay.paConversion.calculatedReturnPoints, 12);
    assert.equal(await getReturnPointsBalance(db, 'reset-pa'), 27, 'retry nao duplica PR');

    const directPaReplay = await convertPaToReturnForReset(
        db,
        'reset-pa',
        'mythic_launch_v1',
        'admin-pa-return-test'
    );
    assert.equal(directPaReplay.duplicate, true);
    assert.equal(directPaReplay.calculatedReturnPoints, 12);
    assert.equal(await getReturnPointsBalance(db, 'reset-pa'), 27);
});