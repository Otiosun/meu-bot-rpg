'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureSquadSeasonStarSchema } = require('../helpers/clover/squadSeasonStarService');
const {
    applyQuickEvaluationStarBackfill,
    planQuickEvaluationStarBackfill,
} = require('../helpers/clover/quickEvaluationStarBackfillService');

const PLAYER_ID = 'player-1';

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureSquadSeasonStarSchema(db);
    await db.exec(`
        CREATE TABLE clover_quick_evaluations (
            id INTEGER PRIMARY KEY,
            player_id TEXT DEFAULT NULL,
            stars_amount INTEGER NOT NULL DEFAULT 0,
            scene_sent_at TEXT DEFAULT NULL
        )
    `);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, current_stars, historical_stars, black_stars)
         VALUES ('veu_negro', 'Veu Negro', 5, 5, 0)`
    );
    return db;
}

async function seedLegacyEvaluation(db, {
    evaluationId = 1,
    stars = 5,
    sceneSentAt = '2026-08-01T00:00:00Z',
    playerId = PLAYER_ID,
    ledgerPlayerId = PLAYER_ID,
} = {}) {
    await db.run(
        `INSERT INTO clover_quick_evaluations
         (id, player_id, stars_amount, scene_sent_at)
         VALUES (?, ?, ?, ?)`,
        [evaluationId, playerId, stars, sceneSentAt]
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, evaluation_id, amount, kind, source, reason, created_by, metadata_json)
         VALUES ('veu_negro', ?, ?, ?, 'ganho', 'ficha_avaliacao', 'Avaliacao antiga', 'system', '{}')`,
        [ledgerPlayerId, evaluationId, stars]
    );
}

test('backfill cria somente season total + transacao nativa e preserva saldo/lifetime/ledger legado', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedLegacyEvaluation(db);

    const beforeSquad = await db.get(
        `SELECT current_stars, historical_stars FROM clover_squads WHERE squad_key = 'veu_negro'`
    );
    const beforeLegacy = await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_ledger');

    const preview = await planQuickEvaluationStarBackfill(db);
    assert.equal(preview.ok, true);
    assert.equal(preview.candidateCount, 1);
    assert.equal(preview.invalidCount, 0);
    assert.equal(preview.candidates[0].evaluationId, 1);
    assert.equal(preview.candidates[0].seasonId, 'season-2026');

    const result = await applyQuickEvaluationStarBackfill(db, { apply: true });
    assert.equal(result.applied, true);
    assert.equal(result.appliedCount, 1);

    const afterSquad = await db.get(
        `SELECT current_stars, historical_stars FROM clover_squads WHERE squad_key = 'veu_negro'`
    );
    assert.deepEqual(afterSquad, beforeSquad, 'backfill nao pode conceder saldo/lifetime novamente');

    const season = await db.get(
        `SELECT season_stars FROM clover_squad_season_stars
         WHERE squad_key = 'veu_negro' AND season_id = 'season-2026'`
    );
    assert.equal(season.season_stars, 5);

    const native = await db.get(
        `SELECT * FROM clover_squad_star_transactions
         WHERE transaction_key = 'quick-evaluation:squad-stars:1'`
    );
    assert.equal(native.amount, 5);
    assert.equal(native.kind, 'grant');
    assert.equal(native.source, 'ficha_avaliacao');
    assert.equal(native.season_id, 'season-2026');
    assert.equal(JSON.parse(native.metadata_json).historical_backfill, true);

    const afterLegacy = await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_ledger');
    assert.equal(afterLegacy.total, beforeLegacy.total, 'backfill nao pode duplicar ledger legado');
});

test('retry do backfill e idempotente e nao soma season_stars novamente', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedLegacyEvaluation(db);

    await applyQuickEvaluationStarBackfill(db, { apply: true });
    const second = await applyQuickEvaluationStarBackfill(db, { apply: true });
    assert.equal(second.appliedCount, 0);
    assert.equal(second.alreadyNative, 1);

    const season = await db.get(
        `SELECT season_stars FROM clover_squad_season_stars
         WHERE squad_key = 'veu_negro' AND season_id = 'season-2026'`
    );
    assert.equal(season.season_stars, 5);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_transactions')).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_ledger')).total, 1);
});

test('Quick Evaluation com Stars sem ledger legado bloqueia backfill inteiro', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_quick_evaluations (id, player_id, stars_amount, scene_sent_at)
         VALUES (8, ?, 3, '2026-08-01T00:00:00Z')`,
        [PLAYER_ID]
    );

    const preview = await planQuickEvaluationStarBackfill(db);
    assert.equal(preview.ok, false);
    assert.equal(preview.invalidCount, 1);
    assert.equal(preview.invalid[0].code, 'legacy_ledger_missing');

    await assert.rejects(
        () => applyQuickEvaluationStarBackfill(db, { apply: true }),
        (error) => error?.code === 'quick_evaluation_star_backfill_unsafe'
    );
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_transactions')).total, 0);
});

test('identidade ou valor divergente bloqueia sem mutacao', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedLegacyEvaluation(db, { evaluationId: 9, stars: 5, ledgerPlayerId: 'outro-player' });

    const preview = await planQuickEvaluationStarBackfill(db);
    assert.equal(preview.invalid.some((item) => item.code === 'player_identity_mismatch'), true);
    await assert.rejects(
        () => applyQuickEvaluationStarBackfill(db, { apply: true }),
        (error) => error?.code === 'quick_evaluation_star_backfill_unsafe'
    );

    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_transactions')).total, 0);
    assert.equal((await db.get(
        `SELECT COALESCE(SUM(season_stars), 0) AS total FROM clover_squad_season_stars WHERE squad_key = 'veu_negro'`
    )).total, 0);
});

test('scene_sent_at ausente bloqueia backfill', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedLegacyEvaluation(db, { evaluationId: 10, sceneSentAt: null });

    const preview = await planQuickEvaluationStarBackfill(db);
    assert.equal(preview.invalid.some((item) => item.code === 'missing_scene_sent_at'), true);
    await assert.rejects(
        () => applyQuickEvaluationStarBackfill(db, { apply: true }),
        (error) => error?.code === 'quick_evaluation_star_backfill_unsafe'
    );
});

test('season_stars sem lastro nas transacoes nativas bloqueia backfill para evitar overcount', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedLegacyEvaluation(db, { evaluationId: 11 });
    await db.run(
        `INSERT INTO clover_squad_season_stars (squad_key, season_id, season_stars)
         VALUES ('veu_negro', 'season-2026', 2)`
    );

    const preview = await planQuickEvaluationStarBackfill(db);
    assert.equal(preview.invalid.some((item) => item.code === 'season_total_unreconciled'), true);
    await assert.rejects(
        () => applyQuickEvaluationStarBackfill(db, { apply: true }),
        (error) => error?.code === 'quick_evaluation_star_backfill_unsafe'
    );

    const season = await db.get(
        `SELECT season_stars FROM clover_squad_season_stars
         WHERE squad_key = 'veu_negro' AND season_id = 'season-2026'`
    );
    assert.equal(season.season_stars, 2);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_squad_star_transactions')).total, 0);
});
