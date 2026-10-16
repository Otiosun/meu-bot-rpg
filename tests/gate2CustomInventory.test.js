'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { criarBanco } = require('../database');
const { ensureInventoryV1 } = require('../helpers/clover/inventoryService');
const {
    getQuickEvaluationIntegritySnapshot,
    voidQuickEvaluation,
} = require('../helpers/clover/quickEvaluationIntegrityService');

async function makeDb() {
    return criarBanco({
        filename: path.join(
            os.tmpdir(),
            `clover-gate2-custom-${process.pid}-${crypto.randomUUID()}.sqlite`
        ),
    });
}

test('item narrativo sem template entra no histórico canônico e é estornado integralmente', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const playerId = '5511888888888@s.whatsapp.net';

    await db.run(
        `INSERT INTO jogadores (id, nome, personagem_nome, dinheiro, estrelas, jogo_status)
         VALUES (?, 'Conta Custom', 'Noelle', 0, 0, 'liberado')`,
        [playerId]
    );
    await ensureInventoryV1(db);

    const evaluation = await db.run(
        `INSERT INTO clover_quick_evaluations
         (message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          ph_amount, yulls_amount, stars_amount, inventory_text, scene_sent_at,
          evaluated_at, week_key, bypass_weekly_limit, rewards_json, metadata_json)
         VALUES ('gate2-custom-eval', 'on@g.us', ?, 'admin@s.whatsapp.net',
                 'outro', 'Outro', 0, 0, 0, '2x Relíquia Narrativa',
                 '2026-10-13 13:00:00', '2026-10-13 13:01:00', '2026-10-12', 0, '{}', '{}')`,
        [playerId]
    );
    const evaluationId = Number(evaluation.lastID);

    const inserted = await db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, description, quantity, kind, source, related_id,
          created_by, created_at, metadata_json)
         VALUES (?, 'Relíquia Narrativa', 'Item criado pela ficha de avaliação', 2,
                 'narrativo', 'ficha_avaliacao', ?, 'admin@s.whatsapp.net',
                 CURRENT_TIMESTAMP, '{}')`,
        [playerId, `quick_eval:${evaluationId}`]
    );
    const itemId = Number(inserted.lastID);

    const history = await db.get(
        `SELECT * FROM clover_inventory_item_history
         WHERE item_id = ? AND related_id = ? AND quantity_delta = 2
         ORDER BY id DESC LIMIT 1`,
        [itemId, `quick_eval:${evaluationId}`]
    );
    assert.ok(history, 'o bridge da migration precisa criar histórico para item narrativo custom');
    assert.equal(history.action, 'avaliacao_custom_adicionado');

    const snapshot = await getQuickEvaluationIntegritySnapshot(db, evaluationId);
    const inventoryEffects = snapshot.effects.filter((effect) => effect.effect_type === 'inventory_history');
    assert.equal(inventoryEffects.length, 1);
    assert.equal(Number(inventoryEffects[0].amount), 2);

    const result = await voidQuickEvaluation(db, evaluationId, {
        actorId: 'owner@s.whatsapp.net',
        reason: 'avaliação custom aplicada ao alvo errado',
    });
    assert.equal(result.ok, true, JSON.stringify(result.blockers || []));

    const itemAfter = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [itemId]);
    assert.equal(itemAfter, undefined);
    const evaluationAfter = await db.get('SELECT status FROM clover_quick_evaluations WHERE id = ?', [evaluationId]);
    assert.equal(evaluationAfter.status, 'voided');
    const effectAfter = await db.get(
        `SELECT status FROM clover_quick_evaluation_effects
         WHERE evaluation_id = ? AND effect_type = 'inventory_history'`,
        [evaluationId]
    );
    assert.equal(effectAfter.status, 'reversed');
});
