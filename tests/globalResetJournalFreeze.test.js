'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const {
    GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER,
    inspectGlobalResetJournalFreezeSchemaState,
} = require('../helpers/clover/globalResetJournalFreezeMigration');
const {
    abortGlobalPlayerResetPlan,
    planGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

function makeTempDatabase(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const filename = path.join(dir, 'database.sqlite');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return filename;
}

function triggerRejectedWith(code) {
    return (error) => String(error?.message || error).includes(code);
}

async function seedPlayer(db, playerId = 'freeze-guard@lid') {
    const columns = new Set((await db.all('PRAGMA table_info(jogadores)')).map((row) => row.name));
    const values = {
        id: playerId,
        nome: 'Freeze Guard',
        nome_real: 'Freeze Guard',
        personagem_nome: 'Personagem Freeze Guard',
        personagem_idade: 20,
        ficha_status: 'aprovada',
        historia_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        jogo_status: 'liberado',
        dinheiro: 100,
        is_shadow: 0,
    };
    const entries = Object.entries(values).filter(([column]) => columns.has(column));
    await db.run(
        `INSERT INTO jogadores (${entries.map(([column]) => column).join(',')}) VALUES (${entries.map(() => '?').join(',')})`,
        entries.map(([, value]) => value)
    );
    return playerId;
}

test('0032 instala também o guard explícito de DELETE do lock ativo', async (t) => {
    const filename = makeTempDatabase(t, 'clover-reset-freeze-lock-schema-');
    const db = await database.criarBanco({ filename });
    t.after(() => db.close());

    const state = await inspectGlobalResetJournalFreezeSchemaState(db);
    assert.equal(state.kind, 'exact');
    const lockGuard = state.objects.find((entry) => entry.name === GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER.name);
    assert.equal(lockGuard?.exists, true);
    assert.equal(lockGuard?.exact, true);
});

test('0032 bloqueia delete manual do lock ativo, mas abort canônico libera exatamente o lock', async (t) => {
    const filename = makeTempDatabase(t, 'clover-reset-freeze-lock-behavior-');
    const db = await database.criarBanco({ filename });
    t.after(() => db.close());
    const playerId = await seedPlayer(db);

    const plan = await planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason: 'Plano sintético para provar proteção do lock ativo',
        playerIds: [playerId],
        selectionSource: 'fixture explícita migration 0032 lock guard',
        operationId: 'GR-FREEZE-LOCK-GUARD',
    });

    await assert.rejects(
        db.run(
            'DELETE FROM clover_global_player_reset_lock WHERE lock_key=? AND operation_id=?',
            ['global_character_reset', plan.operationId]
        ),
        triggerRejectedWith('global_reset_lock_delete_forbidden')
    );
    assert.equal(
        (await db.get(
            'SELECT COUNT(*) AS total FROM clover_global_player_reset_lock WHERE operation_id=?',
            [plan.operationId]
        )).total,
        1
    );

    const aborted = await abortGlobalPlayerResetPlan(db, {
        operationId: plan.operationId,
        actorId: OWNER,
        reason: 'Abort sintético canônico para provar liberação segura',
    });
    assert.equal(aborted.ok, true);
    assert.equal(aborted.status, 'aborted');
    assert.equal(
        (await db.get(
            'SELECT COUNT(*) AS total FROM clover_global_player_reset_lock WHERE operation_id=?',
            [plan.operationId]
        )).total,
        0
    );
});

test('0032 não reabre população depois do abort, mesmo sem lock', async (t) => {
    const filename = makeTempDatabase(t, 'clover-reset-freeze-aborted-population-');
    const db = await database.criarBanco({ filename });
    t.after(() => db.close());
    const playerId = await seedPlayer(db, 'freeze-aborted@lid');

    const plan = await planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason: 'Plano sintético para provar população selada após abort',
        playerIds: [playerId],
        selectionSource: 'fixture explícita migration 0032 aborted population',
        operationId: 'GR-FREEZE-ABORTED-POP',
    });
    await abortGlobalPlayerResetPlan(db, {
        operationId: plan.operationId,
        actorId: OWNER,
        reason: 'Abort sintético para selar definitivamente a população',
    });

    await assert.rejects(
        db.run(
            `INSERT INTO clover_global_player_reset_items
             (operation_id,player_id,ordinal,status,reset_operation_code,planned_snapshot_sha256,preview_json)
             VALUES (?,?,2,'pending',?,'deadbeef','{}')`,
            [plan.operationId, 'late-after-abort@lid', 'RS-G-LATE-AFTER-ABORT']
        ),
        triggerRejectedWith('global_reset_population_sealed')
    );

    assert.equal(
        (await db.get(
            'SELECT COUNT(*) AS total FROM clover_global_player_reset_items WHERE operation_id=?',
            [plan.operationId]
        )).total,
        1
    );
});
