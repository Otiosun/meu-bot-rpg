'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationPlan');
const {
    GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER,
    inspectGlobalResetJournalFreezeDataState,
    inspectGlobalResetJournalFreezeSchemaState,
} = require('../helpers/clover/globalResetJournalFreezeMigration');
const {
    abortGlobalPlayerResetPlan,
    planGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;
const MIGRATIONS_THROUGH_0031 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 31));

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
    assert.equal((await inspectGlobalResetJournalFreezeDataState(db)).kind, 'empty');
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

test('0032 recusa upgrade se o head 0031 já contiver qualquer journal global', async (t) => {
    const filename = makeTempDatabase(t, 'clover-reset-freeze-preexisting-data-');
    let head31Db;
    let verifyDb;
    try {
        head31Db = await database.criarBanco({ filename, migrations: MIGRATIONS_THROUGH_0031 });
        const playerId = await seedPlayer(head31Db, 'freeze-preexisting@lid');
        await planGlobalPlayerReset(head31Db, {
            actorId: OWNER,
            reason: 'Plano head 0031 para provar fail closed da migration 0032',
            playerIds: [playerId],
            selectionSource: 'fixture explícita preexisting journal 0031',
            operationId: 'GR-FREEZE-PREEXISTING',
        });
        assert.equal((await inspectGlobalResetJournalFreezeDataState(head31Db)).kind, 'nonempty');
        await head31Db.close();
        head31Db = null;

        await assert.rejects(
            () => database.criarBanco({ filename }),
            (error) => error?.code === 'global_reset_journal_freeze_data_reconciliation_required'
                && error?.state?.counts?.operationCount === 1
                && error?.state?.counts?.itemCount === 1
                && error?.state?.counts?.lockCount === 1
        );

        verifyDb = await openCloverDatabase({ filename });
        const userVersionRow = await verifyDb.get('PRAGMA user_version');
        assert.equal(Number(Object.values(userVersionRow || {})[0] || 0), 31);
        assert.equal((await verifyDb.get('SELECT COUNT(*) AS total FROM clover_schema_migrations')).total, 31);
        assert.equal(
            (await verifyDb.get(
                "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type='trigger' AND name LIKE 'trg_global_player_reset_%'"
            )).total,
            0
        );
        assert.deepEqual((await inspectGlobalResetJournalFreezeDataState(verifyDb)).counts, {
            operationCount: 1,
            itemCount: 1,
            lockCount: 1,
        });
    } finally {
        if (head31Db) await head31Db.close().catch(() => {});
        if (verifyDb) await verifyDb.close().catch(() => {});
    }
});
